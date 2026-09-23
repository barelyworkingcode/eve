/**
 * The Changes panel's WS surface: FileHandlers#gitChanges / #gitFileVersions
 * (file-handlers.js) and their descriptors (ws/git-messages.js). Frame shapes
 * and error codes per docs/design-git-changes.md ("WebSocket frames").
 */
const fs = require('fs');
const path = require('path');
const FileHandlers = require('../../file-handlers');
const RemoteFileService = require('../../remote-file-service');
const gitMessages = require('../../ws/git-messages');
const { GitError } = require('../../git-service');
const { makeTmp, initRepo, write } = require('../helpers/git-fixture');

function makeWs() {
  const ws = { sent: [], send: jest.fn((data) => ws.sent.push(JSON.parse(data))) };
  return ws;
}

const PROJECT_PATH = '/srv/projects/secret-root';

function meta(p) {
  return { path: p, name: p === '/' ? 'root' : p.slice(1), branch: 'main', head: 'abcdef0', detached: false, upstream: null, ahead: 0, behind: 0, defaultBranch: 'main' };
}

// FileHandlers whose fileServiceFor() returns `fakeFs` for project p1.
function handlersWith(fakeFs, project = { id: 'p1', path: PROJECT_PATH }) {
  const h = new FileHandlers({ resolveProject: (id) => (id === 'p1' ? project : null) });
  h.fileServiceFor = jest.fn(() => fakeFs);
  return h;
}

