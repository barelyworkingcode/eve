const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDirWatcher } = require('../../dir-watcher');
const FileWatcher = require('../../file-watcher');

const { shouldWatchDir, watchBackend } = FileWatcher;

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
    // ready: the initial scan attached the subtree. On macOS the stream behind
    // each handle can go live a moment later and drops writes made before it,
    // so probe every watched directory until each reports, then clear.
    return watcher.ready.then(() => probeLive());
  };
  // No probe: for cases that only count handles after the initial scan.
  const startBare = () => {
    events = [];
    watcher = createDirWatcher(root, { shouldWatch: shouldWatchDir, onEvent: (t, p) => events.push(`${t}:${p}`) });
    return watcher.ready;
  };
  function watchedDirs(rel = '') {
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    const out = [rel];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && shouldWatchDir(child)) out.push(...watchedDirs(child));
    }
    return out;
  }
  async function probeLive() {
    const probes = watchedDirs().map((d) => (d ? `${d}/.probe` : '.probe'));
    for (const probe of probes) {
      let n = 0;
      await until(() => saw(probe), 3000, () => fs.writeFileSync(path.join(root, ...probe.split('/')), String(n++)));
    }
    events.length = 0;
  }
  async function until(pred, ms = 3000, nudge = null) {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (nudge) nudge();
      if (Date.now() > deadline) throw new Error(`timed out; events=${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 10)); // poll step of the bounded until
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
    await startBare();
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
    // The pruned backend ships on Linux, where an in-place write is exactly
    // 'change'. On macOS FSEvents reports it as 'change' or 'rename' depending
    // on file-system load; both mean "content changed".
    await until(() => (process.platform === 'linux'
      ? events.includes('change:src/a.js')
      : events.includes('change:src/a.js') || events.includes('rename:src/a.js')));
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

  // Linux only, for two reasons. On macOS, closing one fs.watch handle restarts
  // the shared FSEvents stream and can drop pending events; observed under
  // churn: ["rename:gone/inner/x.txt","rename:gone/inner/inner","rename:gone/inner"],
  // with the root `rename:gone` never delivered. And the pruned inotify-style
  // backend ships only on Linux; macOS uses the native backend, which
  // file-watcher.test.js covers.
  (process.platform === 'linux' ? it : it.skip)('drops the watches under a removed directory', async () => {
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
      await startBare();
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
    const realWatch = fs.watch;
    const captured = [];
    const spy = jest.spyOn(fs, 'watch').mockImplementation((...args) => {
      const handle = realWatch.apply(fs, args);
      const closeSpy = jest.spyOn(handle, 'close');
      captured.push({ closeSpy, listener: args[args.length - 1] });
      return handle;
    });
    try {
      await start();
      expect(captured.length).toBe(2);
      events.length = 0;
      watcher.close();
      expect(watcher.watchedDirectories).toBe(0);
      for (const { closeSpy } of captured) expect(closeSpy).toHaveBeenCalled();
      for (const { listener } of captured) listener('rename', 'c.txt');
      expect(events).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('close() while the first scan is in flight leaves nothing attached', async () => {
    for (let i = 0; i < 20; i++) write(`d${i}/f`);
    events = [];
    watcher = createDirWatcher(root, { shouldWatch: shouldWatchDir, onEvent: () => {} });
    watcher.close();
    await watcher.ready;
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
