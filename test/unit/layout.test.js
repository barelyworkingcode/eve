// Layout (S2-A1, A3): written from docs/design-today-s2.md against a fake
// window, history and matchMedia.
const { loadConstants, loadEventBus } = require('./helpers/fake-dom');
const { EVT } = loadConstants();
const EventBus = loadEventBus();
global.EVT = EVT;
const Layout = require('../../public/core/layout.js');

function fakeWindow({ width = 1280, coarse = false, state = null, hash = '' } = {}) {
  const listeners = {};
  const mqls = [];
  const win = {
    innerWidth: width,
    coarse,
    document: { documentElement: { dataset: {} } },
    location: { pathname: '/', search: '', hash },
    stack: [{ state, hash }],
    index: 0,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    matchMedia(q) {
      const mql = {
        query: q,
        handlers: [],
        get matches() {
          if (q === Layout.QUERIES.notWide) return win.innerWidth <= 1023.98;
          if (q === Layout.QUERIES.compact) return win.innerWidth <= 599.98;
          if (q === Layout.QUERIES.coarse) return win.coarse;
          throw new Error(`unexpected query ${q}`);
        },
        addEventListener(_t, fn) { mql.handlers.push(fn); },
      };
      mqls.push(mql);
      return mql;
    },
    resize(w) { win.innerWidth = w; mqls.forEach((m) => m.handlers.forEach((h) => h())); },
    firePop(state) { (listeners.popstate || []).forEach((fn) => fn({ state })); },
  };
  const sync = () => {
    const e = win.stack[win.index];
    win.history.state = e.state;
    win.location.hash = e.hash;
  };
  const hashOf = (u) => { const i = u.indexOf('#'); return i < 0 ? '' : u.slice(i); };
  win.history = {
    state,
    pushState(s, _t, url) {
      win.stack.splice(win.index + 1);
      win.stack.push({ state: s, hash: hashOf(url) });
      win.index++;
      sync();
    },
    replaceState(s, _t, url) { win.stack[win.index] = { state: s, hash: hashOf(url) }; sync(); },
    back() { win.index--; sync(); win.firePop(win.history.state); },
  };
  return win;
}

function make(opts) {
  const win = fakeWindow(opts);
  const bus = new EventBus();
  const events = [];
  bus.on(EVT.LAYOUT_CHANGED, (d) => events.push(['layout', d]));
  bus.on(EVT.NAV_CHANGED, (d) => events.push(['nav', d]));
  const layout = new Layout({ bus, win });
  layout.init();
  return { win, layout, events };
}

describe('Layout.classify', () => {
  test.each([[599, 'compact'], [600, 'regular'], [1023, 'regular'], [1024, 'wide'], [320, 'compact'], [1366, 'wide']])(
    '%i is %s', (w, name) => { expect(Layout.classify(w)).toBe(name); });

  test('QUERIES are the exact strings', () => {
    expect(Layout.QUERIES).toEqual({
      notWide: '(max-width: 1023.98px)', compact: '(max-width: 599.98px)', coarse: '(pointer: coarse)',
    });
  });
});

describe('Layout init and resize', () => {
  test('init sets the html attributes and live fields', () => {
    const { win, layout } = make({ width: 834, coarse: true });
    expect(win.document.documentElement.dataset).toEqual({ layout: 'regular', nav: 'root' });
    expect(layout.name).toBe('regular');
    expect(layout.coarse).toBe(true);
    expect(layout.depth).toBe(0);
  });

  test('1024 to 1023 and 600 to 599 each flip once with one event', () => {
    const { win, layout, events } = make({ width: 1024 });
    win.resize(1023);
    expect(layout.name).toBe('regular');
    expect(events).toEqual([['layout', { name: 'regular', previous: 'wide', coarse: false }]]);
    win.resize(600);
    expect(events).toHaveLength(1);
    win.resize(599);
    expect(layout.name).toBe('compact');
    expect(win.document.documentElement.dataset.layout).toBe('compact');
    expect(events).toHaveLength(2);
    expect(events[1][1]).toEqual({ name: 'compact', previous: 'regular', coarse: false });
  });

  test('a jump across two breakpoints emits one event', () => {
    const { win, events } = make({ width: 1300 });
    win.resize(400);
    expect(events).toEqual([['layout', { name: 'compact', previous: 'wide', coarse: false }]]);
  });
});

