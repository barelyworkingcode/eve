/**
 * Real-OS wiring smoke test for FileWatcher: native recursive fs.watch on a
 * temp dir, driven through the public API the way ws-handler does. The logic
 * (ignored paths, git attribution, debounce, failure handling) is covered by
 * test/unit/file-watcher.test.js with injected events; this is the one test
 * that proves the OS delivers a save to a browser frame.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const FileService = require('../../file-service');
const FileWatcher = require('../../file-watcher');

const PROJECT_ID = 'smoke-project';

describe('FileWatcher on the real file system', () => {
  let tmpDir, sent, watcher;

  // Bounded wait on a frame; polls the sent list, never sleeps for a fixed time.
  async function waitForSent(pred, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = sent.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`waitForSent: timed out; sent=${JSON.stringify(sent)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-fwsmoke-'));
    fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'original', 'utf8');
    sent = [];
    const ws = { send(data) { sent.push(JSON.parse(data)); } };
    const fileService = new FileService();
    watcher = new FileWatcher(ws, () => fileService, (id) => (id === PROJECT_ID ? { id, path: tmpDir } : undefined));
  });

  afterEach(() => {
    watcher.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pushes one file_changed with the new content when a watched file is saved', async () => {
    watcher.watch(PROJECT_ID, '/note.txt');
    expect(watcher.projectWatchers.has(PROJECT_ID)).toBe(true);

    // The OS gives no ready signal. Write a fresh nonce until one is reported,
    // so the watcher is known to be armed, then make the save under test.
    let armed = false;
    for (let round = 0; round < 10 && !armed; round++) {
      const nonce = `prime-${round}`;
      fs.writeFileSync(path.join(tmpDir, 'note.txt'), nonce, 'utf8');
      try {
        await waitForSent((m) => m.type === 'file_changed' && m.content === nonce, 1000);
        armed = true;
      } catch { /* not armed yet; try the next nonce */ }
    }
    expect(armed).toBe(true);

    fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'saved-on-disk', 'utf8');
    const frame = await waitForSent((m) => m.type === 'file_changed' && m.content === 'saved-on-disk');

    expect(frame).toMatchObject({ type: 'file_changed', path: '/note.txt', content: 'saved-on-disk' });
    expect(sent.filter((m) => m.type === 'file_changed' && m.content === 'saved-on-disk')).toHaveLength(1);
  });
});
