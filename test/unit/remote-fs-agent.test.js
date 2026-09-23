/**
 * Spawns the real remote-fs-agent.js as a child process over pipes (no ssh —
 * that's the point: the agent is plain Node, so it's testable in-process
 * exactly as it will run on a host). Covers every op, traversal refusal, a
 * symlink escape, search caps, and a watch event.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGENT_PATH = path.join(__dirname, '..', '..', 'remote-fs-agent.js');

// Mirrors test/integration/fake-relay.js's recordInbound/waitForInbound
// pattern: every parsed line is kept in `log` (so an already-arrived message
// is found immediately, without racing a waiter that was registered too
// late) as well as offered to any pending waiter.
function startAgent({ env } = {}) {
  const proc = spawn(process.execPath, [AGENT_PATH], { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
  let buf = '';
  const log = [];
  const waiters = [];
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      log.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    }
  });
  proc.stderr.on('data', () => {}); // swallow; not part of the protocol

  let nextId = 1;
  return {
    proc,
    log,
    send(op, params = {}) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
      return id;
    },
    waitFor(pred, timeoutMs = 5000) {
      const existing = log.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitFor: timed out')), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    // Waits for the terminal {id, ...} reply (has `ok`), ignoring any
    // intermediate `{id, chunk}` stream frames along the way.
    request(op, params = {}) {
      const id = this.send(op, params);
      return this.waitFor((m) => m.id === id && m.ok !== undefined);
    },
    stop() {
      try { proc.stdin.end(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already dead */ }
    },
  };
}

