// Images pasted into a terminal pane: saved to a temp file where the terminal
// runs (eve's own tmpdir for a console terminal, /tmp on an SSH host via the
// agent's `pastetmp` op) and the path handed back to the pane.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveTerminalPaste, pasteFileName, MAX_PASTE_BYTES } = require('../../terminal-paste');
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

  it('sends a host paste through the file client and returns the host path', async () => {
    const files = { pasteToHost: jest.fn().mockResolvedValue('/tmp/eve-paste-x.png') };
    const full = await saveTerminalPaste({ buffer: PNG, mimeType: 'image/png', hostId: 'h1' }, { files, localDir: dir });
    expect(full).toBe('/tmp/eve-paste-x.png');
    const [hostId, name, buffer] = files.pasteToHost.mock.calls[0];
    expect(hostId).toBe('h1');
    expect(name).toMatch(/^eve-paste-\d+-[0-9a-f]+\.png$/);
    expect(buffer).toEqual(PNG);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('404s an unknown host and 502s any other host failure', async () => {
    const gone = { pasteToHost: jest.fn().mockRejectedValue(Object.assign(new Error('host not found'), { code: 'HOST_NOT_FOUND' })) };
    await expect(saveTerminalPaste({ buffer: PNG, mimeType: 'image/png', hostId: 'gone' }, { files: gone }))
      .rejects.toMatchObject({ status: 404 });
    const down = { pasteToHost: jest.fn().mockRejectedValue(new Error('host "h1" unreachable')) };
    await expect(saveTerminalPaste({ buffer: PNG, mimeType: 'image/png', hostId: 'h1' }, { files: down }))
      .rejects.toMatchObject({ status: 502 });
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
