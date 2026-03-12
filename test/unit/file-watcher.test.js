const os = require('os');
const fs = require('fs');
const path = require('path');
const FileService = require('../../file-service');
const FileWatcher = require('../../file-watcher');

describe('FileWatcher', () => {
  let tmpDir, fileService, mockWs, watcher;

  const PROJECT_ID = 'test-project';

  function createMockWs() {
    return {
      sent: [],
      send(data) { this.sent.push(JSON.parse(data)); }
    };
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

  describe('watch/unwatch', () => {
    it('creates a watcher for a valid file', () => {
      watcher.watch(PROJECT_ID, 'test.js');
      expect(watcher.watchers.size).toBe(1);
    });

    it('does not duplicate watchers for the same file', () => {
      watcher.watch(PROJECT_ID, 'test.js');
      watcher.watch(PROJECT_ID, 'test.js');
      expect(watcher.watchers.size).toBe(1);
    });

    it('ignores unknown project IDs', () => {
      watcher.watch('nonexistent', 'test.js');
      expect(watcher.watchers.size).toBe(0);
    });

    it('ignores invalid paths', () => {
      watcher.watch(PROJECT_ID, '../../etc/passwd');
      expect(watcher.watchers.size).toBe(0);
    });

    it('removes watcher on unwatch', () => {
      watcher.watch(PROJECT_ID, 'test.js');
      expect(watcher.watchers.size).toBe(1);
      watcher.unwatch(PROJECT_ID, 'test.js');
      expect(watcher.watchers.size).toBe(0);
    });

    it('unwatch is safe for unwatched files', () => {
      expect(() => watcher.unwatch(PROJECT_ID, 'nope.js')).not.toThrow();
    });
  });

  describe('markSelfWrite', () => {
    it('adds path to selfWrites set', () => {
      const absPath = path.join(tmpDir, 'test.js');
      watcher.markSelfWrite(absPath);
      expect(watcher.selfWrites.has(absPath)).toBe(true);
    });

    it('auto-clears after 500ms', () => {
      jest.useFakeTimers();
      const absPath = path.join(tmpDir, 'test.js');
      watcher.markSelfWrite(absPath);
      expect(watcher.selfWrites.has(absPath)).toBe(true);
      jest.advanceTimersByTime(500);
      expect(watcher.selfWrites.has(absPath)).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('_onFileChange', () => {
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    it('debounces and sends file_changed message', async () => {
      const key = `${PROJECT_ID}:test.js`;
      const absPath = path.join(tmpDir, 'test.js');

      watcher._onFileChange(key, PROJECT_ID, 'test.js', absPath);
      // Not sent yet (debounced)
      expect(mockWs.sent.length).toBe(0);

      // Wait for debounce (300ms) + async readFile
      await delay(400);

      expect(mockWs.sent.length).toBe(1);
      expect(mockWs.sent[0]).toMatchObject({
        type: 'file_changed',
        projectId: PROJECT_ID,
        path: 'test.js',
        content: 'original'
      });
    });

    it('skips self-written files', async () => {
      const key = `${PROJECT_ID}:test.js`;
      const absPath = path.join(tmpDir, 'test.js');

      watcher.markSelfWrite(absPath);
      watcher._onFileChange(key, PROJECT_ID, 'test.js', absPath);

      await delay(400);

      expect(mockWs.sent.length).toBe(0);
    });

    it('coalesces multiple rapid events', async () => {
      const key = `${PROJECT_ID}:test.js`;
      const absPath = path.join(tmpDir, 'test.js');

      // Fire 3 rapid change events
      watcher._onFileChange(key, PROJECT_ID, 'test.js', absPath);
      watcher._onFileChange(key, PROJECT_ID, 'test.js', absPath);
      watcher._onFileChange(key, PROJECT_ID, 'test.js', absPath);

      await delay(400);

      // Should only send once
      expect(mockWs.sent.length).toBe(1);
    });
  });

  describe('closeAll', () => {
    it('closes all watchers and clears state', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'a', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'b.js'), 'b', 'utf8');

      watcher.watch(PROJECT_ID, 'a.js');
      watcher.watch(PROJECT_ID, 'b.js');
      watcher.markSelfWrite(path.join(tmpDir, 'a.js'));

      expect(watcher.watchers.size).toBe(2);
      expect(watcher.selfWrites.size).toBe(1);

      watcher.closeAll();

      expect(watcher.watchers.size).toBe(0);
      expect(watcher.selfWrites.size).toBe(0);
    });

    it('is safe to call multiple times', () => {
      watcher.watch(PROJECT_ID, 'test.js');
      watcher.closeAll();
      expect(() => watcher.closeAll()).not.toThrow();
    });
  });
});
