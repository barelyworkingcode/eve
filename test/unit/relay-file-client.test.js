/**
 * RelayFileClient and ProjectFiles, driven through the RelayTransport surface
 * only: a fake transport answers `fetch`/`stream` and hands out fake `/ws/files`
 * sockets. What this pins is the contract on eve#290: relay's codes become
 * FileService's messages, every upload sends create_only, watches are
 * ref-counted and re-sent after a reconnect, host_status is cached.
 */
const { EventEmitter } = require('events');
const { NullLogger } = require('../../logger');
const mod = require('../../relay-file-client');

const RelayFileClient = mod.RelayFileClient || mod;

const CONSOLE = { id: 'p1', path: '/work/acme' };
const HOST = { id: 'p2', path: '/srv/acme', hostId: 'h1', host: { name: 'testbox' } };

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }
  open() { this.readyState = 1; this.emit('open'); }
  frame(obj) { this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), false); }
  drop() { this.readyState = 3; this.emit('close', 1006, Buffer.from('')); }
  send(data) {
    if (this.readyState !== 1) throw new Error(`WebSocket is not open: readyState ${this.readyState}`);
    this.sent.push(JSON.parse(data));
  }
  close() { if (this.readyState !== 3) this.drop(); }
  terminate() { this.close(); }
}

// The relay answers with `reply(op, body)`; the default is a bare 200.
function makeTransport() {
  const t = {
    sockets: [],
    calls: [],
    streams: [],
    reply: () => ({ status: 200, data: {} }),
    fetch: jest.fn(async (method, path, body, opts) => {
      const op = path.split('/').pop();
      t.calls.push({ method, path, op, body, opts });
      const r = t.reply(op, body);
      if (r instanceof Error) throw r;
      return r;
    }),
    stream: jest.fn(async (method, path, opts) => {
      t.streams.push({ method, path, opts });
      return { status: 206, headers: {}, body: null };
    }),
    createWebSocket: jest.fn((wsPath) => {
      const s = new FakeSocket();
      s.wsPath = wsPath;
      t.sockets.push(s);
      return s;
    }),
  };
  return t;
}

