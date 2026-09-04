/**
 * PermissionModeControl (public/features/permissions.js) — the plan-mode
 * button's .active-class sync, moved out of message-dispatcher.js's
 * getElementById('planModeBtn') and out of app.js's click handler.
 *
 * Loaded into a vm sandbox with a fake `features` registry and `document`,
 * following test/unit/feature-registry.test.js — the file is a plain
 * <script> global, not a module.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle(c, force) {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
  };
}

function fakeButton() {
  const listeners = {};
  return {
    dataset: {},
    classList: fakeClassList(),
    hidden: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn()); },
  };
}

function loadPermissions() {
  const src = fs.readFileSync(path.join(__dirname, '../../public/features/permissions.js'), 'utf8');
  const sandbox = {
    document: { createElement: () => fakeButton() },
  };
  vm.createContext(sandbox);
  let captured = null;
  sandbox.features = { register: (cfg) => { captured = cfg; } };
  vm.runInContext(src, sandbox);
  return captured;
}

function fakeContainer(map = new Map()) {
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, v) };
}

describe('PermissionModeControl', () => {
  it("syncMode('plan') activates, any other mode deactivates", () => {
    const feature = loadPermissions();
    const control = feature.init(fakeContainer());
    control.button = fakeButton();

    control.syncMode('plan');
    expect(control.button.classList.contains('active')).toBe(true);

    control.syncMode('default');
    expect(control.button.classList.contains('active')).toBe(false);
  });

  it('syncMode and setAvailable are no-ops before the button is assigned', () => {
    const feature = loadPermissions();
    const control = feature.init(fakeContainer());
    expect(() => control.syncMode('plan')).not.toThrow();
    expect(() => control.setAvailable(false)).not.toThrow();
  });

  it('setAvailable(false) hides the button, setAvailable(true) reveals it', () => {
    const feature = loadPermissions();
    const control = feature.init(fakeContainer());
    control.button = fakeButton();

    control.setAvailable(false);
    expect(control.button.hidden).toBe(true);
    control.setAvailable(true);
    expect(control.button.hidden).toBe(false);
  });

  it('the click handler is a no-op without a current session', () => {
    const feature = loadPermissions();
    const map = new Map();
    map.set('permissions', feature.init({}));
    const send = jest.fn();
    map.set('app', { currentSessionId: null, wsClient: { send } });
    const container = fakeContainer(map);

    const btn = feature.slots[0].render(container);
    btn.click();

    expect(send).not.toHaveBeenCalled();
  });

  it('a click asks the server to toggle: default -> plan', () => {
    const feature = loadPermissions();
    const map = new Map();
    map.set('permissions', feature.init({}));
    const send = jest.fn();
    map.set('app', { currentSessionId: 'sess-1', wsClient: { send } });
    const container = fakeContainer(map);

    const btn = feature.slots[0].render(container);
    // The button starts without .active — production initial state.
    btn.click();

    expect(send).toHaveBeenCalledWith({ type: 'set_permission_mode', sessionId: 'sess-1', mode: 'plan' });
  });

  it('a click asks the server to toggle: plan -> default, reading the live .active class', () => {
    const feature = loadPermissions();
    const map = new Map();
    map.set('permissions', feature.init({}));
    const send = jest.fn();
    map.set('app', { currentSessionId: 'sess-1', wsClient: { send } });
    const container = fakeContainer(map);

    const btn = feature.slots[0].render(container);
    btn.classList.add('active'); // simulate a prior mode_changed('plan') from the server
    btn.click();

    expect(send).toHaveBeenCalledWith({ type: 'set_permission_mode', sessionId: 'sess-1', mode: 'default' });
  });
});