describe('FileHandlers#gitChanges', () => {
  let ws;
  beforeEach(() => { ws = makeWs(); });
  const last = () => ws.sent[ws.sent.length - 1];

  describe('input validation', () => {
    it.each([['bogus'], [''], [42], [{}]])('scope %j -> git_error INVALID, no git run', async (scope) => {
      const fakeFs = { gitRepos: jest.fn() };
      await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope });
      expect(last()).toMatchObject({ type: 'git_error', projectId: 'p1', code: 'INVALID' });
      expect(fakeFs.gitRepos).not.toHaveBeenCalled();
    });

    it.each([[''], [42], [null], [['/']]])('repo %j -> git_error INVALID echoing repo', async (repo) => {
      const fakeFs = { gitRepos: jest.fn() };
      await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted', repo });
      expect(last()).toMatchObject({ type: 'git_error', projectId: 'p1', repo, code: 'INVALID' });
      expect(fakeFs.gitRepos).not.toHaveBeenCalled();
    });

    it('unknown project -> git_error NOT_FOUND', async () => {
      await handlersWith({}).gitChanges(ws, { projectId: 'nope', scope: 'uncommitted' });
      expect(last()).toMatchObject({ type: 'git_error', projectId: 'nope', code: 'NOT_FOUND' });
    });

    it('a missing scope defaults to uncommitted', async () => {
      const fakeFs = {
        gitRepos: jest.fn().mockResolvedValue([meta('/')]),
        gitStatus: jest.fn().mockResolvedValue({ files: [], base: null, truncated: false }),
      };
      await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1' });
      expect(fakeFs.gitStatus).toHaveBeenCalledWith(PROJECT_PATH, '/', 'uncommitted');
      expect(last()).toMatchObject({ type: 'git_changes', scope: 'uncommitted' });
    });
  });

  // Contract "Streaming": a full request answers at once with every repo
  // pending, then one single-repo frame per repo in completion order.
  describe('streamed full reply', () => {
    function deferred() {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }
    const flush = () => new Promise((r) => setImmediate(r));

    // gitStatus parks on a per-repo deferred the test settles by hand.
    function streamingFs(paths) {
      const pending = Object.fromEntries(paths.map((p) => [p, deferred()]));
      return {
        pending,
        fakeFs: {
          gitRepos: jest.fn().mockResolvedValue(paths.map(meta)),
          gitStatus: jest.fn((root, repo) => pending[repo].promise),
        },
      };
    }

    it('sends a full-list frame with every repo pending before any status resolves', async () => {
      const { fakeFs, pending } = streamingFs(['/a', '/b', '/c']);
      const done = handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
      await flush();

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toEqual({
        type: 'git_changes', projectId: 'p1', scope: 'uncommitted',
        repos: ['/a', '/b', '/c'].map((p) => ({ ...meta(p), pending: true, files: [], base: null, truncated: false })),
      });
      // No `repo`: the client replaces its list with this one.
      expect(ws.sent[0]).not.toHaveProperty('repo');

      for (const p of ['/a', '/b', '/c']) pending[p].resolve({ files: [], base: null, truncated: false, upstream: null, ahead: 0, behind: 0 });
      await done;
    });

    it('then one single-repo frame per repo, in completion order, with pending: false', async () => {
      const { fakeFs, pending } = streamingFs(['/a', '/b', '/c']);
      const done = handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'base' });
      await flush();

      pending['/c'].resolve({
        repo: '/c', scope: 'base', base: '1234567', truncated: true,
        upstream: 'origin/c', ahead: 2, behind: 1,
        files: [{ path: 'c.txt', status: 'M', staged: false }],
      });
      await flush();
      expect(ws.sent).toHaveLength(2);
      expect(ws.sent[1]).toEqual({
        type: 'git_changes', projectId: 'p1', scope: 'base', repo: '/c',
        repos: [{
          ...meta('/c'), upstream: 'origin/c', ahead: 2, behind: 1, pending: false,
          files: [{ path: 'c.txt', status: 'M', staged: false }], base: '1234567', truncated: true,
        }],
      });

      pending['/a'].resolve({ repo: '/a', scope: 'base', base: null, truncated: false, upstream: null, ahead: 0, behind: 0, files: [] });
      await flush();
      pending['/b'].resolve({
        repo: '/b', scope: 'base', base: '1234567', truncated: false, upstream: null, ahead: 0, behind: 0,
        files: [{ path: 'b.txt', status: 'A', staged: false }],
      });
      await done;

      expect(ws.sent.map((f) => f.repo)).toEqual([undefined, '/c', '/a', '/b']);
      for (const f of ws.sent.slice(1)) {
        expect(f.repos).toHaveLength(1);
        expect(f.repos[0].path).toBe(f.repo);
        expect(f.repos[0].pending).toBe(false);
      }
      expect(ws.sent[3].repos[0]).toMatchObject({ files: [{ path: 'b.txt', status: 'A', staged: false }], base: '1234567' });
    });

    it("a per-repo failure arrives as that repo's own frame with error, without the absolute server path", async () => {
      const { fakeFs, pending } = streamingFs(['/a', '/b', '/c']);
      const done = handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
      await flush();

      pending['/b'].reject(new GitError('TIMEOUT', `git timed out in ${PROJECT_PATH}/b`));
      await flush();
      pending['/c'].reject(new Error(`fatal: bad object in ${PROJECT_PATH}/c/.git`));
      await flush();
      pending['/a'].resolve({ files: [{ path: 'ok.txt', status: '?', staged: false }], base: null, truncated: false, upstream: null, ahead: 0, behind: 0 });
      await done;

      expect(ws.sent.map((f) => f.repo)).toEqual([undefined, '/b', '/c', '/a']);
      const b = ws.sent[1];
      expect(b).toMatchObject({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repo: '/b' });
      expect(b.repos).toHaveLength(1);
      expect(b.repos[0]).toMatchObject({
        path: '/b', files: [], base: null, truncated: false,
        error: { code: 'TIMEOUT', message: 'git timed out in /b' },
      });
      expect(b.repos[0].pending).not.toBe(true);
      expect(ws.sent[2].repos[0].error).toEqual({ code: 'FAILED', message: 'fatal: bad object in /c/.git' });
      expect(ws.sent[3].repos[0]).toMatchObject({ path: '/a', pending: false, files: [{ path: 'ok.txt' }] });
      expect(ws.sent[3].repos[0].error).toBeUndefined();
      expect(ws.sent.some((f) => f.type === 'git_error')).toBe(false);
      expect(JSON.stringify(ws.sent)).not.toContain(PROJECT_PATH);
    });

    it('does not wait on every repo: 70 repos, the first frame goes out while all are still running', async () => {
      const paths = Array.from({ length: 70 }, (_, i) => `/wt-${String(i + 1).padStart(2, '0')}`);
      const { fakeFs, pending } = streamingFs(paths);
      const done = handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
      await flush();
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0].repos).toHaveLength(70);
      expect(ws.sent[0].repos.every((r) => r.pending === true)).toBe(true);

      for (const p of paths) pending[p].resolve({ files: [], base: null, truncated: false, upstream: null, ahead: 0, behind: 0 });
      await done;
      expect(ws.sent).toHaveLength(71);
      expect(new Set(ws.sent.slice(1).map((f) => f.repo))).toEqual(new Set(paths));
    });

    it('a project with no repos sends just the empty full frame', async () => {
      const fakeFs = { gitRepos: jest.fn().mockResolvedValue([]), gitStatus: jest.fn() };
      await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
      expect(ws.sent).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repos: [] }]);
    });
  });

  it('a discovery failure becomes one git_error with the GitError code, path stripped', async () => {
    const fakeFs = { gitRepos: jest.fn().mockRejectedValue(new GitError('GIT_MISSING', `no git for ${PROJECT_PATH}`)) };
    await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
    expect(last()).toEqual({ type: 'git_error', projectId: 'p1', code: 'GIT_MISSING', error: 'no git for ' });
  });

  it('with repo: answers for just that repo', async () => {
    const fakeFs = {
      gitRepos: jest.fn().mockResolvedValue([meta('/a'), meta('/b')]),
      gitStatus: jest.fn().mockResolvedValue({ files: [], base: null, truncated: false }),
    };
    await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted', repo: '/b' });
    // Unchanged by streaming: one frame, no pending phase.
    expect(ws.sent).toHaveLength(1);
    expect(fakeFs.gitStatus).toHaveBeenCalledTimes(1);
    expect(fakeFs.gitStatus).toHaveBeenCalledWith(PROJECT_PATH, '/b', 'uncommitted');
    expect(last().repos.map((r) => r.path)).toEqual(['/b']);
    // The echo tells the client to merge this group, not replace the list.
    expect(last()).toMatchObject({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repo: '/b' });
  });

  it('with repo: upstream/ahead/behind come from status(), not the (null) repos() meta', async () => {
    const fakeFs = {
      gitRepos: jest.fn().mockResolvedValue([meta('/a')]),
      gitStatus: jest.fn().mockResolvedValue({
        files: [], base: null, truncated: false, upstream: 'origin/main', ahead: 3, behind: 1,
      }),
    };
    await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted', repo: '/a' });
    expect(ws.sent).toHaveLength(1);
    expect(last().repos[0]).toMatchObject({ path: '/a', upstream: 'origin/main', ahead: 3, behind: 1 });
  });

  it('with an unknown repo: git_error NOT_A_REPO echoing repo', async () => {
    const fakeFs = { gitRepos: jest.fn().mockResolvedValue([meta('/a')]), gitStatus: jest.fn() };
    await handlersWith(fakeFs).gitChanges(ws, { projectId: 'p1', scope: 'uncommitted', repo: '/zzz' });
    expect(last()).toMatchObject({ type: 'git_error', projectId: 'p1', repo: '/zzz', code: 'NOT_A_REPO' });
    expect(fakeFs.gitStatus).not.toHaveBeenCalled();
  });

  it('routes a local project to the local FileService', async () => {
    const h = new FileHandlers({ resolveProject: () => ({ id: 'p1', path: PROJECT_PATH }) });
    const spy = jest.spyOn(h.fileService, 'gitRepos').mockResolvedValue([]);
    await h.gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
    expect(spy).toHaveBeenCalledWith(PROJECT_PATH);
    expect(last()).toEqual({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repos: [] });
  });

  it('routes a host project through its RemoteFileService / agent, never the local disk', async () => {
    const agent = {
      calls: [],
      async request(op, params) {
        this.calls.push({ op, params });
        if (op === 'list') return { ok: true, entries: [] };
        if (op === 'git') return { ok: true, code: 128, stdout: '', stderr: 'not a repo' };
        throw new Error(`unexpected ${op}`);
      },
    };
    const hostPool = { get: jest.fn(() => agent) };
    const h = new FileHandlers({ resolveProject: () => ({ id: 'p1', path: '/remote/proj', hostId: 'h1' }), hostPool });
    const localSpy = jest.spyOn(h.fileService, 'gitRepos');
    const remoteSpy = jest.spyOn(RemoteFileService.prototype, 'gitRepos');
    // Assert before mockRestore(): Jest 30's restore also clears mock.calls.
    try {
      await h.gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
      expect(hostPool.get).toHaveBeenCalledWith('h1');
      expect(localSpy).not.toHaveBeenCalled();
      expect(remoteSpy).toHaveBeenCalledWith('/remote/proj');
      expect(agent.calls.some((c) => c.op === 'git' && c.params.root === '/remote/proj')).toBe(true);
      expect(last()).toEqual({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repos: [] });
    } finally {
      remoteSpy.mockRestore();
    }
  });
});

