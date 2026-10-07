const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const FileService = require('../../file-service');
const FileWatcher = require('../../file-watcher');

// markSelfWrite(absPath, content) drops only the true echo of Eve's own save.
// Each case drives _pushFile directly and awaits it, so "dropped" is asserted
// after the push has finished, never after a fixed wait.
describe('FileWatcher self-write suppression by content', () => {
  const PROJECT_ID = 'p1';
  let tmpDir, fileService, ws, watcher, file, abs;

  const createMockWs = () => ({ sent: [], send(data) { this.sent.push(JSON.parse(data)); } });
  const pushed = () => ws.sent.filter((m) => m.type === 'file_changed');

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-fw-selfwrite-')));
    file = path.join(tmpDir, 'doc.txt');
    fs.writeFileSync(file, 'original', 'utf8');
    fileService = new FileService();
    ws = createMockWs();
    watcher = new FileWatcher(ws, () => fileService, (id) => (id === PROJECT_ID ? { id, path: tmpDir } : undefined));
    watcher.watch(PROJECT_ID, '/doc.txt');
    abs = fileService.validatePath(tmpDir, '/doc.txt');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    watcher.closeAll();
    expect(tmpDir).toBeTruthy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const push = () => watcher._pushFile(PROJECT_ID, 'doc.txt');

  it('U1: an outside write right after a save is pushed', async () => {
    watcher.markSelfWrite(abs, 'saved by eve');
    fs.writeFileSync(file, 'written by someone else', 'utf8');
    await push();
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0].content).toBe('written by someone else');
  });

  it('U2: the true echo (disk equals the saved text) is dropped', async () => {
    watcher.markSelfWrite(abs, 'saved by eve');
    fs.writeFileSync(file, 'saved by eve', 'utf8');
    await push();
    expect(pushed()).toHaveLength(0);
  });

  it('U3: after two quick saves, the reads of both saved texts are dropped', async () => {
    watcher.markSelfWrite(abs, 'save A');
    watcher.markSelfWrite(abs, 'save B');
    fs.writeFileSync(file, 'save A', 'utf8');
    await push();
    fs.writeFileSync(file, 'save B', 'utf8');
    await push();
    expect(pushed()).toHaveLength(0);
  });

  it('U4: once a different text was pushed, a write back to the saved text is pushed too', async () => {
    watcher.markSelfWrite(abs, 'saved by eve');
    fs.writeFileSync(file, 'outside', 'utf8');
    await push();
    fs.writeFileSync(file, 'saved by eve', 'utf8');
    await push();
    expect(pushed().map((m) => m.content)).toEqual(['outside', 'saved by eve']);
  });

  it('U5: the suppression expires 1000 ms after the save', () => {
    jest.useFakeTimers();
    watcher.markSelfWrite(abs, 'saved by eve');
    expect(watcher.selfWrites.size).toBe(1);
    jest.advanceTimersByTime(999);
    expect(watcher.selfWrites.size).toBe(1);
    jest.advanceTimersByTime(1);
    expect(watcher.selfWrites.size).toBe(0);
  });

  it('U6: the expiry timer does not keep the process alive', () => {
    const real = global.setTimeout;
    const made = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
      const t = real(fn, ms, ...rest);
      if (ms === 1000) made.push(t);
      return t;
    });
    watcher.markSelfWrite(abs, 'saved by eve');
    expect(made.length).toBeGreaterThan(0);
    for (const t of made) expect(t.hasRef()).toBe(false);
  });

  it.each([[undefined], [null], [42], [Buffer.from('x')]])(
    'U8: non-string content (%p) leaves no entry', (content) => {
      watcher.markSelfWrite(abs, content);
      expect(watcher.selfWrites.has(abs)).toBe(false);
      expect(watcher.selfWrites.size).toBe(0);
    });

  it('U9: closeAll cancels the pending expiry timers', () => {
    jest.useFakeTimers();
    const before = jest.getTimerCount();
    watcher.markSelfWrite(abs, 'saved by eve');
    watcher.markSelfWrite(abs, 'saved again');
    expect(jest.getTimerCount()).toBe(before + 2);
    watcher.closeAll();
    expect(jest.getTimerCount()).toBe(before);
  });

  describe('U7: host (remote) file service', () => {
    const RP = 'rp1';
    const ROOT = '/srv/app';
    let remoteFs, remoteWs, rw, rabs, disk;

    beforeEach(() => {
      const agent = new EventEmitter();
      agent.watch = jest.fn().mockResolvedValue();
      agent.unwatch = jest.fn().mockResolvedValue();
      remoteFs = {
        hostAgent: agent,
        listDirectory: jest.fn().mockResolvedValue([]),
        readFile: jest.fn(async () => ({ content: disk, size: disk.length })),
        validatePath: (root, rel) => path.posix.resolve(root, String(rel).replace(/^\/+/, '') || '.'),
      };
      remoteWs = createMockWs();
      rw = new FileWatcher(remoteWs, () => remoteFs, (id) => (id === RP ? { id: RP, path: ROOT, hostId: 'h1' } : undefined));
      rw.watch(RP, '/a.txt');
      rabs = remoteFs.validatePath(ROOT, '/a.txt');
    });

    afterEach(() => rw.closeAll());

    it('pushes an outside write right after a save', async () => {
      rw.markSelfWrite(rabs, 'saved by eve');
      disk = 'written by someone else';
      await rw._pushFile(RP, 'a.txt');
      expect(remoteWs.sent).toHaveLength(1);
      expect(remoteWs.sent[0]).toMatchObject({ type: 'file_changed', content: 'written by someone else' });
    });

    it('drops the true echo', async () => {
      rw.markSelfWrite(rabs, 'saved by eve');
      disk = 'saved by eve';
      await rw._pushFile(RP, 'a.txt');
      expect(remoteWs.sent).toHaveLength(0);
    });
  });
});
