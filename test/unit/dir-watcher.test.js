const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDirWatcher } = require('../../dir-watcher');
const FileWatcher = require('../../file-watcher');

const { shouldWatchDir, watchBackend } = FileWatcher;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('dir-watcher (pruned inotify-style backend)', () => {
  let root;
  let watcher;
  let events;

  const write = (rel, content = 'x') => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const start = (opts = {}) => {
    events = [];
    watcher = createDirWatcher(root, { shouldWatch: shouldWatchDir, onEvent: (t, p) => events.push(`${t}:${p}`), ...opts });
    return delay(100); // initial scan attaches the subtree asynchronously
  };
  async function until(pred, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; events=${JSON.stringify(events)}`);
      await delay(10);
    }
  }
  const saw = (p) => events.some((e) => e.endsWith(`:${p}`));

  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dw-'))); });
  afterEach(() => {
    if (watcher) watcher.close();
    watcher = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never enters an ignored tree, so it costs no watches', async () => {
    write('src/a.js');
    write('node_modules/pkg/deep/er/index.js');
    write('.git/objects/ab/cdef');
    write('.git/refs/heads/main');
    write('.git/HEAD');
    await start();
    // root, src, .git
    expect(watcher.watchedDirectories).toBe(3);
  });

  it('reports a create, an in-place write and a delete in a watched directory', async () => {
    write('src/a.js');
    await start();
    write('src/b.js');
    await until(() => saw('src/b.js'));
    events.length = 0;
    fs.appendFileSync(path.join(root, 'src/a.js'), 'more');
    // macOS fs.watch reports an in-place write as 'rename'; the pruned backend
    // is only selected on Linux, where it is 'change'.
    const inPlace = process.platform === 'linux' ? 'change' : 'rename';
    await until(() => events.includes(`${inPlace}:src/a.js`));
    fs.rmSync(path.join(root, 'src/b.js'));
    await until(() => events.includes('rename:src/b.js'));
  });

  it('reports files created the instant their directory appears', async () => {
    await start();
    fs.mkdirSync(path.join(root, 'd1/d2/d3'), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, 'd1/d2/d3', `f${i}`), 'x');
    await until(() => [0, 1, 2, 3, 4].every((i) => saw(`d1/d2/d3/f${i}`)));
    expect(watcher.watchedDirectories).toBe(4);
  });

  it('keeps reporting inside a directory created after the start', async () => {
    await start();
    fs.mkdirSync(path.join(root, 'later'));
    await until(() => watcher.watchedDirectories === 2);
    events.length = 0;
    write('later/file.txt');
    await until(() => saw('later/file.txt'));
  });

  it('drops the watches under a removed directory', async () => {
    write('gone/inner/x.txt');
    await start();
    expect(watcher.watchedDirectories).toBe(3);
    fs.rmSync(path.join(root, 'gone'), { recursive: true });
    await until(() => watcher.watchedDirectories === 1);
  });

  it('follows a moved directory to its new name', async () => {
    write('old/x.txt');
    await start();
    fs.renameSync(path.join(root, 'old'), path.join(root, 'new'));
    await until(() => watcher.watchedDirectories === 2 && saw('new/x.txt'));
    events.length = 0;
    write('new/y.txt');
    await until(() => saw('new/y.txt'));
  });

  it('does not follow a symlinked directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dw-out-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'link'));
      await start();
      expect(watcher.watchedDirectories).toBe(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('delivers .git/index and .git/HEAD writes for the git refresh', async () => {
    write('.git/HEAD', 'ref: refs/heads/main');
    await start();
    fs.writeFileSync(path.join(root, '.git/index'), 'i');
    fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/other');
    await until(() => saw('.git/index') && saw('.git/HEAD'));
  });

  it('throws from the constructor when the root cannot be watched', () => {
    expect(() => createDirWatcher(path.join(root, 'missing'), { onEvent: () => {} })).toThrow(/ENOENT/);
  });

  it('close() stops all events and releases every handle', async () => {
    write('a/b.txt');
    await start();
    events.length = 0; // pre-start events may replay inside start(); only post-close matters
    watcher.close();
    expect(watcher.watchedDirectories).toBe(0);
    write('a/c.txt');
    await delay(150);
    expect(events).toEqual([]);
  });

  it('close() while the first scan is in flight leaves nothing attached', async () => {
    for (let i = 0; i < 20; i++) write(`d${i}/f`);
    events = [];
    watcher = createDirWatcher(root, { shouldWatch: shouldWatchDir, onEvent: () => {} });
    watcher.close();
    await delay(100);
    expect(watcher.watchedDirectories).toBe(0);
  });
});

describe('shouldWatchDir', () => {
  it.each([
    ['src', true],
    ['src/deep/er', true],
    ['node_modules', false],
    ['src/node_modules/pkg', false],
    ['.git', true],
    ['.git/objects', false],
    ['.git/refs/heads', false],
    ['.git/worktrees', true],
    ['.git/worktrees/feat', true],
    ['.git/worktrees/feat/logs', false],
    ['feat-login/.git', true],
    ['feat-login/.git/objects', false],
    ['node_modules/pkg/.git', false],
  ])('%s -> %s', (rel, expected) => {
    expect(shouldWatchDir(rel)).toBe(expected);
  });
});

describe('watchBackend', () => {
  it.each([
    [{}, 'linux', 'pruned'],
    [{}, 'darwin', 'native'],
    [{}, 'win32', 'native'],
    [{ EVE_WATCH_BACKEND: 'native' }, 'linux', 'native'],
    [{ EVE_WATCH_BACKEND: 'pruned' }, 'darwin', 'pruned'],
    [{ EVE_WATCH_BACKEND: 'bogus' }, 'linux', 'pruned'],
  ])('%j on %s -> %s', (env, platform, expected) => {
    expect(watchBackend(env, platform)).toBe(expected);
  });
});
