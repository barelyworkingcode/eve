// S1-A6: Today lays out whatever is registered for the mode, in order; a part that
// throws becomes its own error line and touches no other. docs/design-today-s1.md
const { TodayRegistry, TodayHost } = require('../../public/today/today-parts');

// The smallest DOM the host needs.
function el(tag = 'div') {
  const node = {
    tag, children: [], dataset: {}, attrs: {}, textContent: '', parent: null,
    appendChild(c) { c.parent = node; node.children.push(c); return c; },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); },
    setAttribute(k, v) { node.attrs[k] = v; },
    addEventListener() {},
    querySelector() { return null; },
  };
  return node;
}
const doc = { createElement: (t) => el(t) };

const makePart = (id, order, modes = ['home', 'work'], extra = {}) => {
  const log = [];
  return {
    id, order, modes, log,
    mount: (root) => { log.push('mount'); root.textContent = id; },
    refresh: () => { log.push('refresh'); },
    destroy: () => { log.push('destroy'); },
    ...extra,
  };
};

describe('TodayRegistry', () => {
  it('lists the parts for a mode in order', () => {
    const r = new TodayRegistry();
    r.register(makePart('c', 30));
    r.register(makePart('a', 10));
    r.register(makePart('b', 20, ['work']));
    r.register(makePart('h', 5, ['home']));
    expect(r.partsFor('work').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(r.partsFor('home').map((p) => p.id)).toEqual(['h', 'a', 'c']);
  });

  it('registering the same id replaces the part; unregister removes it', () => {
    const r = new TodayRegistry();
    r.register(makePart('a', 10));
    r.register(makePart('a', 99));
    expect(r.partsFor('work').map((p) => p.order)).toEqual([99]);
    r.unregister('a');
    expect(r.partsFor('work')).toEqual([]);
  });
});

describe('TodayHost', () => {
  const host = (registry) => new TodayHost({ registry, doc, ctxFor: () => ({}) });

  it('mounts a part registered later with no change to the host', () => {
    const r = new TodayRegistry();
    r.register(makePart('a', 10));
    const root = el();
    const h = host(r);
    h.mount(root, 'work');
    const late = makePart('zz-test-only', 50);
    r.register(late);
    h.setMode('work');
    expect(late.log).toContain('mount');
    expect(root.children.map((c) => c.dataset.testid)).toEqual(['today-part-a', 'today-part-zz-test-only']);
  });

  it('a part that throws in mount becomes its own error line; the others are untouched', () => {
    const r = new TodayRegistry();
    const bad = makePart('bad', 20, undefined, { mount: () => { throw new Error('boom'); } });
    const good = makePart('good', 30);
    r.register(makePart('first', 10));
    r.register(bad);
    r.register(good);
    const root = el();
    host(r).mount(root, 'work');
    const byId = Object.fromEntries(root.children.map((c) => [c.dataset.testid, c]));
    expect(byId['today-part-bad']?.dataset?.state).toBe('error');
    expect(byId['today-part-first']?.dataset?.state).toBe('ready');
    expect(byId['today-part-good']?.dataset?.state).toBe('ready');
    expect(good.log).toContain('mount');
  });

  it('a throw in refresh or destroy is contained the same way', () => {
    const r = new TodayRegistry();
    const bad = makePart('bad', 10, undefined, { refresh: () => { throw new Error('r'); }, destroy: () => { throw new Error('d'); } });
    const good = makePart('good', 20);
    r.register(bad);
    r.register(good);
    const h = host(r);
    h.mount(el(), 'work');
    expect(() => h.refresh('bad')).not.toThrow();
    expect(() => h.destroy()).not.toThrow();
    expect(good.log).toContain('destroy');
  });

  it('switching mode destroys parts not in the new mode and mounts the new ones', () => {
    const r = new TodayRegistry();
    const both = makePart('both', 10);
    const w = makePart('w', 20, ['work']);
    const hm = makePart('hm', 20, ['home']);
    [both, w, hm].forEach((p) => r.register(p));
    const h = host(r);
    h.mount(el(), 'work');
    h.setMode('home');
    expect(w.log).toEqual(['mount', 'destroy']);
    expect(hm.log).toEqual(['mount']);
    expect(both.log).toEqual(['mount']);
  });
});
