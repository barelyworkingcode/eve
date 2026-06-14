const os = require('os');
const fs = require('fs');
const path = require('path');
const FileService = require('../../file-service');
const FileWatcher = require('../../file-watcher');

describe('FileWatcher', () => {
  let tmpDir, fileService, mockWs, watcher;

  const PROJECT_ID = 'test-project';
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function createMockWs() {
    return {
      sent: [],
      send(data) { this.sent.push(JSON.parse(data)); }
    };
  }

  function root() {
    return fs.realpathSync(tmpDir);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-fw-test-'));
    fs.writeFileSync(path.join(tmpDir, 'test.js'), 'original', 'utf8');

    fileService = new FileService();
    mockWs = createMockWs();

    const resolveProject = (id) => {
      if (id === PROJECT_ID) return { id: PROJECT_ID, path: tmpDir };
      return undefined;
    };

    watcher = new FileWatcher(mockWs, fileService, resolveProject);
  });

  afterEach(() => {
    watcher.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('watch/unwatch registration', () => {
    it('starts a project watcher and records the open file', () => {
      watcher.watch(PROJECT_ID, '/test.js');
      expect(watcher.projectWatchers.has(PROJECT_ID)).toBe(true);
      expect(watcher.watchedFiles.get(PROJECT_ID).has('test.js')).toBe(true);
    });

    it('echoes the client path verbatim and records the binary flag', () => {
      watcher.watch(PROJECT_ID, '/test.js', { binary: true });
      const entry = watcher.watchedFiles.get(PROJECT_ID).get('test.js');
      expect(entry).toMatchObject({ binary: true, clientPath: '/test.js' });
    });

    it('does not duplicate the project watcher for repeated watches', () => {
      watcher.watch(PROJECT_ID, '/a.js');
      const first = watcher.projectWatchers.get(PROJECT_ID);
      watcher.watch(PROJECT_ID, '/b.js');
      expect(watcher.projectWatchers.get(PROJECT_ID)).toBe(first);
      expect(watcher.watchedFiles.get(PROJECT_ID).size).toBe(2);
    });

    it('ignores unknown project IDs (both watch and watchProject)', () => {
      watcher.watch('nonexistent', '/test.js');
      watcher.watchProject('nonexistent');
      expect(watcher.projectWatchers.size).toBe(0);
    });

    it('removes the file on unwatch but keeps the project watcher for the tree', () => {
      watcher.watch(PROJECT_ID, '/test.js');
      watcher.unwatch(PROJECT_ID, '/test.js');
      expect(watcher.watchedFiles.has(PROJECT_ID)).toBe(false);
      expect(watcher.projectWatchers.has(PROJECT_ID)).toBe(true);
    });

    it('unwatch is safe for unwatched files', () => {
      expect(() => watcher.unwatch(PROJECT_ID, '/nope.js')).not.toThrow();
    });
  });

  describe('watchProject', () => {
    it('starts a recursive watcher without any open file', () => {
      watcher.watchProject(PROJECT_ID);
      expect(watcher.projectWatchers.has(PROJECT_ID)).toBe(true);
      expect(watcher.watchedFiles.has(PROJECT_ID)).toBe(false);
    });
    // (unknown-projectId guard for watchProject merged into the watch/unwatch block above)
  });

  describe('markSelfWrite', () => {
    // The "adds the path" half is covered by the first assertion below, so this
    // single test pins both the mark and its TTL auto-clear.
    it('marks a path then auto-clears it after the TTL', () => {
      jest.useFakeTimers();
      const absPath = path.join(tmpDir, 'test.js');
      watcher.markSelfWrite(absPath);
      expect(watcher.selfWrites.has(absPath)).toBe(true);
      jest.advanceTimersByTime(1000);
      expect(watcher.selfWrites.has(absPath)).toBe(false);
      jest.useRealTimers();
    });
  });

  // _onFsEvent is the deterministic core: it is driven directly here so the
  // tests don't depend on fs.watch delivery timing. Open files are registered
  // without starting a real watcher (which would replay FSEvents history and
  // make assertions non-deterministic). A real-fs integration test below
  // confirms the wiring actually fires end to end.
  describe('_onFsEvent', () => {
    // Register an open file the way watch() would, minus the real fs watcher.
    function registerOpenFile(clientPath, opts = {}) {
      const canon = clientPath.replace(/^\/+/, '');
      if (!watcher.watchedFiles.has(PROJECT_ID)) watcher.watchedFiles.set(PROJECT_ID, new Map());
      watcher.watchedFiles.get(PROJECT_ID).set(canon, { binary: !!opts.binary, clientPath });
    }

    it('pushes file_changed with content for an open text file', async () => {
      registerOpenFile('/test.js');
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'test.js');
      expect(mockWs.sent.length).toBe(0); // debounced
      await delay(200);
      expect(mockWs.sent).toContainEqual({
        type: 'file_changed', projectId: PROJECT_ID, path: '/test.js', content: 'original', size: 8
      });
    });

    it('treats atomic-save renames of an open file as content changes', async () => {
      registerOpenFile('/test.js');
      watcher._onFsEvent(PROJECT_ID, root(), 'rename', 'test.js');
      await delay(300);
      const fileMsg = mockWs.sent.find((m) => m.type === 'file_changed');
      expect(fileMsg).toMatchObject({ path: '/test.js', content: 'original' });
    });

    it('coalesces multiple rapid events into one push', async () => {
      registerOpenFile('/test.js');
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'test.js');
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'test.js');
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'test.js');
      await delay(200);
      expect(mockWs.sent.filter((m) => m.type === 'file_changed').length).toBe(1);
    });

    it('skips the echo for self-written files', async () => {
      registerOpenFile('/test.js');
      // Mark the path the same way the write path does (validatePath), matching
      // how _pushFile derives the self-write key.
      watcher.markSelfWrite(fileService.validatePath(tmpDir, '/test.js'));
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'test.js');
      await delay(200);
      expect(mockWs.sent.find((m) => m.type === 'file_changed')).toBeUndefined();
    });

    it('binary watches notify only, no content', async () => {
      fs.writeFileSync(path.join(tmpDir, 'doc.pdf'), 'pretend-pdf-bytes');
      registerOpenFile('/doc.pdf', { binary: true });
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'doc.pdf');
      await delay(200);
      const msg = mockWs.sent.find((m) => m.type === 'file_changed');
      expect(msg).toEqual({ type: 'file_changed', projectId: PROJECT_ID, path: '/doc.pdf' });
    });

    it('emits dir_changed for the parent on a structural (rename) event', async () => {
      watcher._onFsEvent(PROJECT_ID, root(), 'rename', 'newfile.js');
      await delay(300);
      expect(mockWs.sent).toContainEqual({ type: 'dir_changed', projectId: PROJECT_ID, path: '/' });
    });

    it('maps a nested path to its parent directory', async () => {
      fs.mkdirSync(path.join(tmpDir, 'branding'));
      watcher._onFsEvent(PROJECT_ID, root(), 'rename', 'branding/logo.svg');
      await delay(300);
      expect(mockWs.sent).toContainEqual({ type: 'dir_changed', projectId: PROJECT_ID, path: '/branding' });
    });

    it('does not emit dir_changed for content-only changes', async () => {
      watcher._onFsEvent(PROJECT_ID, root(), 'change', 'test.js');
      await delay(300);
      expect(mockWs.sent.find((m) => m.type === 'dir_changed')).toBeUndefined();
    });

    it('skips dir_changed for a directory that no longer exists', async () => {
      // Simulates the child-removal events fired while deleting a whole dir:
      // the parent path is already gone, so no refresh should be requested.
      watcher._onFsEvent(PROJECT_ID, root(), 'rename', 'deleted-dir/child.js');
      await delay(300);
      expect(mockWs.sent.find((m) => m.type === 'dir_changed')).toBeUndefined();
    });
  });

  describe('ignored paths', () => {
    it('drops events inside .git / node_modules and .DS_Store', () => {
      expect(watcher._isIgnored('.git/HEAD')).toBe(true);
      expect(watcher._isIgnored('node_modules/foo/index.js')).toBe(true);
      expect(watcher._isIgnored('.DS_Store')).toBe(true);
      expect(watcher._isIgnored('src/app.js')).toBe(false);
    });
  });

  describe('end-to-end (real fs.watch)', () => {
    // Recursive fs.watch is FSEvents-backed on macOS. Generous delays absorb
    // coalescing latency; skipped automatically where recursive watch is
    // unsupported (the watcher silently no-ops there).
    it('detects a new file appearing in the tree', async () => {
      watcher.watchProject(PROJECT_ID);
      if (!watcher.projectWatchers.has(PROJECT_ID)) return; // unsupported platform
      await delay(50);
      fs.writeFileSync(path.join(tmpDir, 'fresh.txt'), 'hi', 'utf8');
      await delay(600);
      expect(mockWs.sent.some((m) => m.type === 'dir_changed' && m.path === '/')).toBe(true);
    });

    it('pushes content when an open file changes on disk', async () => {
      watcher.watch(PROJECT_ID, '/test.js');
      if (!watcher.projectWatchers.has(PROJECT_ID)) return; // unsupported platform
      await delay(50);
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'changed-on-disk', 'utf8');
      await delay(600);
      // FSEvents may replay the recent create first, so assert that *some*
      // push carried the new content rather than relying on ordering.
      const got = mockWs.sent.some((m) => m.type === 'file_changed' && m.path === '/test.js' && m.content === 'changed-on-disk');
      expect(got).toBe(true);
    });
  });

  describe('closeAll', () => {
    it('closes watchers and clears all state', () => {
      watcher.watch(PROJECT_ID, '/test.js');
      watcher.markSelfWrite(path.join(tmpDir, 'test.js'));
      expect(watcher.projectWatchers.size).toBe(1);

      watcher.closeAll();

      expect(watcher.projectWatchers.size).toBe(0);
      expect(watcher.watchedFiles.size).toBe(0);
      expect(watcher.selfWrites.size).toBe(0);
    });

    it('is safe to call multiple times', () => {
      watcher.watch(PROJECT_ID, '/test.js');
      watcher.closeAll();
      expect(() => watcher.closeAll()).not.toThrow();
    });
  });
});
