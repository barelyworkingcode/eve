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

// The browser refuses to render any llm_event whose inner event lacks this
// version (message-dispatcher.js EVENT_PROTOCOL_VERSION / _checkEventVersion).
// eve forwards relay events transparently, so this lives in the relay->browser
// contract — invisible in eve's own code, enforced by the client.
const EVENT_PROTOCOL_VERSION = 2;

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

  // Assistant text arrives as deltas, full message blocks, or content_blocks
  // (provider-dependent; see feedback_relayLLM_events). Every event also carries
  // `v` (client drops events without it). Confirmed against the live relay:
  // Claude streams `delta.text_delta` for text AND `delta.thinking_delta` +
  // `content_block_stop` structural markers — so assistant events are NOT all
  // text-bearing (see assistantThinkingDelta / assistantContentBlockStop below).
  assistantDelta: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index: 0, delta: { type: 'text_delta', text } } }),
  assistantMessage: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', message: { content: [{ type: 'text', text }] } } }),
  assistantContentBlock: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', content_block: { type: 'text', text } } }),
  // Real structural variants the live relay emits (no renderable text).
  assistantThinkingDelta: ({ sessionId, thinking }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index: 0, delta: { type: 'thinking_delta', thinking } } }),
  assistantContentBlockStop: ({ sessionId, index = 0 }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index, content_block_stop: true } }),

  messageComplete: ({ sessionId, error } = {}) => (error ? { type: 'message_complete', sessionId, error } : { type: 'message_complete', sessionId }),
  error: ({ message }) => ({ type: 'error', message }),

  // Control frames eve forwards verbatim. Field names verified against the real
  // relayLLM source, NOT guessed — earlier guesses (`tool`/`input`, raw terminal
  // `data`) were wrong and gave false confidence.
  //   permission_request: relayLLM/api.go:344-346 + events.go:245 → toolName / toolInput (string) / toolUseId
  permissionRequest: ({ sessionId, permissionId, toolName, toolInput = '{}', toolUseId }) =>
    ({ type: 'permission_request', sessionId, permissionId, toolName, toolInput, toolUseId }),
  //   terminal_output: relayLLM/main.go:150 base64-encodes `data`; the browser _decodeBase64s it
  terminalOutput: ({ terminalId, data }) =>
    ({ type: 'terminal_output', terminalId, data: Buffer.from(String(data)).toString('base64') }),
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
    else if (frame.event.v !== EVENT_PROTOCOL_VERSION) {
      errors.push(`llm_event: event.v must be ${EVENT_PROTOCOL_VERSION} (got ${frame.event.v}) — client drops events without it`);
    } else if (frame.event.delta && typeof frame.event.delta.type !== 'string') {
      // The load-bearing contract is the version tag. Assistant events come in
      // many structural variants (text_delta / thinking_delta deltas,
      // content_block_start/stop, message markers, tool_use) — confirmed against
      // the live relay — so we don't enumerate payloads; renderable text is
      // checked separately via extractAssistantText. Only sanity-check that a
      // present delta is well-formed.
      errors.push('llm_event: delta missing a type');
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  EVENT_PROTOCOL_VERSION,
  EVE_TO_RELAY_TYPES,
  MODELED_RELAY_TO_EVE_TYPES,
  relayFrames,
  extractAssistantText,
  validateRelayFrame,
};
