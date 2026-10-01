const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromiumExecutable, chromiumLaunchOptions } = require('../helpers/chromium-path');

describe('chromium-path', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-chromium-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('leaves Playwright\'s pinned browser alone when nothing is set', () => {
    expect(chromiumExecutable({})).toBeUndefined();
    expect(chromiumLaunchOptions({})).toEqual({});
  });

  it('EVE_CHROMIUM_PATH wins over an unversioned binary', () => {
    fs.writeFileSync(path.join(dir, 'chromium'), '');
    expect(chromiumExecutable({ EVE_CHROMIUM_PATH: '/x/chrome', PLAYWRIGHT_BROWSERS_PATH: dir })).toBe('/x/chrome');
  });

  it('uses an unversioned chromium file under PLAYWRIGHT_BROWSERS_PATH', () => {
    const bin = path.join(dir, 'chromium');
    fs.writeFileSync(bin, '');
    expect(chromiumLaunchOptions({ PLAYWRIGHT_BROWSERS_PATH: dir })).toEqual({ executablePath: bin });
  });

  it('ignores a versioned chromium-NNNN directory and a chromium directory', () => {
    fs.mkdirSync(path.join(dir, 'chromium-1194'));
    expect(chromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: dir })).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'chromium'));
    expect(chromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: dir })).toBeUndefined();
  });

  it('accepts a symlink to the binary (the cloud image layout)', () => {
    const real = path.join(dir, 'real-chrome');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, path.join(dir, 'chromium'));
    expect(chromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: dir })).toBe(path.join(dir, 'chromium'));
  });
});
