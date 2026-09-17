/**
 * C11 / SH-6 resume_required: relay refuses a `send_message` against a
 * dormant session with a distinct, typed error instead of respawning it.
 * eve resumes on relay's behalf — but only as a direct consequence of the
 * user's own turn that triggered it, exactly once, never on its own
 * initiative (no host-driven resume, no retry loop).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');
const { relayFrames } = require('./protocol');

describe('resume_required (eve <-> fake relay)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-resume-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'Test', path: projectDir }] });
    ws = await eve.connectWs();
    await eve.relay.waitForRelay();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  async function createSession() {
    const from = ws.mark();
    ws.send({ type: 'create_session', projectId: 'p1' });
    return ws.waitFor((f) => f.type === 'session_created', 5000, from);
  }

  function resumeRequests(sessionId) {
    return eve.relay.requests.filter((r) => r.method === 'POST' && r.path === `/api/sessions/${sessionId}/resume`);
  }

  it('resumes and resends the driving user turn exactly once, then stops (no loop)', async () => {
    const created = await createSession();
    const sessionId = created.sessionId;
    // Every send_message this session sees comes back resume_required — models
    // a host that never comes back up, so the test can see the retry loop
    // *not* happen rather than relying on it happening to stop in time.
    eve.relay.scriptSession(sessionId, [relayFrames.resumeRequired({ sessionId })]);

    const from = ws.mark();
    ws.send({ type: 'user_input', text: 'hello from the user', sessionId });

    // The one resend must reach relay before eve gives up and reports the error.
    const err = await ws.waitFor((f) => f.type === 'error' && f.sessionId === sessionId, 5000, from);
    expect(err.message).toBeTruthy();

    const sendMessages = eve.relay.inbound.filter((f) => f.type === 'send_message' && f.sessionId === sessionId);
    expect(sendMessages).toHaveLength(2); // the original turn, plus exactly one resend
    expect(sendMessages[1].text).toBe('hello from the user');
    expect(resumeRequests(sessionId)).toHaveLength(1); // never a second resume attempt
  });

  it('a resume POST failure reports an error to the browser and never resends', async () => {
    const created = await createSession();
    const sessionId = created.sessionId;
    eve.relay.scriptSession(sessionId, [relayFrames.resumeRequired({ sessionId })]);
    eve.relay.failResumeWith(503);

    try {
      const from = ws.mark();
      ws.send({ type: 'user_input', text: 'will this fail', sessionId });

      const err = await ws.waitFor((f) => f.type === 'error' && f.sessionId === sessionId, 5000, from);
      expect(err.message).toMatch(/resume failed/i);

      const sendMessages = eve.relay.inbound.filter((f) => f.type === 'send_message' && f.sessionId === sessionId);
      expect(sendMessages).toHaveLength(1); // only the original turn — no resend on a failed resume
      expect(resumeRequests(sessionId)).toHaveLength(1);
    } finally {
      eve.relay.clearResumeFail();
    }
  });

  // relayLLM ends a turn on any of three frames (session.go's HandleEvent
  // switch, each calling SetProcessing(false)): message_complete,
  // process_exited, and error. Round 1 of this fix only disarmed
  // pendingUserMessage on message_complete — Opus reproduced the same stale
  // resend against 96b293e via the other two, process_exited especially,
  // since that's the event that makes a session dormant in the first place
  // (the likeliest predecessor of a later resume_required, not an edge
  // case). Parameterized so this can't silently regress to two-of-three.
  it.each([
    ['message_complete', (sessionId) => relayFrames.messageComplete({ sessionId })],
    ['process_exited', (sessionId) => relayFrames.processExited({ sessionId })],
    ['error', () => relayFrames.error({ message: 'the model crashed' })],
  ])('E1: /clear on a now-dormant session does not resurrect the previous turn (ends via %s)', async (terminalType, buildFrame) => {
    const created = await createSession();
    const sessionId = created.sessionId;

    // A real turn that ends via this terminal frame — this must disarm
    // pendingUserMessage.
    eve.relay.scriptSession(sessionId, [buildFrame(sessionId)]);
    let from = ws.mark();
    ws.send({ type: 'user_input', text: 'the old message', sessionId });
    await ws.waitFor((f) => f.type === terminalType && f.sessionId === sessionId, 5000, from);

    // Now the session goes dormant; relay's own handleClearSession (not
    // handleSendMessage) answers a later /clear with the same distinct
    // resume_required, for the same sessionId — matching the (bug: still
    // armed) old turn if pendingUserMessage was never disarmed on completion.
    eve.relay.scriptClearSession(sessionId, [relayFrames.resumeRequired({ sessionId })]);

    from = ws.mark();
    ws.send({ type: 'user_input', text: '/clear', sessionId });

    const err = await ws.waitFor((f) => f.type === 'error' && f.sessionId === sessionId, 5000, from);
    expect(err.message).toBeTruthy();

    // The only send_message relay ever saw for this session is the original
    // turn — "the old message" must never be resent a second time.
    const sendMessages = eve.relay.inbound.filter((f) => f.type === 'send_message' && f.sessionId === sessionId);
    expect(sendMessages).toHaveLength(1);
    expect(resumeRequests(sessionId)).toHaveLength(0);
  });

  it('a resume_required with no driving user turn (e.g. a stray one) is reported, not resumed', async () => {
    const created = await createSession();
    const sessionId = created.sessionId;

    const from = ws.mark();
    // Emitted directly, with no preceding user_input — nothing is pending.
    eve.relay.emitToRelay(relayFrames.resumeRequired({ sessionId }));

    const err = await ws.waitFor((f) => f.type === 'error' && f.sessionId === sessionId, 5000, from);
    expect(err.message).toBeTruthy();
    expect(resumeRequests(sessionId)).toHaveLength(0);
  });
});