describe('remote-fs-agent.js (spawned over pipes, no ssh)', () => {
  let tmpDir, root, agent;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-agent-test-'));
    root = fs.realpathSync(tmpDir);
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'needle inside\n');
    agent = startAgent();
  });

  afterEach(() => {
    agent.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers hello with home/os/node', async () => {
    const res = await agent.request('hello', { version: 1 });
    expect(res.ok).toBe(true);
    expect(res.home).toBe(os.homedir());
    expect(res.os).toBe(process.platform);
    expect(typeof res.node).toBe('string');
  });

  it('lists a directory, hiding dotfiles by default', async () => {
    fs.writeFileSync(path.join(root, '.hidden'), 'x');
    const res = await agent.request('list', { root, path: '/' });
    expect(res.ok).toBe(true);
    const names = res.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'sub']);
    const showHidden = await agent.request('list', { root, path: '/', showHidden: true });
    expect(showHidden.entries.map((e) => e.name)).toContain('.hidden');
  });

  it('reads a file', async () => {
    const res = await agent.request('read', { root, path: 'a.txt' });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('hello world\n');
    expect(res.size).toBe(Buffer.byteLength('hello world\n'));
  });

  it('rejects reading a file over maxBytes with TOO_LARGE', async () => {
    const res = await agent.request('read', { root, path: 'a.txt', maxBytes: 3 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TOO_LARGE');
  });

  it('writes a file', async () => {
    const res = await agent.request('write', { root, path: 'new.txt', content: 'hi' });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('hi');
  });

  it('writes base64 (upload) data', async () => {
    const data = Buffer.from('binary-ish').toString('base64');
    const res = await agent.request('writeb64', { root, path: 'up.bin', data });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'up.bin'))).toEqual(Buffer.from('binary-ish'));
  });

  it('writes a pasted image into /tmp, owner-only, and returns its path', async () => {
    const name = `eve-paste-${Date.now()}-${process.pid.toString(16)}.png`;
    const full = path.join('/tmp', name);
    try {
      const data = Buffer.from('png-bytes').toString('base64');
      const res = await agent.request('pastetmp', { name, data });
      expect(res).toMatchObject({ ok: true, path: full });
      expect(fs.readFileSync(full)).toEqual(Buffer.from('png-bytes'));
      expect(fs.statSync(full).mode & 0o777).toBe(0o600);
      // 'wx': a second write to the same name (or a planted symlink) fails.
      const again = await agent.request('pastetmp', { name, data });
      expect(again.ok).toBe(false);
    } finally {
      fs.rmSync(full, { force: true });
    }
  });

  it('refuses a pastetmp name that is not an eve-paste file', async () => {
    for (const name of ['../etc/passwd', 'eve-paste-1-ab.sh', 'sub/eve-paste-1-ab.png', '']) {
      const res = await agent.request('pastetmp', { name, data: '' });
      expect(res.ok).toBe(false);
    }
  });

  it('renames a file', async () => {
    const res = await agent.request('rename', { root, path: 'a.txt', newName: 'renamed.txt' });
    expect(res.ok).toBe(true);
    expect(res.path).toBe('renamed.txt');
    expect(fs.existsSync(path.join(root, 'renamed.txt'))).toBe(true);
  });

  it('moves a file into a subdirectory', async () => {
    const res = await agent.request('move', { root, path: 'a.txt', destDir: 'sub' });
    expect(res.ok).toBe(true);
    expect(res.path).toBe('sub/a.txt');
    expect(fs.existsSync(path.join(root, 'sub', 'a.txt'))).toBe(true);
  });

  it('deletes recursively with no trash', async () => {
    const res = await agent.request('delete', { root, path: 'sub' });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'sub'))).toBe(false);
  });

  it('creates a directory', async () => {
    const res = await agent.request('mkdir', { root, parent: '/', name: 'newdir' });
    expect(res.ok).toBe(true);
    expect(fs.statSync(path.join(root, 'newdir')).isDirectory()).toBe(true);
  });

  it('stats a file', async () => {
    const res = await agent.request('stat', { root, path: 'a.txt' });
    expect(res.ok).toBe(true);
    expect(res.type).toBe('file');
    expect(res.size).toBe(Buffer.byteLength('hello world\n'));
  });

  it('streams a file in base64 chunks then a terminal size frame', async () => {
    const big = 'x'.repeat(200 * 1024);
    fs.writeFileSync(path.join(root, 'big.bin'), big);
    const id = agent.send('stream', { root, path: 'big.bin' });
    const final = await agent.waitFor((m) => m.id === id && m.ok !== undefined, 10000);
    const chunks = agent.log
      .filter((m) => m.id === id && m.chunk !== undefined)
      .map((m) => Buffer.from(m.chunk, 'base64'));

    expect(final.ok).toBe(true);
    expect(final.size).toBe(big.length);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(big);
    expect(chunks.length).toBeGreaterThan(1); // 200 KiB / 64 KiB chunks
  });

  it('searches literally and returns line/col/text', async () => {
    const res = await agent.request('search', { root, path: '.', query: 'needle' });
    expect(res.ok).toBe(true);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]).toMatchObject({ path: 'sub/b.txt', line: 1, col: 1, text: 'needle inside' });
  });

  it('searches with a regex and case sensitivity', async () => {
    const res = await agent.request('search', { root, path: '.', query: 'NEEDLE', regex: true, caseSensitive: false });
    expect(res.ok).toBe(true);
    expect(res.matches).toHaveLength(1);
  });

  it('skips .git and node_modules while searching', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'x.txt'), 'needle in modules');
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'y.txt'), 'needle in git');
    const res = await agent.request('search', { root, path: '.', query: 'needle' });
    expect(res.ok).toBe(true);
    expect(res.matches.map((m) => m.path)).toEqual(['sub/b.txt']);
  });

  it('caps search at 500 matches and reports truncated', async () => {
    const lines = Array.from({ length: 600 }, () => 'needle').join('\n');
    fs.writeFileSync(path.join(root, 'many.txt'), lines);
    const res = await agent.request('search', { root, path: '.', query: 'needle' });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.matches.length).toBeLessThanOrEqual(500);
  });

  it('refuses a lexical path-traversal attempt with TRAVERSAL', async () => {
    const res = await agent.request('read', { root, path: '../../etc/passwd' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TRAVERSAL');
  });

  it('refuses a symlink that escapes root with TRAVERSAL', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-agent-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    try {
      const res = await agent.request('read', { root, path: 'escape/secret.txt' });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('TRAVERSAL');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports ENOENT for a missing file', async () => {
    const res = await agent.request('read', { root, path: 'nope.txt' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ENOENT');
  });

  it('reports EISDIR when reading a directory as a file', async () => {
    const res = await agent.request('read', { root, path: 'sub' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('EISDIR');
  });

  it('watches a root and emits a change event on write, then unwatches', async () => {
    const started = await agent.request('watch', { root });
    expect(started.ok).toBe(true);

    const changeEvent = agent.waitFor((m) => m.event === 'change' && m.root === root, 5000);
    fs.writeFileSync(path.join(root, 'watched.txt'), 'hi');
    const evt = await changeEvent;
    expect(evt.path).toBeTruthy();

    const stopped = await agent.request('unwatch', { root });
    expect(stopped.ok).toBe(true);
  });
});

// The `git` op behind RemoteFileService#_gitRun (docs/design-git-changes.md,
// "Remote agent op"). The 10 s timeout path is not exercised here — it would
// cost 10 s per run; TIMEOUT mapping is covered on the eve side
// (remote-file-service-git.test.js) and the local runner (git-service.test.js).
describe('remote-fs-agent.js git op', () => {
  const { initRepo, write } = require('../helpers/git-fixture');
  let tmpDir, root, agent;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-agent-git-'));
    root = fs.realpathSync(tmpDir);
    initRepo(root, { 'a.txt': 'one\n', 'bin.dat': Buffer.from([0, 1, 2, 255, 0]) });
    write(root, 'sub/file.txt', 'x');
    agent = startAgent();
  });

  afterEach(() => {
    agent.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs git in cwd and returns stdout as base64', async () => {
    const res = await agent.request('git', { root, cwd: '/', args: ['rev-parse', '--show-toplevel'] });
    expect(res).toMatchObject({ ok: true, code: 0 });
    expect(Buffer.from(res.stdout, 'base64').toString('utf8').trim()).toBe(root);
  });

  it('round-trips binary stdout (NUL bytes) intact', async () => {
    const res = await agent.request('git', { root, cwd: '/', args: ['cat-file', 'blob', 'HEAD:bin.dat'] });
    expect(res.ok).toBe(true);
    expect(Buffer.from(res.stdout, 'base64')).toEqual(Buffer.from([0, 1, 2, 255, 0]));
  });

  it('a non-zero exit is ok: true with the exit code and stderr', async () => {
    const res = await agent.request('git', { root, cwd: '/', args: ['rev-parse', '--verify', 'no-such-ref'] });
    expect(res.ok).toBe(true);
    expect(res.code).not.toBe(0);
    expect(typeof res.stderr).toBe('string');
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('runs in a subdirectory cwd', async () => {
    const res = await agent.request('git', { root, cwd: '/sub', args: ['rev-parse', '--show-prefix'] });
    expect(res.ok).toBe(true);
    expect(Buffer.from(res.stdout, 'base64').toString('utf8').trim()).toBe('sub/');
  });

  it.each([
    ['a string', 'status'],
    ['missing', undefined],
    ['an array with a non-string', ['status', 1]],
  ])('refuses args given as %s', async (_label, args) => {
    const res = await agent.request('git', { root, cwd: '/', args });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ERROR');
  });

  it('refuses a cwd that escapes root lexically with TRAVERSAL', async () => {
    const res = await agent.request('git', { root, cwd: '../..', args: ['status'] });
    expect(res).toMatchObject({ ok: false, code: 'TRAVERSAL' });
  });

  it('refuses a cwd symlinked outside root with TRAVERSAL', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-agent-git-out-'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    try {
      const res = await agent.request('git', { root, cwd: '/escape', args: ['status'] });
      expect(res).toMatchObject({ ok: false, code: 'TRAVERSAL' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a missing cwd is NO_DIR (not GIT_MISSING)', async () => {
    const res = await agent.request('git', { root, cwd: '/nope', args: ['status'] });
    expect(res).toMatchObject({ ok: false, code: 'NO_DIR' });
  });

  it('a cwd that is a file is NO_DIR', async () => {
    const res = await agent.request('git', { root, cwd: '/a.txt', args: ['status'] });
    expect(res).toMatchObject({ ok: false, code: 'NO_DIR' });
  });

  it('output over maxBytes is TOO_LARGE', async () => {
    const res = await agent.request('git', { root, cwd: '/', args: ['--version'], maxBytes: 3 });
    expect(res).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('git absent from PATH is GIT_MISSING', async () => {
    agent.stop();
    const emptyBin = fs.mkdtempSync(path.join(root, 'bin-'));
    agent = startAgent({ env: { ...process.env, PATH: emptyBin } });
    const res = await agent.request('git', { root, cwd: '/', args: ['--version'] });
    expect(res).toMatchObject({ ok: false, code: 'GIT_MISSING' });
  });

  it('ignores inherited GIT_* env that would redirect git elsewhere', async () => {
    agent.stop();
    agent = startAgent({ env: { ...process.env, GIT_DIR: path.join(root, 'no-such', '.git'), GIT_WORK_TREE: '/' } });
    const res = await agent.request('git', { root, cwd: '/', args: ['rev-parse', '--show-toplevel'] });
    expect(res).toMatchObject({ ok: true, code: 0 });
    expect(Buffer.from(res.stdout, 'base64').toString('utf8').trim()).toBe(root);
  });
});