describe('Layout navigation, compact', () => {
  test('Today to a view pushes one entry, depth 1', () => {
    const { win, layout, events } = make({ width: 390 });
    layout.navigate('#session/a', 'a');
    expect(win.stack).toHaveLength(2);
    expect(win.history.state).toEqual({ eveNav: 1, tabId: 'a' });
    expect(win.location.hash).toBe('#session/a');
    expect(layout.depth).toBe(1);
    expect(win.document.documentElement.dataset.nav).toBe('pushed');
    expect(events).toEqual([['nav', { depth: 1, tabId: 'a', source: 'app' }]]);
  });

  test('a view while pushed replaces, no new entry', () => {
    const { win, layout } = make({ width: 390 });
    layout.navigate('#session/a', 'a');
    layout.navigate('#session/b', 'b');
    expect(win.stack).toHaveLength(2);
    expect(win.location.hash).toBe('#session/b');
    expect(win.history.state).toEqual({ eveNav: 1, tabId: 'b' });
    expect(layout.depth).toBe(1);
  });

  test('navigate(null) from a pushed view goes back through history and strips the hash', () => {
    const { win, layout, events } = make({ width: 390 });
    layout.navigate('#session/a', 'a');
    events.length = 0;
    layout.navigate(null, null);
    expect(win.index).toBe(0);
    expect(win.location.hash).toBe('');
    expect(layout.depth).toBe(0);
    expect(events).toEqual([['nav', { depth: 0, tabId: null, source: 'history' }]]);
  });

  test('in-app back() pops the entry it pushed', () => {
    const { win, layout } = make({ width: 390 });
    layout.navigate('#session/a', 'a');
    layout.back();
    expect(win.index).toBe(0);
    expect(layout.depth).toBe(0);
    expect(win.document.documentElement.dataset.nav).toBe('root');
  });

  test('browser Back then Forward moves depth with the history, tab id from state', () => {
    const { win, layout, events } = make({ width: 390 });
    layout.navigate('#session/a', 'a');
    events.length = 0;
    win.index = 0; win.history.state = win.stack[0].state; win.location.hash = '';
    win.firePop(null);
    expect(layout.depth).toBe(0);
    win.index = 1; win.history.state = win.stack[1].state; win.location.hash = '#session/a';
    win.firePop({ eveNav: 1, tabId: 'a' });
    expect(layout.depth).toBe(1);
    expect(events.map((e) => e[1])).toEqual([
      { depth: 0, tabId: null, source: 'history' },
      { depth: 1, tabId: 'a', source: 'history' },
    ]);
  });

  test('popping to a Today entry that carries a hash strips it', () => {
    const { win, layout } = make({ width: 390, state: null, hash: '#session/a' });
    layout.navigate('#session/a', 'a');
    layout.navigate('#session/b', 'b');
    win.index = 0; win.history.state = null; win.location.hash = '#session/a';
    win.firePop(null);
    expect(layout.depth).toBe(0);
    expect(win.location.hash).toBe('');
  });

  test('reload on a pushed entry starts at depth 1; Today then replaces instead of back()', () => {
    const { win, layout } = make({ width: 390, state: { eveNav: 1, tabId: 'a' }, hash: '#session/a' });
    expect(layout.depth).toBe(1);
    const spy = jest.spyOn(win.history, 'back');
    layout.navigate(null, null);
    expect(spy).not.toHaveBeenCalled();
    expect(win.stack).toHaveLength(1);
    expect(win.history.state).toEqual({ eveNav: 0 });
    expect(win.location.hash).toBe('');
    expect(layout.depth).toBe(0);
  });

  test('back() at depth 0 does nothing', () => {
    const { win, layout, events } = make({ width: 390 });
    layout.back();
    expect(win.stack).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('Layout navigation, wide and regular', () => {
  test.each([1280, 834])('at %i a tab switch replaces, never pushes', (w) => {
    const { win, layout } = make({ width: w });
    layout.navigate('#session/a', 'a');
    layout.navigate('#session/b', 'b');
    layout.navigate(null, null);
    expect(win.stack).toHaveLength(1);
    expect(win.location.hash).toBe('');
    expect(layout.depth).toBe(0);
  });

  test('a tab switch emits NAV_CHANGED so a slide-over can close', () => {
    const { layout, events } = make({ width: 834 });
    layout.navigate('#session/a', 'a');
    expect(events).toEqual([['nav', { depth: 0, tabId: 'a', source: 'app' }]]);
  });

  test('popstate is ignored off compact', () => {
    const { win, events } = make({ width: 834 });
    win.firePop({ eveNav: 1, tabId: 'a' });
    expect(events).toEqual([]);
  });
});
