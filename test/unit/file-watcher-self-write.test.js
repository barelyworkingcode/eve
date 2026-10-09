const { makeRig } = require('./helpers/file-watcher-rig');

// markSelfWrite(key, content) drops only the true echo of Eve's own save: the
// file_changed whose content is exactly what Eve just saved. Everything runs
// on jest fake timers and a client that emits synchronously, so "dropped" is
// asserted after the debounced read has run, never after a fixed wait.
describe.each([
  ['console project', { id: 'p1', path: '/work/acme' }],
  ['host project', { id: 'p1', path: '/srv/acme', hostId: 'h1' }],
])('FileWatcher self-write suppression by content (%s)', (_label, project) => {
  const PROJECT_ID = project.id;
  let rig;
  let key;

  beforeEach(() => {
    jest.useFakeTimers();
    rig = makeRig([project]);
    rig.setFile(PROJECT_ID, 'doc.txt', 'original');
    rig.watcher.watch(PROJECT_ID, '/doc.txt');
    key = rig.selfKey(PROJECT_ID, '/doc.txt');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rig.watcher.closeAll();
  });

  const pushed = () => rig.framesOf('file_changed');
  // One outside event: the file now reads `content`, relay reports a change.
  async function change(content) {
    rig.setFile(PROJECT_ID, 'doc.txt', content);
    rig.emitFs(PROJECT_ID, 'doc.txt', 'change');
    await jest.advanceTimersByTimeAsync(100);
  }

  it('U1: an outside write right after a save is pushed', async () => {
    rig.watcher.markSelfWrite(key, 'saved by eve');
    await change('written by someone else');
    expect(pushed().map((m) => m.content)).toEqual(['written by someone else']);
  });

  it('U2: the true echo (the file equals the saved text) is dropped', async () => {
    rig.watcher.markSelfWrite(key, 'saved by eve');
    await change('saved by eve');
    expect(pushed()).toHaveLength(0);
  });

  it('U3: after two quick saves, the reads of both saved texts are dropped', async () => {
    rig.watcher.markSelfWrite(key, 'save A');
    rig.watcher.markSelfWrite(key, 'save B');
    await change('save A');
    await change('save B');
    expect(pushed()).toHaveLength(0);
  });

  it('U4: once a different text was pushed, a write back to the saved text is pushed too', async () => {
    rig.watcher.markSelfWrite(key, 'saved by eve');
    await change('outside');
    await change('saved by eve');
    expect(pushed().map((m) => m.content)).toEqual(['outside', 'saved by eve']);
  });

  it('U5: the suppression holds inside 1000 ms and expires at 1000 ms', async () => {
    rig.watcher.markSelfWrite(key, 'saved by eve');
    await jest.advanceTimersByTimeAsync(500);
    await change('saved by eve'); // t = 600 ms: still an echo
    expect(pushed()).toHaveLength(0);

    rig.watcher.markSelfWrite(key, 'saved again');
    await jest.advanceTimersByTimeAsync(1000);
    await change('saved again'); // t > 1000 ms after the mark: an outside write that happens to match
    expect(pushed().map((m) => m.content)).toEqual(['saved again']);
  });

  it('U6: the expiry timer does not keep the process alive', () => {
    const real = global.setTimeout;
    const made = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
      const t = real(fn, ms, ...rest);
      if (ms === 1000) made.push(t);
      return t;
    });
    rig.watcher.markSelfWrite(key, 'saved by eve');
    expect(made.length).toBeGreaterThan(0);
    for (const t of made) expect(t.hasRef()).toBe(false);
  });

  it.each([[undefined], [null], [42], [Buffer.from('saved by eve')]])(
    'U8: non-string content (%p) marks nothing, so a matching read is pushed', async (content) => {
      rig.watcher.markSelfWrite(key, content);
      await change('saved by eve');
      expect(pushed()).toHaveLength(1);
    });

  it('U9: closeAll cancels the pending expiry timers', () => {
    const before = jest.getTimerCount();
    rig.watcher.markSelfWrite(key, 'saved by eve');
    rig.watcher.markSelfWrite(key, 'saved again');
    expect(jest.getTimerCount()).toBe(before + 2);
    rig.watcher.closeAll();
    expect(jest.getTimerCount()).toBe(before);
  });
});
