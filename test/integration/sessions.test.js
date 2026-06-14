/**
 * Increment 3 — session lifecycle + streamed LLM response, end-to-end through
 * the REAL RelayClient (eve <-> fake relay WS). The fake relay scripts the
 * llm_event stream, so we assert the *structure* eve relays to the browser, not
 * any model content. This is the layer that catches relay-client/ws-handler
 * contract drift that the unit tests (which mock RelayClient) cannot.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('session lifecycle + streaming (eve <-> fake relay WS)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-sess-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'Test', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  async function createSession() {
    const from = ws.mark(); // ignore session_created frames from earlier steps on this shared socket
    ws.send({ type: 'create_session', projectId: 'p1' });
    return ws.waitFor((f) => f.type === 'session_created', 5000, from);
  }

  it('creates a session and reports it to the browser', async () => {
    const created = await createSession();
    expect(created.sessionId).toBeTruthy();
    expect(created.model).toBe('fake-model');
  });

  it('streams the default assistant response back to the browser', async () => {
    const created = await createSession();
    ws.send({ type: 'user_input', text: 'hi', sessionId: created.sessionId });

    await ws.waitFor((f) => f.type === 'message_complete' && f.sessionId === created.sessionId);
    const text = ws.frames
      .filter((f) => f.type === 'llm_event' && f.sessionId === created.sessionId)
      .map((f) => f.event.delta.text)
      .join('');
    expect(text).toBe('Hello from fake relay');
  });

  it('relays a scripted custom stream verbatim', async () => {
    const created = await createSession();
    eve.relay.scriptSession(created.sessionId, [
      { type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: 'scripted ' } } },
      { type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: 'answer' } } },
      { type: 'message_complete' },
    ]);
    ws.send({ type: 'user_input', text: 'go', sessionId: created.sessionId });

    await ws.waitFor((f) => f.type === 'message_complete' && f.sessionId === created.sessionId);
    const text = ws.frames
      .filter((f) => f.type === 'llm_event' && f.sessionId === created.sessionId)
      .map((f) => f.event.delta.text)
      .join('');
    expect(text).toBe('scripted answer');
  });

  it('relays an error completion to the browser', async () => {
    const created = await createSession();
    eve.relay.scriptSession(created.sessionId, [{ type: 'message_complete', error: 'model exploded' }]);
    ws.send({ type: 'user_input', text: 'boom', sessionId: created.sessionId });

    const complete = await ws.waitFor((f) => f.type === 'message_complete' && f.sessionId === created.sessionId && f.error);
    expect(complete.error).toBe('model exploded');
  });
});
