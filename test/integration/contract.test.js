/**
 * Protocol contract tests. The live part keeps the fake relay honest to the
 * declared contract (protocol.js). The skipped part is the record-and-verify
 * stub that, run against a live relay, is what actually catches relayLLM
 * changing a frame shape out from under the double.
 */
const { relayFrames, validateRelayFrame, extractAssistantText } = require('./protocol');

describe('relay protocol contract', () => {
  describe('declared frame builders are valid', () => {
    const cases = [
      ['session_joined', relayFrames.sessionJoined({ sessionId: 's1' })],
      ['assistant delta', relayFrames.assistantDelta({ sessionId: 's1', text: 'hi' })],
      ['assistant message block', relayFrames.assistantMessage({ sessionId: 's1', text: 'hi' })],
      ['assistant content_block', relayFrames.assistantContentBlock({ sessionId: 's1', text: 'hi' })],
      ['message_complete', relayFrames.messageComplete({ sessionId: 's1' })],
      ['message_complete (error)', relayFrames.messageComplete({ sessionId: 's1', error: 'boom' })],
      ['error', relayFrames.error({ message: 'x' })],
    ];
    it.each(cases)('%s passes validateRelayFrame', (_label, frame) => {
      expect(validateRelayFrame(frame)).toEqual({ ok: true, errors: [] });
    });
  });

  describe('all three assistant-text shapes extract identically', () => {
    it.each(['assistantDelta', 'assistantMessage', 'assistantContentBlock'])('%s yields the text', (builder) => {
      const frame = relayFrames[builder]({ sessionId: 's1', text: 'hello world' });
      expect(extractAssistantText(frame)).toBe('hello world');
    });
  });

  describe('validateRelayFrame catches drift in modeled frames', () => {
    it('rejects message_complete missing sessionId', () => {
      expect(validateRelayFrame({ type: 'message_complete' }).ok).toBe(false);
    });
    it('rejects an assistant llm_event with no recognized payload', () => {
      expect(validateRelayFrame({ type: 'llm_event', event: { type: 'assistant' } }).ok).toBe(false);
    });
    it('passes through unknown (blindly-forwarded) types', () => {
      expect(validateRelayFrame({ type: 'stats_update', used: 5 }).ok).toBe(true);
    });
  });

  // Record-and-verify against the REAL relay. Skipped by default — it needs a
  // live relay + relayLLM and a real session. Run with EVE_CONTRACT=1 once it's
  // wired to the running relay. This is the test that keeps the fake honest:
  // if relayLLM changes a frame shape, a real-captured frame fails the same
  // validateRelayFrame the fake's frames pass above.
  (process.env.EVE_CONTRACT === '1' ? describe : describe.skip)('real relay frames conform (record-and-verify)', () => {
    it('every captured relay->eve frame passes validateRelayFrame', async () => {
      // TODO when wired to a live relay (RELAY_FRONTEND_* env):
      //   1. open a RelayTransport WS to the real relay,
      //   2. create + join a session, send a trivial prompt,
      //   3. collect frames until message_complete,
      //   4. captured.forEach((f) => expect(validateRelayFrame(f).ok).toBe(true)),
      //   5. expect >=1 llm_event whose extractAssistantText() is non-empty.
      throw new Error('record-and-verify not yet wired to a live relay — see steps above');
    });
  });
});
