const { makeRig } = require('./helpers/file-watcher-rig');

// FileWatcher turns relay's change stream into the browser's file_changed,
// dir_changed, git_changed and watch_error frames. The client's events are
// emitted synchronously and every wait is a jest fake timer, so nothing here
// touches a socket or a disk.
describe('FileWatcher', () => {
  const PROJECT_ID = 'test-project';
  const PROJECT = { id: PROJECT_ID, path: '/work/acme' };
  let rig;

  beforeEach(() => {
    jest.useFakeTimers();
    rig = makeRig([PROJECT]);
    rig.setFile(PROJECT_ID, 'test.js', 'original');
  });

  afterEach(() => {
    rig.watcher.closeAll();
  });

  const advance = (ms) => jest.advanceTimersByTimeAsync(ms);

  describe('holding a watch on relay', () => {
    it('asks the client for one watch per project however many files are opened', () => {
      rig.watcher.watch(PROJECT_ID, '/a.js');
      rig.watcher.watch(PROJECT_ID, '/b.js');
      rig.watcher.watchProject(PROJECT_ID);
      expect(rig.client.watch.mock.calls).toEqual([[PROJECT_ID]]);
    });

    it('asks for no watch on an unknown project', () => {
      rig.watcher.watch('nonexistent', '/test.js');
      rig.watcher.watchProject('nonexistent');
      expect(rig.client.watch).not.toHaveBeenCalled();
    });

    it('keeps the project watch when a file is unwatched, for the tree', () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.watcher.unwatch(PROJECT_ID, '/test.js');
      expect(rig.client.unwatch).not.toHaveBeenCalled();
    });

    it('unwatch is safe for files that were never watched', () => {
      expect(() => rig.watcher.unwatch(PROJECT_ID, '/nope.js')).not.toThrow();
    });

    it('closeAll lets go of the project watch and stops listening', async () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.watcher.closeAll();
      expect(rig.client.unwatch.mock.calls).toEqual([[PROJECT_ID]]);
      for (const e of ['fs_event', 'watch_ok', 'watch_error']) expect(rig.client.listenerCount(e)).toBe(0);
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(1000);
      expect(rig.ws.sent).toEqual([]);
    });

    it('closeAll is safe to call twice', () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.watcher.closeAll();
      expect(() => rig.watcher.closeAll()).not.toThrow();
    });

    it('drops events for a project this connection does not watch', async () => {
      rig.emitFs(PROJECT_ID, 'newfile.js', 'rename');
      await advance(1000);
      expect(rig.ws.sent).toEqual([]);
    });
  });

  describe('file_changed', () => {
    it('pushes the content of an open text file 100 ms after the event', async () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(99);
      expect(rig.ws.sent).toEqual([]);
      await advance(1);
      expect(rig.ws.sent).toEqual([
        { type: 'file_changed', projectId: PROJECT_ID, path: '/test.js', content: 'original', size: 8 },
      ]);
    });

    it('treats an atomic-save rename of an open file as a content change', async () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.emitFs(PROJECT_ID, 'test.js', 'rename');
      await advance(100);
      expect(rig.framesOf('file_changed')).toEqual([
        expect.objectContaining({ path: '/test.js', content: 'original' }),
      ]);
    });

    it('coalesces rapid events into one push', async () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(60);
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(60);
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(100);
      expect(rig.framesOf('file_changed')).toHaveLength(1);
    });

    it('echoes the client path verbatim', async () => {
      rig.setFile(PROJECT_ID, 'src/x.js', 'x');
      rig.watcher.watch(PROJECT_ID, '/src/x.js');
      rig.emitFs(PROJECT_ID, 'src/x.js', 'change');
      await advance(100);
      expect(rig.framesOf('file_changed')[0].path).toBe('/src/x.js');
    });

    it('a binary watch notifies without content', async () => {
      rig.setFile(PROJECT_ID, 'doc.pdf', 'pretend-pdf-bytes');
      rig.watcher.watch(PROJECT_ID, '/doc.pdf', { binary: true });
      rig.emitFs(PROJECT_ID, 'doc.pdf', 'change');
      await advance(100);
      expect(rig.framesOf('file_changed')).toEqual([{ type: 'file_changed', projectId: PROJECT_ID, path: '/doc.pdf' }]);
    });

    it('pushes nothing for a file that was not opened', async () => {
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(1000);
      expect(rig.framesOf('file_changed')).toEqual([]);
    });

    it('pushes nothing for a file that no longer reads', async () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.removeEntry(PROJECT_ID, 'test.js');
      rig.emitFs(PROJECT_ID, 'test.js', 'rename');
      await advance(1000);
      expect(rig.framesOf('file_changed')).toEqual([]);
    });
  });

  describe('dir_changed', () => {
    it('is sent for the parent of a created or removed entry, 200 ms after the event', async () => {
      rig.setDir(PROJECT_ID, 'branding');
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, 'newfile.js', 'rename');
      rig.emitFs(PROJECT_ID, 'branding/logo.svg', 'rename');
      await advance(199);
      expect(rig.framesOf('dir_changed')).toEqual([]);
      await advance(1);
      expect(rig.framesOf('dir_changed')).toEqual(expect.arrayContaining([
        { type: 'dir_changed', projectId: PROJECT_ID, path: '/' },
        { type: 'dir_changed', projectId: PROJECT_ID, path: '/branding' },
      ]));
      expect(rig.framesOf('dir_changed')).toHaveLength(2);
    });

    it('coalesces a burst in one directory into one frame', async () => {
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, 'a.js', 'rename');
      await advance(100);
      rig.emitFs(PROJECT_ID, 'b.js', 'rename');
      await advance(199);
      expect(rig.framesOf('dir_changed')).toEqual([]);
      await advance(1);
      expect(rig.framesOf('dir_changed')).toEqual([{ type: 'dir_changed', projectId: PROJECT_ID, path: '/' }]);
    });

    it('is not sent for a content-only change', async () => {
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(1000);
      expect(rig.framesOf('dir_changed')).toEqual([]);
    });

    it('is not sent for a directory that no longer exists', async () => {
      // The child-removal events fired while deleting a whole directory.
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, 'deleted-dir/child.js', 'rename');
      await advance(1000);
      expect(rig.framesOf('dir_changed')).toEqual([]);
    });

    it('is not sent when the parent path is a file', async () => {
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, 'test.js/child', 'rename');
      await advance(1000);
      expect(rig.framesOf('dir_changed')).toEqual([]);
    });
  });

  describe('ignored paths', () => {
    it.each([
      ['.git/HEAD'],
      ['node_modules/foo/index.js'],
      ['.DS_Store'],
      ['src/node_modules/pkg/a.js'],
    ])('%s reaches neither the tree nor an open file', async (p) => {
      rig.setDir(PROJECT_ID, p.split('/').slice(0, -1).join('/'));
      rig.setFile(PROJECT_ID, p, 'x');
      rig.watcher.watchProject(PROJECT_ID);
      rig.watcher.watch(PROJECT_ID, `/${p}`);
      rig.emitFs(PROJECT_ID, p, 'rename');
      await advance(1000);
      expect(rig.framesOf('dir_changed')).toEqual([]);
      expect(rig.framesOf('file_changed')).toEqual([]);
    });
  });

  describe('a watch relay cannot hold', () => {
    it('tells the browser once, with relay\'s code and no path', async () => {
      rig.watcher.watchProject(PROJECT_ID);
      rig.client.emit('watch_error', { projectId: PROJECT_ID, code: 'ENOENT', error: `no such folder ${PROJECT.path}` });
      expect(rig.framesOf('watch_error')).toEqual([{ type: 'watch_error', projectId: PROJECT_ID, reason: 'ENOENT' }]);
      expect(JSON.stringify(rig.ws.sent)).not.toContain(PROJECT.path);
    });

    it('stays quiet on repeats until the next watch_ok, and asks relay again on the next list', () => {
      rig.watcher.watchProject(PROJECT_ID);
      rig.client.emit('watch_error', { projectId: PROJECT_ID, code: 'ENOENT', error: 'x' });
      rig.watcher.watchProject(PROJECT_ID); // list_directory retries on every call
      rig.client.emit('watch_error', { projectId: PROJECT_ID, code: 'ENOENT', error: 'x' });
      expect(rig.framesOf('watch_error')).toHaveLength(1);
      expect(rig.client.watch).toHaveBeenCalledTimes(2);

      rig.client.emit('watch_ok', { projectId: PROJECT_ID });
      rig.watcher.watchProject(PROJECT_ID);
      rig.client.emit('watch_error', { projectId: PROJECT_ID, code: 'HOST_UNREACHABLE', error: 'x' });
      expect(rig.framesOf('watch_error').map((f) => f.reason)).toEqual(['ENOENT', 'HOST_UNREACHABLE']);
    });

    it('ignores a watch_error for a project this connection does not hold', () => {
      rig.client.emit('watch_error', { projectId: 'other', code: 'ENOENT', error: 'x' });
      expect(rig.ws.sent).toEqual([]);
    });
  });

  // Changes panel refresh (docs/design-git-changes.md, "Refresh").
  describe('git_changed attribution', () => {
    it.each([
      ['a.js', '/'],
      ['README.md', '/'],
      ['feat-login/src/auth.js', '/feat-login'],
      ['feat-login/x', '/feat-login'],
      ['feat-login\\src\\auth.js', '/feat-login'],
      ['/leading/slash.js', '/leading'],
      ['.git/index', '*'],
      ['.git/HEAD', '*'],
      ['.git/ORIG_HEAD', '*'],
      ['.git/MERGE_HEAD', '*'],
      ['main/.git/index', '*'],
      ['.git/worktrees/feat-login/index', '*'],
      ['.git/worktrees/feat-login/HEAD', '*'],
      ['.git', null],
      ['feat-login/.git', null], // a worktree's gitlink file
      ['.git/config', null],
      ['.git/FETCH_HEAD', null],
      ['.git/objects/ab/cdef0123', null],
      ['.git/refs/heads/main', null],
      ['.git/index.lock', null],
      ['node_modules/pkg/index.js', null],
      ['src/node_modules/pkg/index', null],
      ['.DS_Store', null],
      ['src/.DS_Store', null],
    ])('%j -> %j', async (p, expected) => {
      rig.watcher.watchProject(PROJECT_ID);
      rig.emitFs(PROJECT_ID, p, 'change');
      await advance(500);
      const repos = rig.framesOf('git_changed').map((f) => f.repo);
      expect(repos).toEqual(expected === null ? [] : [expected]);
    });
  });

  describe('git_changed debounce', () => {
    beforeEach(() => rig.watcher.watchProject(PROJECT_ID));

    it('coalesces a burst for one repo into one push, 500 ms after the last event', async () => {
      rig.emitFs(PROJECT_ID, 'src/a.js', 'change');
      await advance(300);
      rig.emitFs(PROJECT_ID, 'src/b.js', 'change');
      await advance(499);
      expect(rig.framesOf('git_changed')).toEqual([]);
      await advance(1);
      expect(rig.framesOf('git_changed')).toEqual([{ type: 'git_changed', projectId: PROJECT_ID, repo: '/src' }]);
    });

    it('debounces each repo independently', async () => {
      rig.emitFs(PROJECT_ID, 'a/x.js', 'change');
      rig.emitFs(PROJECT_ID, 'b/y.js', 'change');
      rig.emitFs(PROJECT_ID, '.git/index', 'change');
      await advance(500);
      expect(rig.framesOf('git_changed').map((m) => m.repo).sort()).toEqual(['*', '/a', '/b']);
    });

    it("still fires for eve's own writes: an editor save changes git status", async () => {
      rig.watcher.watch(PROJECT_ID, '/test.js');
      rig.watcher.markSelfWrite(rig.selfKey(PROJECT_ID, '/test.js'), 'original');
      rig.emitFs(PROJECT_ID, 'test.js', 'change');
      await advance(500);
      expect(rig.framesOf('git_changed')).toEqual([{ type: 'git_changed', projectId: PROJECT_ID, repo: '/' }]);
    });

    it('closeAll cancels a push still pending', async () => {
      rig.emitFs(PROJECT_ID, 'src/a.js', 'change');
      rig.emitFs(PROJECT_ID, '.git/HEAD', 'change');
      rig.watcher.closeAll();
      await advance(1000);
      expect(rig.framesOf('git_changed')).toEqual([]);
    });

    it("keeps its timers unref'd so a leak can't hold the worker open", () => {
      const real = global.setTimeout;
      const made = [];
      jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
        const t = real(fn, ms, ...rest);
        if (ms === 500) made.push(t);
        return t;
      });
      rig.emitFs(PROJECT_ID, 'src/a.js', 'change');
      expect(made.length).toBeGreaterThan(0);
      for (const t of made) expect(t.hasRef()).toBe(false);
      jest.restoreAllMocks();
    });
  });
});