const fail = (status, code, error = 'x') => ({ status, data: { error, code } });
// Fails the op under test and answers a pre-check stat as a plain file, so the
// failure is the one the row names and not a side lookup's.
const failOp = (status, code, error) => (op) => (op === 'stat' ? { status: 200, data: { type: 'file', size: 1, mtime_ms: 1 } } : fail(status, code, error));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('RelayFileClient: project file ops over relay routes', () => {
  let transport;
  let client;
  let files;

  beforeEach(() => {
    transport = makeTransport();
    client = new RelayFileClient({ relayTransport: transport, log: new NullLogger() });
    files = (project) => client.forProject(project);
  });

  it('relays an op to the project route with the project-relative path', async () => {
    transport.reply = () => ({ status: 200, data: { content: 'hi', size: 2 } });
    const res = await files(CONSOLE).readFile(CONSOLE.path, 'src/a.md');
    expect(res).toEqual({ content: 'hi', size: 2 });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ method: 'POST', path: '/api/projects/p1/files/read', body: { path: 'src/a.md' } });
  });

  it('lists directories first, then by name, and passes show_hidden', async () => {
    transport.reply = () => ({
      status: 200,
      data: { entries: [
        { name: 'b.js', type: 'file', size: 3, mtime_ms: 1 },
        { name: 'src', type: 'directory', size: 0, mtime_ms: 2 },
        { name: 'a.js', type: 'file', size: 1, mtime_ms: 3 },
        { name: 'lib', type: 'directory', size: 0, mtime_ms: 4 },
      ] },
    });
    const items = await files(CONSOLE).listDirectory(CONSOLE.path, '/', { showHidden: true });
    expect(items.map((e) => e.name)).toEqual(['lib', 'src', 'a.js', 'b.js']);
    expect(items[2]).toMatchObject({ type: 'file', size: 1 });
    expect(transport.calls[0].body).toMatchObject({ show_hidden: true });
  });

  describe('uploads send create_only', () => {
    it.each([
      ['console', CONSOLE],
      ['host', HOST],
    ])('a %s upload sets create_only:true', async (_label, project) => {
      await files(project).uploadFile(project.path, 'docs', 'pic.bin', 'AAEC', 'base64');
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0].op).toBe('write');
      expect(transport.calls[0].path).toBe(`/api/projects/${project.id}/files/write`);
      expect(transport.calls[0].body).toMatchObject({ path: 'docs/pic.bin', content: 'AAEC', encoding: 'base64', create_only: true });
    });

    it('an editor save does not set create_only, or saving would refuse every existing file', async () => {
      await files(CONSOLE).writeFile(CONSOLE.path, 'notes.md', 'x');
      expect(transport.calls[0].body.create_only).toBeFalsy();
    });

    it.each([
      ['console', CONSOLE],
      ['host', HOST],
    ])('an upload over an existing file on a %s project fails with the existing message', async (_label, project) => {
      transport.reply = () => fail(409, 'EEXIST', 'Already exists');
      await expect(files(project).uploadFile(project.path, '', 'a.txt', 'x', 'utf8'))
        .rejects.toMatchObject({ message: 'A file with that name already exists', code: 'EEXIST' });
    });
  });

  describe('relay codes become the FileService messages', () => {
    const call = {
      read: (f, p) => f.readFile(p.path, 'notes.md'),
      write: (f, p) => f.writeFile(p.path, 'notes.md', 'x'),
      list: (f, p) => f.listDirectory(p.path, '/', {}),
      rename: (f, p) => f.renameFile(p.path, 'notes.md', 'new.md'),
      move: (f, p) => f.moveFile(p.path, 'notes.md', 'sub'),
      delete: (f, p) => f.deleteFile(p.path, 'notes.md'),
      upload: (f, p) => f.uploadFile(p.path, 'sub', 'a.txt', 'x', 'utf8'),
      mkdir: (f, p) => f.createDirectory(p.path, '/', 'lib'),
    };
    it.each([
      ['read', 404, 'ENOENT', 'File not found'],
      ['read', 400, 'EISDIR', 'Path is a directory'],
      ['read', 403, 'EACCES', 'Permission denied'],
      ['read', 403, 'TRAVERSAL', 'Path traversal not allowed'],
      ['read', 413, 'TOO_LARGE', 'File too large (max 10MB)'],
      ['read', 403, 'SYMLINK', 'Symbolic links are not opened'],
      ['write', 403, 'READ_ONLY', 'This project is read-only'],
      ['write', 404, 'ENOENT', 'Directory not found'],
      ['list', 404, 'ENOENT', 'Directory not found'],
      ['rename', 409, 'EEXIST', 'A file or directory with that name already exists'],
      ['rename', 403, 'READ_ONLY', 'This project is read-only'],
      ['move', 409, 'EEXIST', 'A file or directory with that name already exists at destination'],
      ['move', 404, 'ENOENT', 'Source file not found'],
      ['delete', 404, 'ENOENT', 'File not found'],
      ['delete', 403, 'SYMLINK', 'Symbolic links are not opened'],
      ['upload', 409, 'EEXIST', 'A file with that name already exists'],
      ['upload', 404, 'ENOENT', 'Destination directory not found'],
      ['mkdir', 409, 'EEXIST', 'Directory already exists'],
      ['mkdir', 404, 'ENOENT', 'Parent directory not found'],
    ])('%s: %i %s -> "%s"', async (op, status, code, message) => {
      transport.reply = failOp(status, code, 'relay text that must not reach the browser');
      await expect(call[op](files(CONSOLE), CONSOLE)).rejects.toMatchObject({ message, code });
    });

    it('a rename or move over an existing destination fails on a host project too', async () => {
      transport.reply = failOp(409, 'EEXIST');
      await expect(call.rename(files(HOST), HOST)).rejects.toMatchObject({ code: 'EEXIST', message: 'A file or directory with that name already exists' });
      await expect(call.move(files(HOST), HOST)).rejects.toMatchObject({ code: 'EEXIST', message: 'A file or directory with that name already exists at destination' });
    });

    it('an unreachable host names the host', async () => {
      transport.reply = () => fail(503, 'HOST_UNREACHABLE', 'host "other" unreachable');
      await expect(call.read(files(HOST), HOST)).rejects.toMatchObject({ message: 'Host "testbox" is not connected', code: 'HOST_UNREACHABLE' });
    });

    it('a relay that cannot be reached says so', async () => {
      transport.reply = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
      await expect(call.read(files(CONSOLE), CONSOLE)).rejects.toMatchObject({ message: 'Relay is not reachable', code: 'RELAY_DOWN' });
      await expect(call.write(files(CONSOLE), CONSOLE)).rejects.toMatchObject({ code: 'RELAY_DOWN' });
    });
  });

  describe('checks that never reach relay', () => {
    it.each([
      ['readFile', (f) => f.readFile(CONSOLE.path, '../outside.txt'), 'Path traversal not allowed'],
      ['writeFile', (f) => f.writeFile(CONSOLE.path, 'a/../../outside.txt', 'x'), 'Path traversal not allowed'],
      ['renameFile name with a slash', (f) => f.renameFile(CONSOLE.path, 'a.txt', 'b/c.txt'), 'Name cannot contain path separators'],
      ['createDirectory name with a slash', (f) => f.createDirectory(CONSOLE.path, '/', 'a/b'), 'Name cannot contain path separators'],
      ['uploadFile name with a slash', (f) => f.uploadFile(CONSOLE.path, '/', 'a/b.txt', 'x', 'utf8'), 'File name cannot contain path separators'],
      ['readFile of a type the editor does not open', (f) => f.readFile(CONSOLE.path, 'logo.png'), 'File type not allowed for editing'],
      ['moveFile of a directory into itself', (f) => f.moveFile(CONSOLE.path, 'src', 'src'), 'Cannot move a directory into itself'],
      ['moveFile of a directory into its own subfolder', (f) => f.moveFile(CONSOLE.path, 'src', 'src/deep'), 'Cannot move a directory into itself'],
    ])('%s is refused without a request', async (_label, run, message) => {
      await expect(run(files(CONSOLE))).rejects.toThrow(message);
      expect(transport.calls).toHaveLength(0);
    });

    it('renaming a console file to a type the editor does not open is refused, and rename is never sent', async () => {
      transport.reply = () => ({ status: 200, data: { type: 'file', size: 1, mtime_ms: 1 } }); // the pre-check stat
      await expect(files(CONSOLE).renameFile(CONSOLE.path, 'notes.md', 'notes.exe')).rejects.toThrow('File type not allowed');
      expect(transport.calls.filter((c) => c.op === 'rename')).toHaveLength(0);
    });

    it('the editor extension list applies to console projects only', async () => {
      transport.reply = () => ({ status: 200, data: { content: '', size: 0 } });
      await files(HOST).readFile(HOST.path, 'logo.png');
      expect(transport.calls).toHaveLength(1);
    });
  });

  describe('paths are lexical', () => {
    it('validatePath normalises a leading slash and the root, and refuses traversal', () => {
      const f = files(CONSOLE);
      expect(f.validatePath(CONSOLE.path, '/src/a.js')).toBe(f.validatePath(CONSOLE.path, 'src/a.js'));
      expect(f.validatePath(CONSOLE.path, '')).toBe(f.validatePath(CONSOLE.path, '/'));
      expect(f.validatePath(CONSOLE.path, 'src/../lib/u.js')).toBe(f.validatePath(CONSOLE.path, 'lib/u.js'));
      expect(() => f.validatePath(CONSOLE.path, '../../etc/passwd')).toThrow('Path traversal not allowed');
      expect(() => f.validatePath(CONSOLE.path, 'src/../../outside')).toThrow('Path traversal not allowed');
      expect(transport.calls).toHaveLength(0);
    });

    it('isPathWithin does not accept a sibling that shares the name prefix', () => {
      const f = files(CONSOLE);
      expect(f.isPathWithin('/work/acme', '/work/acme/src')).toBe(true);
      expect(f.isPathWithin('/work/acme', '/work/acme-secrets/x')).toBe(false);
    });
  });

  it('keeps one ProjectFiles per project id, path and host', () => {
    expect(client.forProject(CONSOLE)).toBe(client.forProject({ ...CONSOLE }));
    expect(client.forProject(CONSOLE)).not.toBe(client.forProject({ ...CONSOLE, path: '/work/other' }));
    expect(client.forProject(CONSOLE)).not.toBe(client.forProject({ ...CONSOLE, hostId: 'h1' }));
  });

  it('streams a Range request to the stream route and returns relay\'s status and headers', async () => {
    const res = await files(CONSOLE).openStream(CONSOLE.path, 'img/a b.png', { range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(transport.streams).toHaveLength(1);
    const { method, path, opts } = transport.streams[0];
    expect(method).toBe('GET');
    const url = new URL(path, 'http://relay.invalid');
    expect(url.pathname).toBe('/api/projects/p1/files/stream');
    expect(url.searchParams.get('path')).toBe('img/a b.png');
    expect(opts.headers.Range).toBe('bytes=0-3');
  });

  it('pastes an image to a host through the pastetmp route', async () => {
    transport.reply = () => ({ status: 200, data: { path: '/tmp/eve-paste-1-ab.png' } });
    const out = await client.pasteToHost('h1', 'eve-paste-1-ab.png', Buffer.from([1, 2, 3]));
    expect(out).toBe('/tmp/eve-paste-1-ab.png');
    expect(transport.calls[0]).toMatchObject({ method: 'POST', path: '/api/hosts/h1/pastetmp', body: { name: 'eve-paste-1-ab.png', data_b64: 'AQID' } });
  });

  describe('git op failures keep GitService\'s codes', () => {
    it.each([
      [404, 'ENOENT', 'NOT_A_REPO'],
      [400, 'ENOTDIR', 'NOT_A_REPO'],
      [403, 'TRAVERSAL', 'NOT_A_REPO'],
      [403, 'SYMLINK', 'NOT_A_REPO'],
      [400, 'INVALID', 'FAILED'],
      [500, 'GIT_MISSING', 'GIT_MISSING'],
      [413, 'TOO_LARGE', 'TOO_LARGE'],
      [504, 'TIMEOUT', 'TIMEOUT'],
    ])('relay %i %s -> %s', async (status, code, expected) => {
      transport.reply = (op) => (op === 'git' ? fail(status, code) : { status: 200, data: {} });
      await expect(files(CONSOLE).gitStatus(CONSOLE.path, '/', 'uncommitted')).rejects.toMatchObject({ code: expected });
      expect(transport.calls.some((c) => c.op === 'git')).toBe(true);
    });

    it('sends argv from the subcommand on and decodes stdout (a worktree list names the repo)', async () => {
      const b64 = (t) => Buffer.from(t).toString('base64');
      transport.reply = (op, body) => {
        if (op !== 'git') return { status: 200, data: {} };
        const out = body.args[0] === 'worktree'
          ? 'worktree /work/acme\nHEAD 0123456789abcdef0123456789abcdef01234567\nbranch refs/heads/decoded-branch\n'
          : '';
        return { status: 200, data: { exit_code: body.args[0] === 'worktree' ? 0 : 1, stdout_b64: b64(out), stderr: '' } };
      };
      const repos = await files(CONSOLE).gitRepos(CONSOLE.path);
      const first = transport.calls.find((c) => c.op === 'git');
      expect(first.path).toBe('/api/projects/p1/files/git');
      for (const c of transport.calls.filter((x) => x.op === 'git')) {
        expect(c.body.args[0]).toMatch(/^[a-z-]+$/);
        expect(c.body.args).not.toContain('-c');
      }
      expect(repos.map((r) => r.branch)).toContain('decoded-branch');
    });
  });

  describe('search', () => {
    it('maps relay matches to the browser shape and forwards the options and the abort signal', async () => {
      transport.reply = () => ({
        status: 200,
        data: { matches: [{ path: 'src/a.js', line: 3, col: 5, len: 4, text: '// TODO x' }], truncated: true },
      });
      const ctl = new AbortController();
      const res = await files(CONSOLE).search(CONSOLE.path, 'TODO', { regex: true, word: true, globs: ['*.js'] }, { signal: ctl.signal });
      expect(res.matches).toEqual([{ file: 'src/a.js', lineNumber: 3, lineText: '// TODO x', submatches: [{ start: 4, end: 8 }] }]);
      expect(res.truncated).toBe(true);
      expect(typeof res.durationMs).toBe('number');
      expect(transport.calls[0].body).toMatchObject({ query: 'TODO', regex: true, word: true, globs: ['*.js'] });
      expect(transport.calls[0].opts.signal).toBe(ctl.signal);
    });

    it('refuses an empty query with the existing message, without asking relay', async () => {
      transport.reply = () => fail(400, 'INVALID', 'relay says something else');
      await expect(files(CONSOLE).search(CONSOLE.path, '', {})).rejects.toThrow('Search query is empty');
      expect(transport.calls).toHaveLength(0);
    });
  });
});

