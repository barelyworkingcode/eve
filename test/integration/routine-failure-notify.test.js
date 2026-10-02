/**
 * A failed routine run reaches notifications.jsonl through eve's own /ws/tasks
 * connection, with no browser connected. docs/design-on-the-go.md
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

const routine = (id, name) => ({ id, name, projectId: 'p1', prompt: 'p', model: 'fake-model', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless' });

describe('routine failure notifications', () => {
  let eve;
  let projectDir;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-notify-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'Acme', path: projectDir }] });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const lines = () => {
    try {
      return fs.readFileSync(path.join(eve.dataDir, 'notifications.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  };
  const until = async (fn, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`until: timed out after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const run = async (id) => expect((await eve.get(`/api/tasks/${id}/run`, { method: 'POST' })).status).toBe(200);

  it('a successful run writes nothing; a failed one writes exactly one line within 5 s', async () => {
    await eve.relay.waitForScheduler(); // eve's own connection: no browser has connected
    eve.relay.seedTask(routine('t-ok', 'Inbox digest'));
    eve.relay.seedTask(routine('t-bad', 'Nightly backup'));

    await run('t-ok');
    await until(() => eve.relay.taskHistory('t-ok')[0]?.status === 'success');

    eve.relay.holdTaskRuns();
    await run('t-bad');
    const before = Date.now();
    eve.relay.finishTask('t-bad', { status: 'error', error: 'process exited\n  with code 3' });
    eve.relay.holdTaskRuns(false);

    await until(() => lines().length > 0, 5000);
    await new Promise((r) => setTimeout(r, 500)); // room for a duplicate to land
    const written = lines();
    expect(written).toEqual([{
      v: 1, kind: 'routine_failed', at: expect.any(String), title: 'Routine failed: Nightly backup',
      message: 'process exited with code 3', url: '#routines', taskId: 't-bad', projectId: 'p1', status: 'error',
    }]);
    expect(Date.parse(written[0].at)).toBeGreaterThanOrEqual(before - 1000);
    expect(written[0].at).toMatch(/Z$/);
  });
});
