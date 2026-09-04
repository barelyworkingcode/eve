// Plain Node module (real `require`, no <script> globals), so no vm sandbox is
// needed here, unlike PaneRegistry (public/core/pane-registry.js).
const { WsMessageRegistry, messages } = require('../../ws/message-registry');

describe('the process-wide singleton', () => {
  it('is loaded with the terminal domain already registered', () => {
    expect(messages).toBeInstanceOf(WsMessageRegistry);
    expect(messages.types()).toEqual(expect.arrayContaining([
      'terminal_create', 'terminal_input', 'terminal_resize', 'terminal_close',
      'terminal_list', 'terminal_reconnect', 'join_terminal', 'leave_terminal',
      'terminal_templates',
    ]));
  });
});

describe('WsMessageRegistry.register / .get / .has', () => {
  it('registers a descriptor and looks it up by type', () => {
    const r = new WsMessageRegistry();
    const d = { type: 'ping_pong', handle() {} };
    r.register(d);
    expect(r.get('ping_pong')).toBe(d);
    expect(r.has('ping_pong')).toBe(true);
  });

  it('returns null, not undefined, for an unregistered type', () => {
    const r = new WsMessageRegistry();
    expect(r.get('nope')).toBeNull();
    expect(r.has('nope')).toBe(false);
  });

  it('requires a type', () => {
    const r = new WsMessageRegistry();
    expect(() => r.register({ handle() {} })).toThrow(/needs a type/);
  });

  it('requires a handle function', () => {
    const r = new WsMessageRegistry();
    expect(() => r.register({ type: 'no_handle' })).toThrow(/needs a handle function/);
    expect(() => r.register({ type: 'bad_handle', handle: 'nope' })).toThrow(/needs a handle function/);
  });

  it('rejects a duplicate type', () => {
    const r = new WsMessageRegistry();
    r.register({ type: 'dup', handle() {} });
    expect(() => r.register({ type: 'dup', handle() {} })).toThrow(/duplicate message type: dup/);
  });

  it('types() returns registered types in registration order', () => {
    const r = new WsMessageRegistry();
    r.register({ type: 'b', handle() {} });
    r.register({ type: 'a', handle() {} });
    r.register({ type: 'c', handle() {} });
    expect(r.types()).toEqual(['b', 'a', 'c']);
  });

  it('register constructs nothing', () => {
    const r = new WsMessageRegistry();
    const handle = jest.fn();
    r.register({ type: 'x', handle });
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('WsMessageRegistry.expensiveTypes', () => {
  it('is empty when no descriptor opts in', () => {
    const r = new WsMessageRegistry();
    r.register({ type: 'a', handle() {} });
    r.register({ type: 'b', handle() {}, expensive: false });
    expect(r.expensiveTypes()).toEqual(new Set());
  });

  it('collects exactly the descriptors marked expensive: true', () => {
    const r = new WsMessageRegistry();
    r.register({ type: 'cheap', handle() {} });
    r.register({ type: 'pricey', handle() {}, expensive: true });
    expect(r.expensiveTypes()).toEqual(new Set(['pricey']));
  });

  // descriptor.expensive is the only source of rate-limit membership left in the
  // process, so this is the sole guard against an expensive type silently losing
  // its rate-limit cap.
  it('carries exactly the six frozen expensive types', () => {
    expect(messages.expensiveTypes()).toEqual(new Set([
      'create_session', 'search_project', 'search_ai_summarize', 'module_invoke_ai',
      'transcribe_audio', 'tts_speak',
    ]));
  });
});

// A descriptor's `handle` must be an async function iff the ws-handler `case` arm it
// replaces is awaited: returning a promise for a non-awaited type turns a
// fire-and-forget rejection into a browser-visible `{type:'error'}` frame it never
// produced before, and an unawaited async handler changes ordering on the wire.
describe('constraint C2 — handle is async iff its case arm is awaited today', () => {
  const AWAITED_TYPES = new Set(['create_session', 'module_read_file', 'module_write_file']);

  it('every registered descriptor matches the awaited-arm set', () => {
    for (const type of messages.types()) {
      const isAsync = messages.get(type).handle.constructor.name === 'AsyncFunction';
      expect(isAsync).toBe(AWAITED_TYPES.has(type));
    }
  });
});
