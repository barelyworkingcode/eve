/**
 * Session lifecycle ops forward the correct frame to relay, and all three
 * assistant-text shapes relay through to the browser. Asserts on the fake's
 * `inbound` (what eve sent relay) and on browser-bound frames.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');
const { relayFrames } = require('./protocol');

describe('session lifecycle forwarding (eve -> relay)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-fwd-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
    await eve.relay.waitForRelay(); // eve drops relay sends on a not-yet-open socket
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const cases = [
    ['leave_session', { type: 'leave_session', sessionId: 's1' }],
    ['end_session', { type: 'end_session', sessionId: 's1' }],
    ['delete_session', { type: 'delete_session', sessionId: 's1' }],
    ['rename_session', { type: 'rename_session', sessionId: 's1', name: 'Renamed' }],
    ['set_session_folder', { type: 'set_session_folder', sessionId: 's1', folder: 'Inbox' }],
    ['stop_generation', { type: 'stop_generation', sessionId: 's1' }],
    ['set_permission_mode', { type: 'set_permission_mode', sessionId: 's1', mode: 'plan' }],
  ];

  it.each(cases)('%s reaches relay verbatim', async (_label, frame) => {
    ws.send(frame);
    const got = await eve.relay.waitForInbound((f) => f.type === frame.type && f.sessionId === 's1');
    expect(got).toMatchObject(frame);
  });

  describe('assistant-text shapes relay to the browser', () => {
    async function streamShape(builder) {
      const from = ws.mark();
      ws.send({ type: 'create_session', projectId: 'p1' });
      const created = await ws.waitFor((f) => f.type === 'session_created', 5000, from);
      eve.relay.scriptSession(created.sessionId, [
        builder({ sessionId: created.sessionId, text: 'shaped text' }),
        relayFrames.messageComplete({ sessionId: created.sessionId }),
      ]);
      ws.send({ type: 'user_input', text: 'go', sessionId: created.sessionId });
      await ws.waitFor((f) => f.type === 'message_complete' && f.sessionId === created.sessionId);
      return ws.frames.find((f) => f.type === 'llm_event' && f.sessionId === created.sessionId);
    }

    it('message-block shape forwards intact', async () => {
      const ev = await streamShape(relayFrames.assistantMessage);
      expect(ev.event.message.content[0].text).toBe('shaped text');
    });

    it('content_block shape forwards intact', async () => {
      const ev = await streamShape(relayFrames.assistantContentBlock);
      expect(ev.event.content_block.text).toBe('shaped text');
    });
  });
});
