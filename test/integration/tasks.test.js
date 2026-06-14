/**
 * Tasks: the HTTP proxy, and the second upstream — relayScheduler task events
 * arriving on /ws/tasks and forwarded to the browser (relay-client._connectScheduler).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('tasks proxy + scheduler WS forwarding', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-tasks-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('proxies GET /api/tasks to relay', async () => {
    const res = await eve.get('/api/tasks?projectId=p1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('forwards scheduler task events to the browser', async () => {
    await eve.relay.waitForScheduler(); // eve opens /ws/tasks on connect
    eve.relay.emitToScheduler({ type: 'task_started', taskId: 't1', projectId: 'p1' });
    const started = await ws.waitFor((f) => f.type === 'task_started' && f.taskId === 't1');
    expect(started.projectId).toBe('p1');

    eve.relay.emitToScheduler({ type: 'task_completed', taskId: 't1', status: 'done' });
    const done = await ws.waitFor((f) => f.type === 'task_completed' && f.taskId === 't1');
    expect(done.status).toBe('done');
  });
});
