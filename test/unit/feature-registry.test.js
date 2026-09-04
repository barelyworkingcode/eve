/**
 * FeatureRegistry - see docs/decisions/001-feature-registry.md.
 *
 * jest runs with testEnvironment 'node' and nothing else here touches the DOM.
 * The registry's DOM surface is three methods (querySelectorAll, dataset.slot,
 * appendChild), so it is stubbed rather than pulling in jest-environment-jsdom
 * for that alone.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/ files are plain <script> globals, not modules.
const src = fs.readFileSync(path.join(__dirname, '../../public/core/feature-registry.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.FeatureRegistry = FeatureRegistry; this.features = features;', sandbox);
const { FeatureRegistry } = sandbox;

function fakeSlotEl(name) {
  return { dataset: { slot: name }, children: [], appendChild(n) { this.children.push(n); } };
}
function fakeRoot(...slotNames) {
  const els = slotNames.map(fakeSlotEl);
  return { els, querySelectorAll: () => els };
}
function fakeContainer() {
  const map = new Map();
  const handlers = [];
  const bus = { on: (e, h) => handlers.push([e, h]) };
  map.set('bus', bus);
  return {
    handlers,
    registered: map,
    register: (k, v) => map.set(k, v),
    get: (k) => map.get(k),
    has: (k) => map.has(k),
  };
}

describe('the page singleton', () => {
  // Feature files run the moment their <script> is parsed, long before
  // initApp(), so there must already be an instance for them to register
  // against. Without this, file-scope registration has nothing to call.
  it('exposes a ready-to-use `features` instance', () => {
    expect(sandbox.features).toBeInstanceOf(FeatureRegistry);
    expect(sandbox.features.ids()).toEqual([]);
  });
});

describe('FeatureRegistry', () => {
  it('register() does not construct anything', () => {
    const r = new FeatureRegistry();
    const init = jest.fn();
    r.register({ id: 'a', init });
    expect(init).not.toHaveBeenCalled();
    expect(r.ids()).toEqual(['a']);
  });

  it('boot() constructs each feature once and registers it under its id', () => {
    const r = new FeatureRegistry();
    const instance = { name: 'tts' };
    const init = jest.fn(() => instance);
    r.register({ id: 'tts', init });
    const c = fakeContainer();
    r.boot(c);
    expect(init).toHaveBeenCalledTimes(1);
    expect(c.get('tts')).toBe(instance);
  });

  it('boot() tolerates a feature with no init', () => {
    const r = new FeatureRegistry();
    r.register({ id: 'markup-only', slots: [] });
    expect(() => r.boot(fakeContainer())).not.toThrow();
  });

  it('rejects a duplicate id', () => {
    const r = new FeatureRegistry();
    r.register({ id: 'dup' });
    expect(() => r.register({ id: 'dup' })).toThrow(/duplicate feature id: dup/);
  });

  it('requires an id', () => {
    expect(() => new FeatureRegistry().register({})).toThrow(/needs an id/);
  });

  it('renders slot contributions in order, not registration order', () => {
    const r = new FeatureRegistry();
    r.register({ id: 'late', slots: [{ slot: 's', order: 30, render: () => 'c' }] });
    r.register({ id: 'early', slots: [{ slot: 's', order: 10, render: () => 'a' }] });
    r.register({ id: 'mid', slots: [{ slot: 's', order: 20, render: () => 'b' }] });
    const root = fakeRoot('s');
    r.renderSlots(root, fakeContainer());
    expect(root.els[0].children).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by registration order', () => {
    const r = new FeatureRegistry();
    r.register({ id: 'first', slots: [{ slot: 's', order: 5, render: () => 'first' }] });
    r.register({ id: 'second', slots: [{ slot: 's', order: 5, render: () => 'second' }] });
    const root = fakeRoot('s');
    r.renderSlots(root, fakeContainer());
    expect(root.els[0].children).toEqual(['first', 'second']);
  });

  it('skips a contribution that renders nothing', () => {
    const r = new FeatureRegistry();
    r.register({ id: 'maybe', slots: [{ slot: 's', order: 1, render: () => null }] });
    const root = fakeRoot('s');
    r.renderSlots(root, fakeContainer());
    expect(root.els[0].children).toEqual([]);
  });

  // A silently missing button is the failure this design exists to prevent.
  it('throws, naming slot and feature, when the slot is absent from the DOM', () => {
    const r = new FeatureRegistry();
    r.register({ id: 'tts', slots: [{ slot: 'nope', order: 1, render: () => 'x' }] });
    expect(() => r.renderSlots(fakeRoot('other'), fakeContainer()))
      .toThrow(/no \[data-slot="nope"\] in the DOM, contributed by: tts/);
  });

  it('an empty slot is fine', () => {
    const r = new FeatureRegistry();
    const root = fakeRoot('empty');
    expect(() => r.renderSlots(root, fakeContainer())).not.toThrow();
    expect(root.els[0].children).toEqual([]);
  });

  it('subscribes event handlers to the bus with the container bound', () => {
    const r = new FeatureRegistry();
    const handler = jest.fn();
    r.register({ id: 'f', events: { 'chat:done': handler } });
    const c = fakeContainer();
    r.boot(c);
    expect(c.handlers).toHaveLength(1);
    const [event, wrapped] = c.handlers[0];
    expect(event).toBe('chat:done');
    wrapped({ payload: 1 });
    expect(handler).toHaveBeenCalledWith({ payload: 1 }, c);
  });
});
