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
      ['assistant thinking_delta', relayFrames.assistantThinkingDelta({ sessionId: 's1', thinking: 'hmm' })],
      ['assistant content_block_stop', relayFrames.assistantContentBlockStop({ sessionId: 's1' })],
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
    it('rejects an llm_event missing the event protocol version (client would drop it)', () => {
      expect(validateRelayFrame({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: 'hi' } } }).ok).toBe(false);
    });
    it('accepts structural assistant events with no text payload (thinking / block-stop)', () => {
      // Confirmed against the live relay: not every assistant event carries text.
      expect(validateRelayFrame({ type: 'llm_event', event: { v: 2, type: 'assistant', index: 0, content_block_stop: true } }).ok).toBe(true);
      expect(validateRelayFrame({ type: 'llm_event', event: { v: 2, type: 'assistant', delta: { type: 'thinking_delta', thinking: 'x' } } }).ok).toBe(true);
    });
    it('passes through unknown (blindly-forwarded) types', () => {
      expect(validateRelayFrame({ type: 'stats_update', used: 5 }).ok).toBe(true);
    });
  });

  // The record-and-verify against the REAL relay — the test that keeps the fake
  // honest by validating actual relayLLM frames against this same contract —
  // lives in contract-live.test.js (run with EVE_CONTRACT=1; it drives the
  // running eve and hits a real LLM, so it's skipped by default).
});