describe('FileHandlers#gitFileVersions', () => {
  let ws;
  beforeEach(() => { ws = makeWs(); });
  const last = () => ws.sent[ws.sent.length - 1];

  it.each([
    ['missing repo', { path: 'a.txt' }],
    ['empty repo', { repo: '', path: 'a.txt' }],
    ['non-string repo', { repo: 7, path: 'a.txt' }],
    ['missing path', { repo: '/' }],
    ['empty path', { repo: '/', path: '' }],
    ['non-string path', { repo: '/', path: ['a.txt'] }],
    ['bad scope', { repo: '/', path: 'a.txt', scope: 'HEAD~3' }],
  ])('%s -> git_error INVALID, no git run', async (_label, fields) => {
    const fakeFs = { gitFileVersions: jest.fn() };
    await handlersWith(fakeFs).gitFileVersions(ws, { projectId: 'p1', scope: 'uncommitted', ...fields });
    expect(last()).toMatchObject({ type: 'git_error', projectId: 'p1', code: 'INVALID' });
    expect(fakeFs.gitFileVersions).not.toHaveBeenCalled();
  });

  it('unknown project -> git_error NOT_FOUND echoing repo/path', async () => {
    await handlersWith({}).gitFileVersions(ws, { projectId: 'nope', repo: '/', path: 'a.txt', scope: 'uncommitted' });
    expect(last()).toMatchObject({ type: 'git_error', projectId: 'nope', repo: '/', path: 'a.txt', code: 'NOT_FOUND' });
  });

  it('passes only projectPath/repo/path/scope — client-supplied extras (a ref) are ignored', async () => {
    const fakeFs = {
      gitFileVersions: jest.fn().mockResolvedValue({ original: 'a', modified: 'b', binary: 0, tooLarge: undefined, originalSize: 1, modifiedSize: 1 }),
    };
    await handlersWith(fakeFs).gitFileVersions(ws, {
      projectId: 'p1', repo: '/', path: 'a.txt', scope: 'base', ref: 'refs/heads/secret', base: 'deadbeef',
    });
    expect(fakeFs.gitFileVersions).toHaveBeenCalledWith(PROJECT_PATH, '/', 'a.txt', 'base');
    expect(fakeFs.gitFileVersions.mock.calls[0]).toHaveLength(4);
    expect(last()).toEqual({
      type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'a.txt', scope: 'base',
      original: 'a', modified: 'b', binary: false, tooLarge: false, originalSize: 1, modifiedSize: 1,
    });
  });

  it('a failure becomes git_error with the GitError code and no absolute server path', async () => {
    const fakeFs = {
      gitFileVersions: jest.fn().mockRejectedValue(new GitError('NOT_A_REPO', `Not a git repository: ${PROJECT_PATH}/x`)),
    };
    await handlersWith(fakeFs).gitFileVersions(ws, { projectId: 'p1', repo: '/x', path: 'a.txt', scope: 'uncommitted' });
    expect(last()).toEqual({
      type: 'git_error', projectId: 'p1', repo: '/x', path: 'a.txt', code: 'NOT_A_REPO', error: 'Not a git repository: /x',
    });
  });
});

