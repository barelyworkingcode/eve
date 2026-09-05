/**
 * The relay <-> eve WebSocket contract, as executable spec. The fake relay
 * builds its frames from here, and the contract test validates both the
 * fake's output and, against a live relay, relayLLM's real output (see
 * contract.test.js) — so a shape change on either side is caught.
 *
 * Ground truth: eve's relay-client.js, module-invoker.js, and docs/api.md's
 * "WebSocket" section. Keep in lockstep with those.
 */
'use strict';

// The browser refuses to render any llm_event whose inner event lacks this
// version (message-dispatcher.js's _checkEventVersion). eve forwards relay
// events transparently, so this contract is enforced by the client, not eve.
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

const relayFrames = {
  sessionJoined: ({ sessionId, directory = '/fake' }) => ({ type: 'session_joined', sessionId, directory }),

  // Assistant text arrives as deltas, full message blocks, or content_blocks
  // (provider-dependent); every event also carries `v`. Confirmed against the
  // live relay: streamed replies carry delta.text_delta for text as well as
  // delta.thinking_delta / content_block_stop structural markers, so
  // assistant events are not all text-bearing (see assistantThinkingDelta /
  // assistantContentBlockStop below).
  assistantDelta: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index: 0, delta: { type: 'text_delta', text } } }),
  assistantMessage: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', message: { content: [{ type: 'text', text }] } } }),
  assistantContentBlock: ({ sessionId, text }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', content_block: { type: 'text', text } } }),
  // Real structural variants the live relay emits (no renderable text).
  assistantThinkingDelta: ({ sessionId, thinking }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index: 0, delta: { type: 'thinking_delta', thinking } } }),
  assistantContentBlockStop: ({ sessionId, index = 0 }) => ({ type: 'llm_event', sessionId, event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index, content_block_stop: true } }),

  // relayLLM's message_complete is invariantly { type, sessionId } with a
  // nil payload on every path (see events.go, session.go, provider_claude.go,
  // provider_pi.go, provider_chat_base.go). It never carries an error — turn
  // failures travel as a separate { type:'error', sessionId, message } frame.
  // Don't reintroduce an `error` field; it would bless a shape the real relay
  // cannot produce.
  messageComplete: ({ sessionId } = {}) => ({ type: 'message_complete', sessionId }),
  error: ({ message }) => ({ type: 'error', message }),

  // Control frames eve forwards verbatim. Field names verified against the
  // real relayLLM source, not guessed — earlier guesses (`tool`/`input`, raw
  // terminal `data`) were wrong and gave false confidence.
  //   permission_request: relayLLM/api.go + events.go -> toolName / toolInput (string) / toolUseId
  permissionRequest: ({ sessionId, permissionId, toolName, toolInput = '{}', toolUseId }) =>
    ({ type: 'permission_request', sessionId, permissionId, toolName, toolInput, toolUseId }),
  //   terminal_output: relayLLM/main.go base64-encodes `data`; the browser _decodeBase64s it
  terminalOutput: ({ terminalId, data }) =>
    ({ type: 'terminal_output', terminalId, data: Buffer.from(String(data)).toString('base64') }),
  //   terminal_created / terminal_joined / terminal_list: relayLLM/ws.go.
  //   joinTerminalConn always answers a join with the full scrollback, which is
  //   why a re-join has to land on a cleared grid.
  terminalCreated: ({ terminalId, templateId = 'zsh', name = 'sh', directory = '/fake' }) =>
    ({ type: 'terminal_created', terminalId, templateId, name, directory }),
  terminalJoined: ({ terminalId, templateId = 'zsh', name = 'sh', directory = '/fake', state = 'running', cols = 80, rows = 24, scrollback = '' }) =>
    ({ type: 'terminal_joined', terminalId, templateId, name, directory, state, cols, rows, scrollback: Buffer.from(String(scrollback)).toString('base64') }),
  terminalList: ({ terminals }) => ({ type: 'terminal_list', terminals }),
};

// Mirrors eve's accumulation across all three assistant-text shapes, so a
// contract test can assert on real relay frames independent of eve's own
// implementation.
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

function validateRelayFrame(frame) {
  const errors = [];
  if (!frame || typeof frame !== 'object') return { ok: false, errors: ['frame is not an object'] };
  if (typeof frame.type !== 'string' || !frame.type) errors.push('missing/invalid type');

  if (frame.type === 'session_joined') {
    if (!frame.sessionId) errors.push('session_joined: missing sessionId');
  } else if (frame.type === 'message_complete') {
    if (!('sessionId' in frame)) errors.push('message_complete: missing sessionId');
  } else if (frame.type === 'error') {
    if (typeof frame.message !== 'string') errors.push('error: missing/invalid message');
  } else if (frame.type === 'llm_event') {
    if (!frame.event || typeof frame.event !== 'object') errors.push('llm_event: missing event');
    else if (frame.event.v !== EVENT_PROTOCOL_VERSION) {
      errors.push(`llm_event: event.v must be ${EVENT_PROTOCOL_VERSION} (got ${frame.event.v}) — client drops events without it`);
    } else if (frame.event.delta && typeof frame.event.delta.type !== 'string') {
      // The load-bearing contract is the version tag; assistant events come
      // in many structural variants, so payloads aren't enumerated here —
      // renderable text is checked separately via extractAssistantText.
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
