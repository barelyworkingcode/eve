/**
 * The relay <-> eve WebSocket contract, as executable spec.
 *
 * This is the single source of truth for the frame shapes eve depends on. The
 * fake relay BUILDS its frames from here (so the double can't silently diverge
 * from what we claim the contract is), and the contract test VALIDATES frames
 * against here — both the fake's output and, when run against a live relay,
 * relayLLM's real output (see contract.test.js). If relayLLM changes a shape,
 * the record-and-verify test is what catches it; this file is what it checks.
 *
 * Ground truth for these shapes: eve's relay-client.js (_handleRelayMessage,
 * _handleTTSAccumulation) and module-invoker.js (accumulateAssistantText), plus
 * the CLAUDE.md "WebSocket messages" section. Keep in lockstep with those.
 */
'use strict';

// Frames eve SENDS to relay (relay/fake must accept these).
const EVE_TO_RELAY_TYPES = new Set([
  'join_session', 'send_message', 'leave_session', 'end_session', 'delete_session',
  'rename_session', 'set_session_folder', 'stop_generation', 'clear_session',
  'permission_response', 'set_permission_mode',
  'terminal_create', 'terminal_input', 'terminal_resize', 'terminal_close',
  'terminal_list', 'terminal_reconnect', 'join_terminal', 'leave_terminal', 'terminal_templates',
]);

// Frames relay SENDS to eve that eve PARSES (vs. blindly forwards). These are
// the only shapes we assert on — relay may send other types that eve passes
// through to the browser untouched, so unknown types are NOT a contract error.
const MODELED_RELAY_TO_EVE_TYPES = new Set(['session_joined', 'llm_event', 'message_complete', 'error']);

// --- Builders (the fake relay emits these) ---
const relayFrames = {
  sessionJoined: ({ sessionId, directory = '/fake' }) => ({ type: 'session_joined', sessionId, directory }),

  // relayLLM emits assistant text in THREE interchangeable shapes; eve handles
  // all three (see feedback_relayLLM_events). The contract must cover each.
  assistantDelta: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { type: 'assistant', delta: { type: 'text_delta', text } } }),
  assistantMessage: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }),
  assistantContentBlock: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { type: 'assistant', content_block: { type: 'text', text } } }),

  messageComplete: ({ sessionId, error } = {}) => (error ? { type: 'message_complete', sessionId, error } : { type: 'message_complete', sessionId }),
  error: ({ message }) => ({ type: 'error', message }),
};

/**
 * Extract assistant text from an llm_event, mirroring eve's accumulation across
 * all three shapes. Lets a contract test assert that real relay frames yield the
 * text we expect — independent of eve's own implementation.
 */
function extractAssistantText(frame) {
  if (!frame || frame.type !== 'llm_event' || !frame.event || frame.event.type !== 'assistant') return '';
  const ev = frame.event;
  let out = '';
  if (ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) out += ev.delta.text;
  if (ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) if (b.type === 'text' && b.text) out += b.text;
  }
  if (ev.content_block && ev.content_block.type === 'text' && ev.content_block.text) out += ev.content_block.text;
  return out;
}

/**
 * Validate a relay->eve frame against the modeled contract. Unknown types pass
 * (eve forwards them untouched); modeled types must have the right shape.
 * Returns { ok, errors }.
 */
function validateRelayFrame(frame) {
  const errors = [];
  if (!frame || typeof frame !== 'object') return { ok: false, errors: ['frame is not an object'] };
  if (typeof frame.type !== 'string' || !frame.type) errors.push('missing/invalid type');

  if (frame.type === 'session_joined') {
    if (!frame.sessionId) errors.push('session_joined: missing sessionId');
  } else if (frame.type === 'message_complete') {
    if (!('sessionId' in frame)) errors.push('message_complete: missing sessionId');
    if ('error' in frame && typeof frame.error !== 'string') errors.push('message_complete: error must be a string');
  } else if (frame.type === 'error') {
    if (typeof frame.message !== 'string') errors.push('error: missing/invalid message');
  } else if (frame.type === 'llm_event') {
    if (!frame.event || typeof frame.event !== 'object') errors.push('llm_event: missing event');
    else if (frame.event.type === 'assistant') {
      const ev = frame.event;
      const hasDelta = ev.delta && ev.delta.type === 'text_delta';
      const hasMessage = ev.message && Array.isArray(ev.message.content);
      const hasBlock = ev.content_block && typeof ev.content_block === 'object';
      const hasToolOrOther = ev.tool_use || ev.thinking || ev.tool_result; // non-text assistant events exist
      if (!hasDelta && !hasMessage && !hasBlock && !hasToolOrOther) {
        errors.push('llm_event assistant: no recognized payload (delta/message/content_block/tool)');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  EVE_TO_RELAY_TYPES,
  MODELED_RELAY_TO_EVE_TYPES,
  relayFrames,
  extractAssistantText,
  validateRelayFrame,
};
