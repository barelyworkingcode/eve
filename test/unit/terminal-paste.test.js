// Images pasted into a terminal pane: saved to a temp file where the terminal
// runs (eve's own tmpdir for a console terminal, /tmp on an SSH host via the
// agent's `pastetmp` op) and the path handed back to the pane.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { saveTerminalPaste, pasteFileName, MAX_PASTE_BYTES } = require('../../terminal-paste');
const registerRoutes = require('../../routes/index');
const TerminalManager = require('../../public/terminal-manager');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('pasteFileName', () => {
  it('builds a unique eve-paste name with the type\'s extension', () => {
    const a = pasteFileName('image/jpeg', 1700000000000);
    const b = pasteFileName('image/jpeg', 1700000000000);
    expect(a).toMatch(/^eve-paste-1700000000000-[0-9a-f]{8}\.jpg$/);
    expect(a).not.toBe(b);
  });

  it('refuses a non-image or unsupported type with 415', () => {
    expect(() => pasteFileName('image/svg+xml')).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => pasteFileName('text/plain')).toThrow(expect.objectContaining({ status: 415 }));
  });
});

describe('saveTerminalPaste', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-paste-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes a console paste into the local temp dir, owner-only', async () => {
    const full = await saveTerminalPaste({ buffer: PNG, mimeType: 'image/png' }, { localDir: dir });
    expect(path.dirname(full)).toBe(dir);
    expect(fs.readFileSync(full)).toEqual(PNG);
    expect(fs.statSync(full).mode & 0o777).toBe(0o600);
  });

  it('rejects an empty body (400) and an oversized one (413)', async () => {
    await expect(saveTerminalPaste({ buffer: Buffer.alloc(0), mimeType: 'image/png' }, { localDir: dir }))
      .rejects.toMatchObject({ status: 400 });
    await expect(saveTerminalPaste({ buffer: Buffer.alloc(MAX_PASTE_BYTES + 1), mimeType: 'image/png' }, { localDir: dir }))
      .rejects.toMatchObject({ status: 413 });
  });

  it('sends a host paste to the agent as pastetmp and returns the host path', async () => {
    const agent = { request: jest.fn().mockResolvedValue({ ok: true, path: '/tmp/eve-paste-x.png' }) };
    const hostPool = { get: jest.fn(() => agent) };
    const full = await saveTerminalPaste({ buffer: PNG, mimeType: 'image/png', hostId: 'h1' }, { hostPool, localDir: dir });
    expect(full).toBe('/tmp/eve-paste-x.png');
    expect(hostPool.get).toHaveBeenCalledWith('h1');
    const [op, params] = agent.request.mock.calls[0];
    expect(op).toBe('pastetmp');
    expect(params.name).toMatch(/^eve-paste-\d+-[0-9a-f]+\.png$/);
    expect(Buffer.from(params.data, 'base64')).toEqual(PNG);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('404s an unknown host and 502s an agent failure', async () => {
    await expect(saveTerminalPaste({ buffer: PNG, mimeType: 'image/png', hostId: 'gone' }, { hostPool: { get: () => null } }))
      .rejects.toMatchObject({ status: 404 });
    const agent = { request: jest.fn().mockRejectedValue(new Error('host "h1" unreachable')) };
    await expect(saveTerminalPaste({ buffer: PNG, mimeType: 'image/png', hostId: 'h1' }, { hostPool: { get: () => agent } }))
      .rejects.toMatchObject({ status: 502 });
  });
});

