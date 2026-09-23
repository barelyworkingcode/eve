// Copying text out of a terminal pane while a mouse-reporting TUI (Claude
// Code, tmux) owns the mouse: Option-drag forces a local selection, a finished
// selection is copied, and OSC 52 from the host may write — never read — the
// browser clipboard.
const TerminalManager = require('../../public/terminal-manager');

const proto = TerminalManager.prototype;

function manager() {
  const self = Object.create(proto);
  self.log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  return self;
}

let writeText;
beforeEach(() => {
  writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(global, 'navigator', { value: { clipboard: { writeText } }, configurable: true });
});
afterEach(() => { delete global.navigator; });

describe('clipboard provider (OSC 52)', () => {
  it('lets the host write the clipboard', async () => {
    await manager()._clipboardProvider().writeText('c', 'from tmux');
    expect(writeText).toHaveBeenCalledWith('from tmux');
  });

  it('never lets the host read the clipboard back', () => {
    expect(manager()._clipboardProvider().readText('c')).toBe('');
  });

  it('skips an empty write and swallows a refused one', async () => {
    const self = manager();
    await self._writeClipboard('');
    expect(writeText).not.toHaveBeenCalled();
    writeText.mockRejectedValueOnce(new Error('Document is not focused'));
    await expect(self._writeClipboard('x')).resolves.toBeUndefined();
    expect(self.log.warn).toHaveBeenCalled();
  });
});

describe('copy on select', () => {
  it('copies the selection when there is one, and nothing otherwise', () => {
    const self = manager();
    self._copySelection({ hasSelection: () => false, getSelection: () => 'stale' });
    expect(writeText).not.toHaveBeenCalled();
    self._copySelection({ hasSelection: () => true, getSelection: () => 'picked' });
    expect(writeText).toHaveBeenCalledWith('picked');
  });
});

describe('createXtermInstance', () => {
  function build({ ClipboardAddon }) {
    const self = manager();
    const loaded = [];
    self.Terminal = class {
      constructor(options) { this.options = options; }
      loadAddon(a) { loaded.push(a); }
    };
    self.FitAddon = class {};
    self.WebLinksAddon = class {};
    self.ClipboardAddon = ClipboardAddon;
    self.registerGeneratedImageLinks = () => {};
    self.app = { settings: { get: () => '#000', getTerminalFontStack: () => 'mono', isLight: () => false } };
    const { term } = self.createXtermInstance();
    return { term, loaded };
  }

  it('lets Option-drag force a selection past mouse reporting', () => {
    const { term } = build({ ClipboardAddon: null });
    expect(term.options.macOptionClickForcesSelection).toBe(true);
  });

  it('loads the clipboard addon with the write-only provider when available', () => {
    class ClipboardAddon { constructor(base64, provider) { this.provider = provider; } }
    const { loaded } = build({ ClipboardAddon });
    const addon = loaded.find((a) => a instanceof ClipboardAddon);
    expect(addon).toBeDefined();
    expect(addon.provider.readText('c')).toBe('');
  });
});
