/**
 * ChatFormControls (public/features/chat-form.js) — the send/stop toggle
 * logic phase 3 pulled out of app.js's showStopButton/hideStopButton/
 * showSessionStarting/clearSessionStarting.
 *
 * jest runs with testEnvironment 'node'; the file is a plain <script> global
 * (no module.exports), so it's loaded into a vm sandbox with a fake `features`
 * registry and a fake `document`, following test/unit/feature-registry.test.js.
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
    _set: set,
  };
}

function fakeButton() {
  const listeners = {};
  return {
    dataset: {},
    classList: fakeClassList(),
    disabled: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn()); },
  };
}

function loadChatForm() {
  const src = fs.readFileSync(path.join(__dirname, '../../public/features/chat-form.js'), 'utf8');
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

describe('ChatFormControls', () => {
  it('showStop hides send and reveals stop; hideStop is the exact inverse', () => {
    const feature = loadChatForm();
    const controls = feature.init(fakeContainer());
    controls.sendBtn = fakeButton();
    controls.stopBtn = fakeButton();
    controls.stopBtn.classList.add('hidden'); // initial render state: stop starts hidden

    controls.showStop();
    expect(controls.sendBtn.classList.contains('hidden')).toBe(true);
    expect(controls.stopBtn.classList.contains('hidden')).toBe(false);

    controls.hideStop();
    expect(controls.stopBtn.classList.contains('hidden')).toBe(true);
    expect(controls.sendBtn.classList.contains('hidden')).toBe(false);
  });

  it('setSubmitEnabled toggles disabled on the send button only', () => {
    const feature = loadChatForm();
    const controls = feature.init(fakeContainer());
    controls.sendBtn = fakeButton();

    controls.setSubmitEnabled(false);
    expect(controls.sendBtn.disabled).toBe(true);
    controls.setSubmitEnabled(true);
    expect(controls.sendBtn.disabled).toBe(false);
  });

  // Boundary: renderSlots() may not have run yet (or a test double never
  // assigns the buttons). The `?.` guards are the whole point of this class
  // existing instead of two raw classList calls in app.js.
  it('is a no-op, not a throw, before the buttons are assigned', () => {
    const feature = loadChatForm();
    const controls = feature.init(fakeContainer());
    expect(() => controls.showStop()).not.toThrow();
    expect(() => controls.hideStop()).not.toThrow();
    expect(() => controls.setSubmitEnabled(false)).not.toThrow();
  });

  it("the stop button's render closure wires its click to app.handleStop()", () => {
    const feature = loadChatForm();
    const handleStop = jest.fn();
    const map = new Map();
    map.set('chatForm', feature.init({}));
    map.set('app', { handleStop });
    const container = fakeContainer(map);

    const stopSlot = feature.slots.find((s) => s.order === 30);
    const btn = stopSlot.render(container);
    btn.click();

    expect(handleStop).toHaveBeenCalledTimes(1);
    expect(container.get('chatForm').stopBtn).toBe(btn);
  });
});
