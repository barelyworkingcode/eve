/**
 * Increment 4 — module AI invocation end-to-end. Exercises the load-bearing
 * `__module:` hidden-session interception: the fake relay streams llm_events on
 * the hidden session, eve's RelayClient routes them to the ModuleInvoker's
 * handler (NOT into the user's chat), and the browser receives module_ai_*
 * frames. Also verifies the ephemeral session is DELETEd afterward.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('module AI invocation (eve <-> fake relay)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-modai-'));
    const modDir = path.join(projectDir, 'modules', 'demo');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'module.json'), JSON.stringify({ displayName: 'Demo', entry: 'index.html' }), 'utf8');
    fs.writeFileSync(path.join(modDir, 'index.html'), '<h1>demo</h1>', 'utf8');

    eve = await startEve({ projects: [{ id: 'p1', name: 'Test', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('streams a module AI result without leaking the hidden session into chat', async () => {
    ws.send({ type: 'module_invoke_ai', requestId: 'rq1', projectId: 'p1', moduleName: 'demo', prompt: 'do it' });

    const started = await ws.waitFor((f) => f.type === 'module_ai_started' && f.requestId === 'rq1');
    expect(started.sessionId).toMatch(/^sess-/);

    const completed = await ws.waitFor((f) => f.type === 'module_ai_completed' && f.requestId === 'rq1');
    // No schema → result is the accumulated raw text from the fake's stream.
    expect(completed.result).toBe('Hello from fake relay');

    // The intercepted frames surfaced as module_ai_event, NOT as plain llm_event
    // in the user's chat (that's the whole point of __module: interception).
    expect(ws.frames.some((f) => f.type === 'module_ai_event')).toBe(true);
    expect(ws.frames.some((f) => f.type === 'llm_event')).toBe(false);

    // The ephemeral session was cleaned up.
    expect(eve.relay.requests).toContainEqual({ method: 'DELETE', path: `/api/sessions/${started.sessionId}` });
  });
});