describe('RelayFileClient: the /ws/files socket', () => {
  let transport;
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
    transport = makeTransport();
    client = new RelayFileClient({ relayTransport: transport, log: new NullLogger() });
  });

  afterEach(() => {
    client.close();
    jest.useRealTimers();
  });

  const sentOfType = (socket, type) => socket.sent.filter((f) => f.type === type);

  async function started() {
    client.start();
    await flush();
    const s = transport.sockets[0];
    s.open();
    await flush();
    return s;
  }

  it('opens /ws/files once', async () => {
    await started();
    expect(transport.sockets).toHaveLength(1);
    expect(transport.sockets[0].wsPath).toBe('/ws/files');
  });

  describe('watch ref-counting', () => {
    it('sends watch on the first watcher and unwatch on the last, one frame each', async () => {
      const s = await started();
      client.watch('p1');
      client.watch('p1');
      expect(sentOfType(s, 'watch')).toEqual([{ type: 'watch', project_id: 'p1' }]);
      client.unwatch('p1');
      expect(sentOfType(s, 'unwatch')).toHaveLength(0);
      client.unwatch('p1');
      expect(sentOfType(s, 'unwatch')).toEqual([{ type: 'unwatch', project_id: 'p1' }]);
    });

    it('keeps projects apart', async () => {
      const s = await started();
      client.watch('p1');
      client.watch('p2');
      client.unwatch('p1');
      expect(sentOfType(s, 'unwatch')).toEqual([{ type: 'unwatch', project_id: 'p1' }]);
    });

    it('sends nothing for an unwatch that has no watch', async () => {
      const s = await started();
      client.unwatch('p9');
      expect(s.sent).toEqual([]);
    });

    it('a watch asked for before the socket opens goes out once, when it opens', async () => {
      client.start();
      await flush();
      client.watch('p1');
      const s = transport.sockets[0];
      s.open();
      await flush();
      expect(sentOfType(s, 'watch')).toEqual([{ type: 'watch', project_id: 'p1' }]);
    });
  });

  describe('reconnect', () => {
    it('opens a new socket after 2 s and re-sends watch for every project still watched', async () => {
      const s0 = await started();
      client.watch('p1');
      client.watch('p2');
      client.watch('p3');
      client.unwatch('p3');
      s0.drop();
      await jest.advanceTimersByTimeAsync(1999);
      expect(transport.sockets).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(transport.sockets).toHaveLength(2);
      const s1 = transport.sockets[1];
      s1.open();
      await flush();
      expect(sentOfType(s1, 'watch').map((f) => f.project_id).sort()).toEqual(['p1', 'p2']);
    });

    it('keeps trying, never waiting longer than 30 s between attempts', async () => {
      await started();
      for (let i = 1; i <= 8; i++) {
        transport.sockets[transport.sockets.length - 1].drop();
        await jest.advanceTimersByTimeAsync(30000);
        expect(transport.sockets).toHaveLength(i + 1);
      }
    });

    it('a drop after a successful reconnect waits 2 s again, not the grown delay', async () => {
      await started();
      transport.sockets[0].drop();
      await jest.advanceTimersByTimeAsync(2000);
      transport.sockets[1].drop(); // a failed attempt: the delay grows
      await jest.advanceTimersByTimeAsync(30000);
      expect(transport.sockets).toHaveLength(3);
      transport.sockets[2].open(); // success resets it
      await flush();
      transport.sockets[2].drop();
      await jest.advanceTimersByTimeAsync(1999);
      expect(transport.sockets).toHaveLength(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(transport.sockets).toHaveLength(4);
    });

    it('does not reconnect after close()', async () => {
      await started();
      client.close();
      await jest.advanceTimersByTimeAsync(60000);
      expect(transport.sockets).toHaveLength(1);
    });
  });

  describe('frames from relay', () => {
    it('turns fs_event, watch_ok and watch_error into events', async () => {
      const s = await started();
      const seen = { fs: [], ok: [], err: [] };
      client.on('fs_event', (e) => seen.fs.push(e));
      client.on('watch_ok', (e) => seen.ok.push(e));
      client.on('watch_error', (e) => seen.err.push(e));
      s.frame({ type: 'watch_ok', project_id: 'p1' });
      s.frame({ type: 'fs_event', project_id: 'p1', path: 'src/a.js', kind: 'change' });
      s.frame({ type: 'watch_error', project_id: 'p2', code: 'ENOENT', error: 'gone' });
      expect(seen.ok).toEqual([expect.objectContaining({ projectId: 'p1' })]);
      expect(seen.fs).toEqual([{ projectId: 'p1', path: 'src/a.js', kind: 'change' }]);
      expect(seen.err).toEqual([{ projectId: 'p2', code: 'ENOENT', error: 'gone' }]);
    });

    it('ignores unknown and malformed frames', async () => {
      const s = await started();
      const onAny = jest.fn();
      ['fs_event', 'watch_ok', 'watch_error', 'host_status'].forEach((e) => client.on(e, onAny));
      s.frame({ type: 'something_new', project_id: 'p1' });
      s.frame('not json at all');
      expect(onAny).not.toHaveBeenCalled();
    });
  });

  describe('host_status', () => {
    it('emits each frame and keeps the latest status per host', async () => {
      const s = await started();
      const seen = [];
      client.on('host_status', (e) => seen.push(e));
      s.frame({ type: 'host_status', host_id: 'h1', name: 'testbox', status: 'connecting' });
      s.frame({ type: 'host_status', host_id: 'h2', name: 'spare', status: 'connected' });
      s.frame({ type: 'host_status', host_id: 'h1', name: 'testbox', status: 'unreachable', error: 'down' });
      expect(seen).toHaveLength(3);
      expect(seen[2]).toEqual({ hostId: 'h1', name: 'testbox', status: 'unreachable', error: 'down' });
      const cached = client.hostStatuses();
      expect(cached).toHaveLength(2);
      expect(cached).toEqual(expect.arrayContaining([
        expect.objectContaining({ hostId: 'h1', name: 'testbox', status: 'unreachable', error: 'down' }),
        expect.objectContaining({ hostId: 'h2', name: 'spare', status: 'connected' }),
      ]));
    });

    it('starts empty', () => {
      expect(client.hostStatuses()).toEqual([]);
    });
  });
});
