/**
 * WsMessageRegistry - see ws/message-registry.js for the pattern and its
 * relationship to PaneRegistry (public/core/pane-registry.js /
 * test/unit/pane-registry.test.js), which this mirrors.
 *
 * Unlike PaneRegistry this is a plain Node module (real `require`, no
 * <script> globals), so no vm sandbox is needed — require it directly.
 */
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

  // The frozen six from spec §5b / C4. `create_session` (H3), `search_project`
  // and `search_ai_summarize` (H5, search-messages.js) and `module_invoke_ai`
  // (H5, module-messages.js) exist so far — `transcribe_audio` and `tts_speak`
  // land in H6. This asserts the *mechanism*, not the eventual membership. The
  // membership itself is asserted end-to-end once every expensive type has a
  // descriptor (spec §12-H6).
  it('carries exactly the expensive types registered so far', () => {
    expect(messages.expensiveTypes()).toEqual(new Set([
      'create_session', 'search_project', 'search_ai_summarize', 'module_invoke_ai',
    ]));
  });
});

// C2 (spec §5c / §7): a descriptor's `handle` must be an async function if
// and only if today's `case` arm is awaited — currently exactly
// `create_session`, `module_read_file`, `module_write_file`. Returning a
// promise for any other type turns a fire-and-forget rejection into a
// browser-visible `{type:'error'}` frame it has never produced before. This
// passes trivially today (only the terminal domain is registered, and none
// of its nine handles are async); it becomes load-bearing at the session and
// module handoffs.
describe('constraint C2 — handle is async iff its case arm is awaited today', () => {
  const AWAITED_TYPES = new Set(['create_session', 'module_read_file', 'module_write_file']);

  it('every registered descriptor matches the awaited-arm set', () => {
    for (const type of messages.types()) {
      const isAsync = messages.get(type).handle.constructor.name === 'AsyncFunction';
      expect(isAsync).toBe(AWAITED_TYPES.has(type));
    }
  });
});
