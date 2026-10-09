/**
 * GitService parity: the same fixture through local FileService and through
 * RemoteFileService backed by the real remote-fs-agent.js over pipes
 * (docs/design-git-changes.md, "Remote agent op").
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const RemoteFileService = require('../../remote-file-service');
const FileService = require('../../file-service');
const { GitService, GitError } = require('../../git-service');
const { git, write, makeTmp, initRepo, commitAll } = require('../helpers/git-fixture');

const AGENT_PATH = path.join(__dirname, '..', '..', 'remote-fs-agent.js');

// ---------------------------------------------------------------------------
// Parity: one fixture, two backends, identical answers.

function spawnAgentHost() {
  const proc = spawn(process.execPath, [AGENT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (!p || msg.ok === undefined) continue;
      pending.delete(msg.id);
      // Same reply -> promise mapping as ssh-host-pool.js HostAgent.
      if (msg.ok) p.resolve(msg);
      else p.reject(Object.assign(new Error(msg.error || 'agent error'), { code: msg.code }));
    }
  });
  proc.stderr.on('data', () => {});
  return {
    request(op, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
      });
    },
    stop() {
      try { proc.stdin.end(); } catch { /* closed */ }
      try { proc.kill(); } catch { /* dead */ }
    },
  };
}

describe('GitService parity: FileService vs RemoteFileService (real agent)', () => {
  let tmp, root, host, local, remote;

  beforeAll(() => {
    tmp = makeTmp('eve-git-parity-');
    root = path.join(tmp, 'proj');

    const main = initRepo(path.join(root, 'main'), {
      'mod.txt': 'one\n',
      'del.txt': 'bye\n',
      'old.txt': 'rename me please\n'.repeat(4),
      'bin.dat': Buffer.from([1, 0, 2]),
      'big.txt': 'small\n',
    });
    git(main, ['worktree', 'add', '-q', '../feat', '-b', 'feat']);
    write(main, 'mod.txt', 'two\n');
    fs.rmSync(path.join(main, 'del.txt'));
    git(main, ['mv', 'old.txt', 'new.txt']);
    write(main, 'bin.dat', Buffer.from([1, 0, 2, 3]));
    write(main, 'big.txt', 'z'.repeat(GitService.FILE_MAX_BYTES + 5));
    write(main, 'untracked dir/u.txt', 'u\n');

    const feat = path.join(root, 'feat');
    write(feat, 'mod.txt', 'feat-one\n');
    write(feat, 'feat-only.txt', 'f\n');
    commitAll(feat, 'feat work');
    write(feat, 'feat-only.txt', 'f2\n');

    initRepo(path.join(root, 'lib'), { 'l.txt': 'l\n' });
    write(root, 'loose.txt', 'not in any repo\n');

    // A symlinked "repo" pointing outside the project root.
    const ext = initRepo(path.join(tmp, 'external'), { 's.txt': 's\n' });
    fs.symlinkSync(ext, path.join(root, 'extlink'));

    host = spawnAgentHost();
    local = new FileService();
    remote = new RemoteFileService(host);
  });

  afterAll(() => {
    if (host) host.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('gitRepos is identical', async () => {
    const [l, r] = await Promise.all([local.gitRepos(root), remote.gitRepos(root)]);
    expect(l.map((x) => x.path)).toEqual(['/feat', '/lib', '/main']);
    expect(r).toEqual(l);
  });

  it.each([['uncommitted'], ['base']])('gitStatus (%s) is identical for every repo', async (scope) => {
    const repos = await local.gitRepos(root);
    for (const { path: repoPath } of repos) {
      const [l, r] = await Promise.all([
        local.gitStatus(root, repoPath, scope),
        remote.gitStatus(root, repoPath, scope),
      ]);
      expect(r).toEqual(l);
    }
    const main = await local.gitStatus(root, '/main', 'uncommitted');
    expect(main.files.length).toBeGreaterThanOrEqual(6);
  });

  it.each([['uncommitted'], ['base']])('gitFileVersions (%s) is identical for every changed file', async (scope) => {
    for (const repoPath of ['/main', '/feat']) {
      const st = await local.gitStatus(root, repoPath, scope);
      for (const f of st.files) {
        const [l, r] = await Promise.all([
          local.gitFileVersions(root, repoPath, f.path, scope),
          remote.gitFileVersions(root, repoPath, f.path, scope),
        ]);
        expect({ file: f.path, ...r }).toEqual({ file: f.path, ...l });
      }
    }
  });

  it('covers binary, tooLarge, deleted and renamed shapes', async () => {
    const get = (p) => remote.gitFileVersions(root, '/main', p, 'uncommitted');
    await expect(get('bin.dat')).resolves.toMatchObject({ binary: true, original: null, modified: null, originalSize: 3, modifiedSize: 4 });
    await expect(get('big.txt')).resolves.toMatchObject({ tooLarge: true, modifiedSize: GitService.FILE_MAX_BYTES + 5 });
    await expect(get('del.txt')).resolves.toMatchObject({ original: 'bye\n', modified: null });
    await expect(get('new.txt')).resolves.toMatchObject({ original: 'rename me please\n'.repeat(4) });
  });

  it.each([
    ['a non-toplevel directory', '/main/untracked dir'],
    ['a missing directory', '/nope'],
    ['a plain file', '/loose.txt'],
  ])('both backends reject %s as NOT_A_REPO', async (_label, repoPath) => {
    const [l, r] = await Promise.all([
      local.gitStatus(root, repoPath, 'uncommitted').catch((e) => e),
      remote.gitStatus(root, repoPath, 'uncommitted').catch((e) => e),
    ]);
    expect(l.code).toBe('NOT_A_REPO');
    expect(r.code).toBe(l.code);
  });

  it.each([['/../..'], ['/..'], ['main/../../..']])(
    'both backends reject escaping repoPath %j as NOT_A_REPO', async (repoPath) => {
      const settle = (p) => p.then(() => null, (e) => e);
      const [ls, rs, lv, rv] = await Promise.all([
        settle(local.gitStatus(root, repoPath, 'uncommitted')),
        settle(remote.gitStatus(root, repoPath, 'uncommitted')),
        settle(local.gitFileVersions(root, repoPath, 'mod.txt', 'uncommitted')),
        settle(remote.gitFileVersions(root, repoPath, 'mod.txt', 'uncommitted')),
      ]);
      for (const e of [ls, rs, lv, rv]) {
        expect(e).toBeInstanceOf(GitError);
        expect(e.code).toBe('NOT_A_REPO');
      }
    });

  it.each([['../../outside.txt'], ['../feat/mod.txt'], ['sub/../../x.txt']])(
    'both backends reject file path %j escaping the repo as FAILED', async (filePath) => {
      const settle = (p) => p.then(() => null, (e) => e);
      const [l, r] = await Promise.all([
        settle(local.gitFileVersions(root, '/main', filePath, 'uncommitted')),
        settle(remote.gitFileVersions(root, '/main', filePath, 'uncommitted')),
      ]);
      expect(l).toBeInstanceOf(GitError);
      expect(l.code).toBe('FAILED');
      expect(r).toBeInstanceOf(GitError);
      expect(r.code).toBe('FAILED');
    });

  it('both backends reject a repo symlinked outside the root with the same code (NOT_A_REPO)', async () => {
    // The local runner maps any path-validation failure to NOT_A_REPO; the
    // agent reports the same condition as TRAVERSAL, which should map the
    // same way so the panel shows one error for one situation.
    const [l, r] = await Promise.all([
      local.gitStatus(root, '/extlink', 'uncommitted').catch((e) => e),
      remote.gitStatus(root, '/extlink', 'uncommitted').catch((e) => e),
    ]);
    expect(l.code).toBe('NOT_A_REPO');
    expect(r.code).toBe('NOT_A_REPO');
  });
});
