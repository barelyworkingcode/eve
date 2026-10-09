/**
 * The file-plane conformance table: relay's file routes as eve relies on them,
 * written once and run against any backend that serves them (the fake relay in
 * relay-fidelity.test.js, a real relay in file-plane-live.test.js). Expectations
 * come from relay's projectfs.go / file_routes.go / file_ops.go, not from the fake.
 *
 * driver:
 *   request(method, path, { json, headers }) -> { status, headers (lowercase), body: Buffer }
 *   projectId                 the project the current tree belongs to
 *   seed(tree)                replace the project's tree with exactly `tree`
 *                             ({'a.txt': 'text', 'd/': null, 'b.bin': Buffer})
 *   symlink(rel, target)      plant a symlink inside the project
 *   setReadOnly(on)           optional; rows that need it are skipped without it
 *
 * Console project only: rename and move onto an existing name are 409 EEXIST
 * (owner decision 46 makes host projects the same); delete is trashed:true.
 */
const http = require('http');

// A request function over a TCP base URL or a Unix socket, with an optional bearer.
function makeRequester({ baseUrl, socketPath, token }) {
  return (method, path, { json, headers = {} } = {}) => new Promise((resolve, reject) => {
    const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body) { h['Content-Type'] = 'application/json'; h['Content-Length'] = body.length; }
    const where = socketPath ? { socketPath } : { host: new URL(baseUrl).hostname, port: new URL(baseUrl).port };
    const opts = { ...where, method, path, headers: h };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const text = (r) => r.body.toString('utf8');
const parse = (r) => JSON.parse(text(r));

function defineFilePlaneConformance(driver) {
  const call = (op, json, id = driver.projectId) => driver.request('POST', `/api/projects/${encodeURIComponent(id)}/files/${op}`, { json });
  const stream = (rel, headers) => driver.request('GET', `/api/projects/${driver.projectId}/files/stream?path=${encodeURIComponent(rel)}`, { headers });
  const ok = async (op, json) => { const r = await call(op, json); expect({ op, status: r.status, body: text(r) }).toMatchObject({ status: 200 }); return parse(r); };
  const refused = async (r, status, code, error, extra = {}) => {
    expect(r.status).toBe(status);
    expect(parse(r)).toEqual({ error, code, ...extra });
  };
  const AT = 'at.txt';

  describe('happy paths', () => {
    it('list: entries with type, size and integer mtime_ms; hidden only on request; leading slash is the root-relative path', async () => {
      await driver.seed({ 'a.txt': 'hi', 'sub/': null, 'sub/b.txt': 'x', '.hid': 'h' });
      const names = (res) => Object.fromEntries(res.entries.map((e) => [e.name, e]));
      const root = names(await ok('list', { path: '' }));
      expect(Object.keys(root).sort()).toEqual(['a.txt', 'sub']);
      expect(root['a.txt']).toMatchObject({ type: 'file', size: 2 });
      expect(Number.isInteger(root['a.txt'].mtime_ms)).toBe(true);
      expect(root.sub.type).toBe('directory');
      expect(Object.keys(names(await ok('list', { path: '', show_hidden: true }))).sort()).toEqual(['.hid', 'a.txt', 'sub']);
      expect(Object.keys(names(await ok('list', { path: '/sub' })))).toEqual(['b.txt']);
    });

    it('stat: type, size and integer mtime_ms', async () => {
      await driver.seed({ 'a.txt': 'hi', 'sub/': null });
      const f = await ok('stat', { path: 'a.txt' });
      expect(f).toMatchObject({ type: 'file', size: 2 });
      expect(Number.isInteger(f.mtime_ms)).toBe(true);
      expect((await ok('stat', { path: 'sub' })).type).toBe('directory');
    });

    it('read: utf8 content and its byte size', async () => {
      await driver.seed({ 'a.txt': 'hé' });
      expect(await ok('read', { path: 'a.txt' })).toEqual({ content: 'hé', size: 3 });
    });

    it('stream: raw bytes with Accept-Ranges; a Range answers 206 with Content-Range', async () => {
      const bytes = Buffer.from([0, 255, 1, 254, 2, 253, 3, 252]);
      await driver.seed({ 'b.bin': bytes });
      const full = await stream('b.bin');
      expect(full.status).toBe(200);
      expect(full.headers['content-type']).toMatch(/^application\/octet-stream/);
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.body.equals(bytes)).toBe(true);
      const part = await stream('b.bin', { Range: 'bytes=2-4' });
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 2-4/8');
      expect(part.body.equals(bytes.subarray(2, 5))).toBe(true);
    });

    it('write: creates, overwrites, takes base64; create_only on a new name succeeds', async () => {
      await driver.seed({ 'old.txt': 'old' });
      expect(await ok('write', { path: AT, content: 'one' })).toEqual({ path: AT });
      expect((await ok('read', { path: AT })).content).toBe('one');
      await ok('write', { path: AT, content: 'two', encoding: 'utf8' });
      expect((await ok('read', { path: AT })).content).toBe('two');
      await ok('write', { path: 'old.txt', content: Buffer.from('new').toString('base64'), encoding: 'base64' });
      expect((await ok('read', { path: 'old.txt' })).content).toBe('new');
      await ok('write', { path: 'fresh.txt', content: 'f', create_only: true });
      expect((await ok('read', { path: 'fresh.txt' })).content).toBe('f');
    });

    it('mkdir: returns the new root-relative path', async () => {
      await driver.seed({ 'sub/': null });
      expect(await ok('mkdir', { parent: 'sub', name: 'lib' })).toEqual({ path: 'sub/lib' });
      expect((await ok('stat', { path: 'sub/lib' })).type).toBe('directory');
    });

    it('rename: moves the entry within its folder', async () => {
      await driver.seed({ 'sub/a.txt': 'A' });
      expect(await ok('rename', { path: 'sub/a.txt', new_name: 'b.txt' })).toEqual({ path: 'sub/b.txt' });
      expect((await ok('read', { path: 'sub/b.txt' })).content).toBe('A');
      expect((await call('stat', { path: 'sub/a.txt' })).status).toBe(404);
    });

    it('move: moves the entry into another folder', async () => {
      await driver.seed({ 'a.txt': 'A', 'lib/': null });
      expect(await ok('move', { path: 'a.txt', dest_dir: 'lib' })).toEqual({ path: 'lib/a.txt' });
      expect((await ok('read', { path: 'lib/a.txt' })).content).toBe('A');
      expect((await call('stat', { path: 'a.txt' })).status).toBe(404);
    });

    it('delete: console moves the entry to the Trash (trashed:true)', async () => {
      await driver.seed({ 'a.txt': 'A' });
      expect(await ok('delete', { path: 'a.txt' })).toEqual({ trashed: true });
      expect((await call('stat', { path: 'a.txt' })).status).toBe(404);
    });

    it('search: 1-based line and column, col and len in UTF-16 units after a non-BMP character; hidden folders skipped', async () => {
      await driver.seed({ 'src/a.js': 'x\n\u{1F600} TODO y\n', 'src/b.js': 'nothing', '.hid/c.js': 'TODO' });
      const res = await ok('search', { query: 'TODO', regex: false, word: false, case_sensitive: null, globs: ['*.js'], max_matches: 500 });
      expect(res).toEqual({ matches: [{ path: 'src/a.js', line: 2, col: 4, len: 4, text: '\u{1F600} TODO y' }], truncated: false });
    });

    it('git: a folder that is not a repo answers 200 with exit_code 128', async () => {
      await driver.seed({ 'a.txt': 'A' });
      const res = await ok('git', { cwd: '', args: ['rev-parse', '--show-toplevel'] });
      expect(res.exit_code).toBe(128);
      expect(res.stderr).toMatch(/not a git repository/);
      expect(res.stdout_b64).toBe('');
    });
  });

  describe('refusals carry status, code and message', () => {
    // [name, op, body, status, code, message, extra body keys]
    const rows = [
      ['EEXIST: write create_only onto an existing file', 'write', { path: 'a.txt', content: 'z', create_only: true }, 409, 'EEXIST', 'Already exists'],
      ['EEXIST: mkdir onto an existing name', 'mkdir', { parent: '', name: 'sub' }, 409, 'EEXIST', 'Already exists'],
      ['EEXIST: rename onto an existing name', 'rename', { path: 'a.txt', new_name: 'c.txt' }, 409, 'EEXIST', 'Already exists'],
      ['EEXIST: move onto an existing name', 'move', { path: 'a.txt', dest_dir: 'sub' }, 409, 'EEXIST', 'Already exists'],
      ['TRAVERSAL: read', 'read', { path: '../x' }, 403, 'TRAVERSAL', 'Path traversal not allowed'],
      ['TRAVERSAL: write', 'write', { path: 'sub/../../x', content: 'z' }, 403, 'TRAVERSAL', 'Path traversal not allowed'],
      ['TRAVERSAL: move dest_dir', 'move', { path: 'a.txt', dest_dir: '..' }, 403, 'TRAVERSAL', 'Path traversal not allowed'],
      ['INVALID: NUL in a path', 'read', { path: 'a\u0000b' }, 400, 'INVALID', 'path contains NUL'],
      ['INVALID: mkdir name with a slash', 'mkdir', { parent: '', name: 'a/b' }, 400, 'INVALID', 'invalid name'],
      ['INVALID: mkdir name ..', 'mkdir', { parent: '', name: '..' }, 400, 'INVALID', 'invalid name'],
      ['INVALID: rename to an empty name', 'rename', { path: 'a.txt', new_name: '' }, 400, 'INVALID', 'invalid name'],
      ['INVALID: rename to a name with NUL', 'rename', { path: 'a.txt', new_name: 'x\u0000y' }, 400, 'INVALID', 'invalid name'],
      ['INVALID: empty search query', 'search', { query: '' }, 400, 'INVALID', 'Search query is empty'],
      ['INVALID: git argument relay refuses', 'git', { cwd: '', args: ['status', '--output=x'] }, 400, 'INVALID', 'git argument not allowed: --output=x'],
      ['SYMLINK: stat', 'stat', { path: 'link' }, 403, 'SYMLINK', 'Symbolic links are not opened'],
      ['SYMLINK: read', 'read', { path: 'link' }, 403, 'SYMLINK', 'Symbolic links are not opened'],
      ['SYMLINK: delete', 'delete', { path: 'link' }, 403, 'SYMLINK', 'Symbolic links are not opened'],
      ['ENOENT: read a missing file', 'read', { path: 'nope.txt' }, 404, 'ENOENT', 'Not found'],
      ['ENOENT: write does not create parents', 'write', { path: 'nodir/x.txt', content: 'z' }, 404, 'ENOENT', 'Not found'],
      ['EISDIR: read a directory', 'read', { path: 'sub' }, 400, 'EISDIR', 'Path is a directory'],
      ['ENOTDIR: list a file', 'list', { path: 'a.txt' }, 400, 'ENOTDIR', 'Not a directory'],
      ['TOO_LARGE: read over max_bytes reports the size', 'read', { path: 'a.txt', max_bytes: 4 }, 413, 'TOO_LARGE', 'File too large', { size: 10 }],
    ];
    it.each(rows)('%s', async (_name, op, body, status, code, message, extra = {}) => {
      await driver.seed({ 'a.txt': '0123456789', 'c.txt': 'C', 'sub/': null, 'sub/a.txt': 'S' });
      await driver.symlink('link', 'a.txt');
      await refused(await call(op, body), status, code, message, extra);
    });

    it('EEXIST rename and move leave both entries as they were', async () => {
      await driver.seed({ 'a.txt': 'A', 'c.txt': 'C', 'sub/': null, 'sub/a.txt': 'S' });
      await call('rename', { path: 'a.txt', new_name: 'c.txt' });
      await call('move', { path: 'a.txt', dest_dir: 'sub' });
      expect((await ok('read', { path: 'a.txt' })).content).toBe('A');
      expect((await ok('read', { path: 'c.txt' })).content).toBe('C');
      expect((await ok('read', { path: 'sub/a.txt' })).content).toBe('S');
    });

    it('PROJECT_NOT_FOUND: an unknown project id', async () => {
      await refused(await call('list', { path: '' }, 'ghost'), 404, 'PROJECT_NOT_FOUND', 'project not found');
    });

    it('TRAVERSAL: stream', async () => {
      await driver.seed({ 'a.txt': 'A' });
      await refused(await stream('../x'), 403, 'TRAVERSAL', 'Path traversal not allowed');
    });

    const mutations = [
      ['write', { path: 'a.txt', content: 'z' }],
      ['mkdir', { parent: '', name: 'n' }],
      ['rename', { path: 'a.txt', new_name: 'n.txt' }],
      ['move', { path: 'a.txt', dest_dir: 'sub' }],
      ['delete', { path: 'a.txt' }],
    ];
    // A driver without setReadOnly skips these rows visibly rather than passing them.
    (driver.setReadOnly ? it.each : it.skip.each)(mutations)('READ_ONLY: %s is refused and reads still work', async (op, body) => {
      await driver.seed({ 'a.txt': 'A', 'sub/': null });
      await driver.setReadOnly(true);
      try {
        await refused(await call(op, body), 403, 'READ_ONLY', 'This project is read-only');
        expect(await ok('read', { path: 'a.txt' })).toEqual({ content: 'A', size: 1 });
      } finally {
        await driver.setReadOnly(false);
      }
    });
  });
}

module.exports = { defineFilePlaneConformance, makeRequester };
