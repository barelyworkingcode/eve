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

    watcher = new FileWatcher(mockWs, () => fileService, resolveProject);
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
  });

  describe('markSelfWrite', () => {
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

  // _onFsEvent is driven directly here so the tests don't depend on fs.watch
  // delivery timing, and open files are registered without a real watcher
  // (which would replay FSEvents history and make assertions non-deterministic).
  // A real-fs integration test below confirms the wiring fires end to end.
  describe('_onFsEvent', () => {
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
  // Changes panel refresh (docs/design-git-changes.md, "Refresh").
  describe('git_changed attribution (_gitRepoFor)', () => {
    it.each([
      ['a.js', '/'],
      ['README.md', '/'],
      ['feat-login/src/auth.js', '/feat-login'],
      ['feat-login/x', '/feat-login'],
      ['feat-login\\src\\auth.js', '/feat-login'], // raw fs.watch name on Windows
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
      ['', null],
      ['/', null],
    ])('%j -> %j', (p, expected) => {
      expect(watcher._gitRepoFor(p)).toBe(expected);
    });
  });

  describe('git_changed debounce', () => {
    const gitFrames = () => mockWs.sent.filter((m) => m.type === 'git_changed');

    it('coalesces a burst for one repo into one push, 500 ms after the last event', () => {
      jest.useFakeTimers();
      watcher._maybeScheduleGitChange(PROJECT_ID, 'src/a.js');
      jest.advanceTimersByTime(300);
      watcher._maybeScheduleGitChange(PROJECT_ID, 'src/b.js');
      jest.advanceTimersByTime(499);
      expect(gitFrames()).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(gitFrames()).toEqual([{ type: 'git_changed', projectId: PROJECT_ID, repo: '/src' }]);
      expect(watcher.gitTimers.size).toBe(0);
    });

    it('debounces each repo independently', () => {
      jest.useFakeTimers();
      watcher._maybeScheduleGitChange(PROJECT_ID, 'a/x.js');
      watcher._maybeScheduleGitChange(PROJECT_ID, 'b/y.js');
      watcher._maybeScheduleGitChange(PROJECT_ID, '.git/index');
      jest.advanceTimersByTime(500);
      expect(gitFrames().map((m) => m.repo).sort()).toEqual(['*', '/a', '/b']);
    });

    it('schedules nothing for paths that cannot change git status', () => {
      jest.useFakeTimers();
      watcher._maybeScheduleGitChange(PROJECT_ID, 'node_modules/x/y.js');
      watcher._maybeScheduleGitChange(PROJECT_ID, '.git/objects/ab/cd');
      watcher._maybeScheduleGitChange(PROJECT_ID, '.DS_Store');
      expect(watcher.gitTimers.size).toBe(0);
      jest.advanceTimersByTime(1000);
      expect(gitFrames()).toEqual([]);
    });

    it("still emits for eve's own writes (an editor save changes git status)", () => {
      jest.useFakeTimers();
      watcher.markSelfWrite(fileService.validatePath(tmpDir, '/test.js'));
      watcher._maybeScheduleGitChange(PROJECT_ID, 'test.js');
      jest.advanceTimersByTime(500);
      expect(gitFrames()).toEqual([{ type: 'git_changed', projectId: PROJECT_ID, repo: '/' }]);
    });

    it('closeAll clears pending git timers', () => {
      jest.useFakeTimers();
      watcher._maybeScheduleGitChange(PROJECT_ID, 'src/a.js');
      watcher._maybeScheduleGitChange(PROJECT_ID, '.git/HEAD');
      expect(watcher.gitTimers.size).toBe(2);
      watcher.closeAll();
      expect(watcher.gitTimers.size).toBe(0);
      jest.advanceTimersByTime(1000);
      expect(gitFrames()).toEqual([]);
    });

    it("git timers are unref'd so a leak can't hold the worker open", () => {
      watcher._maybeScheduleGitChange(PROJECT_ID, 'src/a.js');
      const [timer] = watcher.gitTimers.values();
      expect(timer.hasRef()).toBe(false);
    });
  });

  describe('git_changed end-to-end (real fs.watch)', () => {
    it('a write in the tree and a .git/index write both push git_changed', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      watcher.watchProject(PROJECT_ID);
      if (!watcher.projectWatchers.has(PROJECT_ID)) return; // unsupported platform
      await delay(50);
      fs.writeFileSync(path.join(tmpDir, 'fresh.txt'), 'hi', 'utf8');
      fs.writeFileSync(path.join(tmpDir, '.git', 'index'), 'idx', 'utf8');
      await delay(1200);
      const repos = mockWs.sent.filter((m) => m.type === 'git_changed').map((m) => m.repo);
      expect(repos).toEqual(expect.arrayContaining(['/', '*']));
      // .git churn still never asks the tree to refresh.
      expect(mockWs.sent.some((m) => m.type === 'dir_changed' && m.path.startsWith('/.git'))).toBe(false);
    });
  });

  describe('remote (host agent) change events', () => {
    const { EventEmitter } = require('events');
    let agent, remoteFs, remoteWs, rw;
    const RP = 'remote-project';
    const ROOT = '/srv/app';

    beforeEach(() => {
      agent = new EventEmitter();
      agent.watch = jest.fn().mockResolvedValue();
      agent.unwatch = jest.fn().mockResolvedValue();
      remoteFs = {
        hostAgent: agent,
        listDirectory: jest.fn().mockResolvedValue([]),
        readFile: jest.fn(),
        validatePath: (root, rel) => path.posix.resolve(root, String(rel).replace(/^\/+/, '') || '.'),
      };
      remoteWs = createMockWs();
      const project = { id: RP, path: ROOT, hostId: 'h1' };
      rw = new FileWatcher(remoteWs, () => remoteFs, (id) => (id === RP ? project : undefined));
      rw.watchProject(RP);
    });

    afterEach(() => {
      rw.closeAll();
    });

    it('registers with the agent', () => {
      expect(agent.watch).toHaveBeenCalledWith(ROOT);
      expect(rw.projectWatchers.get(RP)).toMatchObject({ remote: true });
    });

    it('.git/index pushes git_changed "*" and no longer triggers dir_changed', async () => {
      jest.useFakeTimers();
      agent.emit('change', { root: ROOT, path: '.git/index' });
      expect(rw.dirTimers.size).toBe(0);
      expect(rw.gitTimers.size).toBe(1);
      await jest.advanceTimersByTimeAsync(600);
      expect(remoteWs.sent).toEqual([{ type: 'git_changed', projectId: RP, repo: '*' }]);
      expect(remoteFs.listDirectory).not.toHaveBeenCalled();
    });

    it('node_modules / .DS_Store / other .git churn triggers nothing at all', async () => {
      jest.useFakeTimers();
      agent.emit('change', { root: ROOT, path: 'node_modules/pkg/index.js' });
      agent.emit('change', { root: ROOT, path: 'web/node_modules/pkg/a.js' });
      agent.emit('change', { root: ROOT, path: '.DS_Store' });
      agent.emit('change', { root: ROOT, path: '.git/objects/ab/cd' });
      expect(rw.dirTimers.size).toBe(0);
      expect(rw.gitTimers.size).toBe(0);
      await jest.advanceTimersByTimeAsync(1000);
      expect(remoteWs.sent).toEqual([]);
    });

    it('a normal file change pushes both dir_changed and git_changed for its repo', async () => {
      jest.useFakeTimers();
      agent.emit('change', { root: ROOT, path: 'feat/src/app.js' });
      await jest.advanceTimersByTimeAsync(600);
      expect(remoteWs.sent).toEqual(expect.arrayContaining([
        { type: 'dir_changed', projectId: RP, path: '/feat/src' },
        { type: 'git_changed', projectId: RP, repo: '/feat' },
      ]));
    });

    it('ignores events for another root served by the same agent', async () => {
      jest.useFakeTimers();
      agent.emit('change', { root: '/srv/other', path: 'a.js' });
      await jest.advanceTimersByTimeAsync(1000);
      expect(remoteWs.sent).toEqual([]);
    });
  });
});