describe('POST /api/terminal/paste-image', () => {
  let server, baseUrl, hostPool, agent;

  beforeEach((done) => {
    agent = { request: jest.fn().mockResolvedValue({ ok: true, path: '/tmp/eve-paste-1-ab.png' }) };
    hostPool = { get: jest.fn((id) => (id === 'h1' ? agent : null)), disconnect: jest.fn() };
    const app = express();
    app.use(express.json());
    registerRoutes(app, {
      authService: { isEnrolled: () => true, validateSession: (t) => t === 'good' },
      trustedNetwork: { isTrusted: () => false },
      relayTransport: { fetch: jest.fn(), fetchRaw: jest.fn() },
      hostPool,
      log: null,
    });
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => { server.close(done); });

  const post = (query, headers, body = PNG) => fetch(`${baseUrl}/api/terminal/paste-image${query}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', ...headers }, body,
  });

  it('401s without a session token', async () => {
    const res = await post('?host=h1', {});
    expect(res.status).toBe(401);
    expect(agent.request).not.toHaveBeenCalled();
  });

  it('writes a host paste through the pool and returns its path', async () => {
    const res = await post('?host=h1', { 'x-session-token': 'good' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: '/tmp/eve-paste-1-ab.png' });
    expect(Buffer.from(agent.request.mock.calls[0][1].data, 'base64')).toEqual(PNG);
  });

  it('writes a console paste locally when no host is given', async () => {
    const res = await post('', { 'x-session-token': 'good' });
    expect(res.status).toBe(200);
    const { path: full } = await res.json();
    try {
      expect(path.dirname(full)).toBe(os.tmpdir());
      expect(fs.readFileSync(full)).toEqual(PNG);
    } finally {
      fs.rmSync(full, { force: true });
    }
  });

  it('refuses an unsupported image type and an unknown host', async () => {
    const svg = await post('?host=h1', { 'x-session-token': 'good', 'Content-Type': 'image/svg+xml' }, '<svg/>');
    expect(svg.status).toBe(415);
    const unknown = await post('?host=nope', { 'x-session-token': 'good' });
    expect(unknown.status).toBe(404);
  });
});

describe('TerminalManager image paste', () => {
  const imageFilesFrom = TerminalManager.prototype._imageFilesFrom;
  const pasteImages = TerminalManager.prototype._pasteImages;

  const fileItem = (type) => ({ kind: 'file', type, getAsFile: () => ({ type, name: `f.${type}` }) });

  it('picks only image files out of a clipboard or drop', () => {
    const items = [fileItem('image/png'), { kind: 'string', type: 'text/plain' }, fileItem('application/pdf')];
    expect(imageFilesFrom({ items }).map((f) => f.type)).toEqual(['image/png']);
    expect(imageFilesFrom(null)).toEqual([]);
  });

  function ctx({ host = null, pasteTerminalImage }) {
    const terminal = { term: { paste: jest.fn() }, host, exited: false };
    return {
      terminal,
      self: {
        terminals: new Map([['t1', terminal]]),
        app: { api: { pasteTerminalImage }, messageRenderer: { appendSystemMessage: jest.fn() } },
        log: { error: jest.fn() },
      },
    };
  }

  it('uploads to the terminal\'s host and pastes the returned paths as text', async () => {
    const pasteTerminalImage = jest.fn()
      .mockResolvedValueOnce({ path: '/tmp/a.png' })
      .mockResolvedValueOnce({ path: '/tmp/b.png' });
    const { self, terminal } = ctx({ host: { id: 'h1', name: 'box' }, pasteTerminalImage });
    await pasteImages.call(self, 't1', [{ type: 'image/png' }, { type: 'image/png' }]);
    expect(pasteTerminalImage).toHaveBeenCalledWith({ type: 'image/png' }, 'h1');
    expect(terminal.term.paste).toHaveBeenCalledWith('/tmp/a.png /tmp/b.png');
  });

  it('reports a failed upload and pastes nothing', async () => {
    const { self, terminal } = ctx({ pasteTerminalImage: jest.fn().mockRejectedValue(new Error('Unknown host: h1')) });
    await pasteImages.call(self, 't1', [{ type: 'image/png' }]);
    expect(terminal.term.paste).not.toHaveBeenCalled();
    expect(self.app.messageRenderer.appendSystemMessage).toHaveBeenCalledWith('Image paste failed: Unknown host: h1', 'error');
  });

  it('drops the paste if the tab closed mid-upload', async () => {
    const { self, terminal } = ctx({
      pasteTerminalImage: jest.fn(async () => { self.terminals.delete('t1'); return { path: '/tmp/a.png' }; }),
    });
    await pasteImages.call(self, 't1', [{ type: 'image/png' }]);
    expect(terminal.term.paste).not.toHaveBeenCalled();
  });
});