describe('FileHandlers git frames against a real repo', () => {
  let tmp, repo, handlers, ws;
  const last = () => ws.sent[ws.sent.length - 1];

  beforeAll(() => {
    tmp = makeTmp('eve-fh-git-');
    repo = initRepo(path.join(tmp, 'proj'), { 'a.txt': 'one\n' });
    write(repo, 'a.txt', 'two\n');
    write(repo, 'new.txt', 'n\n');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    handlers = new FileHandlers({ resolveProject: (id) => (id === 'p1' ? { id: 'p1', path: repo } : null) });
    ws = makeWs();
  });

  it('git_changes lists the root repo pending, then streams it with its files', async () => {
    await handlers.gitChanges(ws, { projectId: 'p1', scope: 'uncommitted' });
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toMatchObject({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' });
    expect(ws.sent[0]).not.toHaveProperty('repo');
    expect(ws.sent[0].repos).toEqual([expect.objectContaining({ path: '/', pending: true, files: [] })]);
    const frame = last();
    expect(frame).toMatchObject({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repo: '/' });
    expect(frame.repos).toHaveLength(1);
    expect(frame.repos[0]).toMatchObject({
      path: '/', name: 'proj', branch: 'main', base: null, truncated: false, pending: false,
      upstream: null, ahead: 0, behind: 0,
    });
    expect(frame.repos[0].files).toEqual(expect.arrayContaining([
      { path: 'a.txt', status: 'M', staged: false },
      { path: 'new.txt', status: '?', staged: false },
    ]));
  });

  it('git_file_versions returns both sides', async () => {
    await handlers.gitFileVersions(ws, { projectId: 'p1', repo: '/', path: 'a.txt', scope: 'uncommitted' });
    expect(last()).toEqual({
      type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'a.txt', scope: 'uncommitted',
      original: 'one\n', modified: 'two\n', binary: false, tooLarge: false, originalSize: 4, modifiedSize: 4,
    });
  });

  it('a traversal file path fails with FAILED and never names the server path', async () => {
    await handlers.gitFileVersions(ws, { projectId: 'p1', repo: '/', path: '../../etc/passwd', scope: 'uncommitted' });
    expect(last()).toMatchObject({ type: 'git_error', code: 'FAILED' });
    expect(JSON.stringify(last())).not.toContain(tmp);
  });

  it('a non-repo subdirectory fails NOT_A_REPO without the server path in the text', async () => {
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    await handlers.gitFileVersions(ws, { projectId: 'p1', repo: '/sub', path: 'a.txt', scope: 'uncommitted' });
    expect(last()).toMatchObject({ type: 'git_error', repo: '/sub', code: 'NOT_A_REPO' });
    expect(last().error).not.toContain(repo);
  });
});

describe('ws/git-messages descriptors', () => {
  const byType = Object.fromEntries(gitMessages.map((d) => [d.type, d]));

  function ctx(message) {
    return {
      ws: { send: jest.fn() },
      message,
      fileWatcher: { watchProject: jest.fn() },
      deps: { fileHandlers: { gitChanges: jest.fn(), gitFileVersions: jest.fn() } },
    };
  }

  it('registers exactly git_changes (expensive) and git_file_versions (not)', () => {
    expect(Object.keys(byType).sort()).toEqual(['git_changes', 'git_file_versions']);
    expect(byType.git_changes.expensive).toBe(true);
    expect(byType.git_file_versions.expensive).toBeFalsy();
  });

  it('git_changes starts the project watcher, then delegates with the same ws/message', () => {
    const c = ctx({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' });
    byType.git_changes.handle(c);
    expect(c.fileWatcher.watchProject).toHaveBeenCalledWith('p1');
    expect(c.deps.fileHandlers.gitChanges).toHaveBeenCalledWith(c.ws, c.message);
  });

  it('git_file_versions delegates without touching the watcher', () => {
    const c = ctx({ type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'a.txt' });
    byType.git_file_versions.handle(c);
    expect(c.deps.fileHandlers.gitFileVersions).toHaveBeenCalledWith(c.ws, c.message);
    expect(c.fileWatcher.watchProject).not.toHaveBeenCalled();
  });
});
