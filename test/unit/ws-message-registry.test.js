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

  // The frozen six from spec §5b / C4. None of them exist yet in H2 (only
  // the terminal domain is registered so far, and no terminal type is
  // expensive) — this asserts the *mechanism*, not the eventual membership.
  // The membership itself is asserted end-to-end once every expensive type
  // has a descriptor (spec §12-H6).
  it('none of the terminal descriptors are marked expensive', () => {
    expect(messages.expensiveTypes().size).toBe(0);
  });
});
