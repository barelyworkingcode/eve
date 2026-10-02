const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileNotifier, createNotifier, NOTIFICATIONS_FILE } = require('../../notifier');

const note = (taskId) => ({ v: 1, kind: 'routine_failed', title: `Routine failed: ${taskId}`, url: '#routines', taskId });
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const quietLog = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() });

describe('notifier', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-notifier-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('createNotifier gives a FileNotifier that appends one newline-terminated JSON line, mode 0600, in the data dir', async () => {
    const notifier = createNotifier({ dataDir: dir, log: quietLog() });
    expect(notifier).toBeInstanceOf(FileNotifier);
    await notifier.notify(note('t1'));
    const file = path.join(dir, NOTIFICATIONS_FILE);
    expect(NOTIFICATIONS_FILE).toBe('notifications.jsonl');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${JSON.stringify(note('t1'))}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('201 concurrent notifies all land in call order, and the file keeps the last 200', async () => {
    const notifier = new FileNotifier({ file: path.join(dir, 'n.jsonl'), log: quietLog() });
    await Promise.all(Array.from({ length: 201 }, (_, i) => notifier.notify(note(`t${i + 1}`))));
    const ids = readLines(path.join(dir, 'n.jsonl')).map((n) => n.taskId);
    expect(ids).toEqual(Array.from({ length: 200 }, (_, i) => `t${i + 2}`));
  });

  it('an unwritable file resolves, warns with the task id, and later writes still land', async () => {
    const log = quietLog();
    const file = path.join(dir, 'missing', 'n.jsonl');
    const notifier = new FileNotifier({ file, log });
    await expect(notifier.notify(note('t1'))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('Notification not written', expect.objectContaining({ kind: 'routine_failed', taskId: 't1' }));

    fs.mkdirSync(path.dirname(file));
    await notifier.notify(note('t2'));
    expect(readLines(file).map((n) => n.taskId)).toEqual(['t2']);
  });

  it('loads and writes with no network module', async () => {
    const NET = ['http', 'https', 'http2', 'net', 'tls', 'dgram'];
    await jest.isolateModulesAsync(async () => {
      for (const m of NET) jest.doMock(m, () => { throw new Error(`${m} required`); });
      const isolated = require('../../notifier');
      const log = quietLog();
      await isolated.createNotifier({ dataDir: dir, log }).notify(note('t1'));
      expect(log.warn).not.toHaveBeenCalled();
    });
    for (const m of NET) jest.dontMock(m);
  });
});
