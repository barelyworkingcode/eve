// tab-manager.js carries a CommonJS `module.exports`, so it's required directly
// — no vm sandbox needed. It does need browser globals jest's `testEnvironment:
// 'node'` doesn't provide (`document`, `window`, `history`, `localStorage`);
// those are faked below rather than pulling in jsdom, which the repo has none of.
// Rendering-touching methods (switchToTab, closeTab, split-pane commit, the
// view/container dispatch) are covered against a real DOM in test/e2e/tab-panes.spec.js
// instead.

function fakeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
  };
}

function fakeElement() {
  return {
    classList: fakeClassList(),
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

function fakeDocument() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: () => fakeElement(),
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeLocalStorage(initial = {}) {
  let store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    _raw: () => store,
  };
}

function loadTabManager({ localStorageContents } = {}) {
  jest.resetModules();
  global.document = fakeDocument();
  global.window = {
    location: { hash: '', pathname: '/', search: '' },
    addEventListener() {},
  };
  global.history = { replaceState: jest.fn() };
  global.localStorage = fakeLocalStorage(localStorageContents);
  global.EVT = { PROJECT_ACTIVATED: 'project:activated' };
  // isPlanProject is a bare global in the browser (classic script), reached the
  // same way by file-pane.js's watch/unwatch, so it needs a fake here too.
  global.isPlanProject = () => false;
  // PaneDnd is deliberately left undefined — `typeof PaneDnd !== 'undefined'` guards it.
  return require('../../public/tab-manager.js');
}

function fakeContainer({ app: appOverrides = {}, bus: busOverrides = {} } = {}) {
  const app = { sessions: new Map(), projects: new Map(), ...appOverrides };
  const bus = { on: () => {}, ...busOverrides };
  return { get: (k) => (k === 'app' ? app : k === 'bus' ? bus : undefined) };
}

function makeTabManager(opts) {
  const TabManager = loadTabManager(opts);
  return new TabManager(fakeContainer(opts?.container));
}

describe('_getRecentEntries', () => {
  const KEY = 'eve-open-files';
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const NOW = 1_700_000_000_000;

  afterEach(() => jest.restoreAllMocks());

  it('keeps numeric and object entries within the TTL, drops both forms once expired, and prunes on write-back', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const stored = {
      'sess-fresh': NOW - 1000,
      'sess-stale': NOW - MAX_AGE_MS - 5000,
      'p1:/a.js': { projectId: 'p1', path: '/a.js', ts: NOW - 2000 },
      'p1:/b.js': { projectId: 'p1', path: '/b.js', ts: NOW - MAX_AGE_MS - 1 },
      'no-ts': { projectId: 'p1', path: '/c.js' },
    };
    const tm = makeTabManager({ localStorageContents: { [KEY]: JSON.stringify(stored) } });

    const result = tm._getRecentEntries(KEY);
    const ids = result.map((e) => e.id).sort();
    expect(ids).toEqual(['p1:/a.js', 'sess-fresh']);

    expect(result.find((e) => e.id === 'sess-fresh')).toEqual({ id: 'sess-fresh', ts: NOW - 1000 });
    expect(result.find((e) => e.id === 'p1:/a.js')).toEqual({ id: 'p1:/a.js', projectId: 'p1', path: '/a.js', ts: NOW - 2000 });

    const written = JSON.parse(localStorage.getItem(KEY));
    expect(Object.keys(written).sort()).toEqual(['p1:/a.js', 'sess-fresh']);
  });

  it('excludes an entry exactly at the MAX_AGE_MS boundary (now - ts === MAX_AGE_MS)', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const stored = {
      'just-under': NOW - (MAX_AGE_MS - 1),
      'exactly-at': NOW - MAX_AGE_MS,
    };
    const tm = makeTabManager({ localStorageContents: { [KEY]: JSON.stringify(stored) } });

    const ids = tm._getRecentEntries(KEY).map((e) => e.id);
    expect(ids).toEqual(['just-under']);
  });

  it('does not rewrite storage when nothing needed pruning', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const stored = { fresh: NOW - 10 };
    const tm = makeTabManager({ localStorageContents: { [KEY]: JSON.stringify(stored) } });
    const setItemSpy = jest.spyOn(localStorage, 'setItem');

    tm._getRecentEntries(KEY);
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});

describe('_projectIdForDirectory', () => {
  function tmWithProjects(projects) {
    const app = { projects: new Map(projects.map((p) => [p.id, p])) };
    return makeTabManager({ container: { app } });
  }

  it('returns null for a falsy directory without inspecting projects', () => {
    const tm = tmWithProjects([{ id: 'p1', path: '/work' }]);
    expect(tm._projectIdForDirectory('')).toBeNull();
    expect(tm._projectIdForDirectory(undefined)).toBeNull();
  });

  it('picks the longest matching prefix when one project path nests inside another', () => {
    const tm = tmWithProjects([
      { id: 'outer', path: '/Users/x/work' },
      { id: 'inner', path: '/Users/x/work/sub' },
    ]);
    expect(tm._projectIdForDirectory('/Users/x/work/sub/deep')).toBe('inner');
    expect(tm._projectIdForDirectory('/Users/x/work/other')).toBe('outer');
    expect(tm._projectIdForDirectory('/Users/x/work')).toBe('outer');
  });

  it('is case-insensitive and tolerates trailing slashes on either side', () => {
    const tm = tmWithProjects([{ id: 'p1', path: '/Users/x/Work/' }]);
    expect(tm._projectIdForDirectory('/USERS/X/WORK')).toBe('p1');
    expect(tm._projectIdForDirectory('/users/x/work/sub')).toBe('p1');
  });

  it('returns null when nothing matches, and skips projects with no path', () => {
    const tm = tmWithProjects([{ id: 'p1' }, { id: 'p2', path: '/elsewhere' }]);
    expect(tm._projectIdForDirectory('/Users/x/work')).toBeNull();
  });
});

describe('_nextTabInProject / _lastActiveTabForProject', () => {
  function tmWithTabs(tabs, activeProjectId) {
    const tm = makeTabManager();
    tm.tabs = tabs;
    tm._activeProjectId = activeProjectId;
    return tm;
  }

  it('_nextTabInProject prefers the tab that shifted into the closed index', () => {
    const tm = tmWithTabs([
      { id: 'x0', type: 'file', projectId: 'other' },
      { id: 'x1', type: 'file', projectId: 'p1' },
      { id: 'x2', type: 'file', projectId: 'p1' },
    ], 'p1');
    expect(tm._nextTabInProject(1).id).toBe('x1');
  });

  it('_nextTabInProject falls back to scanning left when nothing matches at or after the index', () => {
    const tm = tmWithTabs([
      { id: 'y0', type: 'file', projectId: 'p1' },
      { id: 'y1', type: 'file', projectId: 'other' },
    ], 'p1');
    expect(tm._nextTabInProject(1).id).toBe('y0');
  });

  it('_nextTabInProject skips nested panes even when their project matches', () => {
    const tm = tmWithTabs([
      { id: 'z0', type: 'file', projectId: 'p1', _nestedIn: 'host' },
      { id: 'z1', type: 'file', projectId: 'p1' },
    ], 'p1');
    expect(tm._nextTabInProject(0).id).toBe('z1');
  });

  it('_nextTabInProject returns null when no tab in the active project remains', () => {
    const tm = tmWithTabs([{ id: 'w0', type: 'file', projectId: 'other' }], 'p1');
    expect(tm._nextTabInProject(0)).toBeNull();
  });

  it('_lastActiveTabForProject returns the remembered tab when it still qualifies', () => {
    const tm = tmWithTabs([
      { id: 'r1', type: 'file', projectId: 'p1' },
      { id: 'r2', type: 'file', projectId: 'p1' },
    ]);
    tm._lastActiveByProject.set('p1', 'r1');
    expect(tm._lastActiveTabForProject('p1').id).toBe('r1');
  });

  it('_lastActiveTabForProject falls back to the rightmost matching tab once the remembered one is nested', () => {
    const tm = tmWithTabs([
      { id: 'r1', type: 'file', projectId: 'p1', _nestedIn: 'host' },
      { id: 'r2', type: 'file', projectId: 'p1' },
      { id: 'r3', type: 'file', projectId: 'other' },
    ]);
    tm._lastActiveByProject.set('p1', 'r1');
    expect(tm._lastActiveTabForProject('p1').id).toBe('r2');
  });

  it('_lastActiveTabForProject falls back to a rightmost scan with no remembered entry at all', () => {
    const tm = tmWithTabs([
      { id: 'r1', type: 'file', projectId: 'p1' },
      { id: 'r2', type: 'file', projectId: 'p1' },
    ]);
    expect(tm._lastActiveTabForProject('p1').id).toBe('r2');
  });

  it('_lastActiveTabForProject returns null when the project has no tabs at all', () => {
    const tm = tmWithTabs([{ id: 'r1', type: 'file', projectId: 'other' }]);
    expect(tm._lastActiveTabForProject('p1')).toBeNull();
  });
});

describe('_ownedBy — the LLM ownership gate', () => {
  const tm = makeTabManager();

  it('is false when the tab has no owner at all', () => {
    expect(tm._ownedBy({ }, { actor: 'llm', projectId: 'p1' })).toBe(false);
  });

  it('is false when the owner is not the llm actor', () => {
    const tab = { owner: { actor: 'user', projectId: 'p1' } };
    expect(tm._ownedBy(tab, { actor: 'llm', projectId: 'p1' })).toBe(false);
  });

  it('is false when the calling identity is not the llm actor', () => {
    const tab = { owner: { actor: 'llm', projectId: 'p1' } };
    expect(tm._ownedBy(tab, { actor: 'user', projectId: 'p1' })).toBe(false);
  });

  it('is false when the calling identity has no projectId', () => {
    const tab = { owner: { actor: 'llm', projectId: 'p1' } };
    expect(tm._ownedBy(tab, { actor: 'llm' })).toBe(false);
  });

  it('is false when the projects do not match (cross-project isolation)', () => {
    const tab = { owner: { actor: 'llm', projectId: 'p1' } };
    expect(tm._ownedBy(tab, { actor: 'llm', projectId: 'p2' })).toBe(false);
  });

  it('is false when identity is missing entirely', () => {
    const tab = { owner: { actor: 'llm', projectId: 'p1' } };
    expect(tm._ownedBy(tab, undefined)).toBe(false);
  });

  it('is true only when actor and project match on both sides', () => {
    const tab = { owner: { actor: 'llm', projectId: 'p1' } };
    expect(tm._ownedBy(tab, { actor: 'llm', projectId: 'p1' })).toBe(true);
  });
});

describe('_edgeToDir', () => {
  const tm = makeTabManager();

  it.each([
    ['left', { dir: 'row', before: true }],
    ['right', { dir: 'row', before: false }],
    ['top', { dir: 'col', before: true }],
    ['bottom', { dir: 'col', before: false }],
  ])('%s -> %j', (edge, expected) => {
    expect(tm._edgeToDir(edge)).toEqual(expected);
  });

  it('falls back to row/after for an unrecognised edge', () => {
    expect(tm._edgeToDir('nonsense')).toEqual({ dir: 'row', before: false });
    expect(tm._edgeToDir(undefined)).toEqual({ dir: 'row', before: false });
  });
});

describe('_updateHash', () => {
  function setup(hash = '') {
    const tm = makeTabManager();
    window.location.hash = hash;
    window.location.pathname = '/app';
    window.location.search = '?x=1';
    return tm;
  }

  it('builds #session/<id> with the id encoded', () => {
    const tm = setup();
    tm._updateHash({ type: 'session', id: 'sess a/b' });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', `#session/${encodeURIComponent('sess a/b')}`);
  });

  it('builds #file/<projectId>/<path> with both segments encoded independently', () => {
    const tm = setup();
    tm._updateHash({ type: 'file', projectId: 'p1', path: '/dir/a.js' });
    expect(history.replaceState).toHaveBeenCalledWith(
      null, '', `#file/p1/${encodeURIComponent('/dir/a.js')}`
    );
  });

  it('builds #terminal/<id>', () => {
    const tm = setup();
    tm._updateHash({ type: 'terminal', id: 'term-1' });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '#terminal/term-1');
  });

  it('builds #module/<projectId>/<moduleName>', () => {
    const tm = setup();
    tm._updateHash({ type: 'module', projectId: 'p1', moduleName: 'demo-module' });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '#module/p1/demo-module');
  });

  // Known bug, pinned deliberately: `_updateHash` has no `image` arm, so activating
  // an image tab clears the hash instead of linking to it. Don't "fix" this test.
  it('an image tab has no hash arm, so activating one clears the hash instead of linking to it', () => {
    const tm = setup('#session/old');
    tm._updateHash({ type: 'image', id: 'eve-llm-1' });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/app?x=1');
  });

  it('a null tab (empty state) also clears the hash', () => {
    const tm = setup('#session/old');
    tm._updateHash(null);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/app?x=1');
  });

  it('does not touch history when the computed hash already matches the current one', () => {
    const tm = setup('#session/abc');
    tm._updateHash({ type: 'session', id: 'abc' });
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});

// The fake relay can't create real terminals, so this is the only cover of
// terminal-pane.js's `dispose` at any tier. If `dispose` became a no-op, the
// xterm instance and its WS channel would leak on every close undetected.
describe('terminal dispose', () => {
  it('closes the terminal exactly once via terminalManager, and never persists', () => {
    const closeTerminal = jest.fn();
    const app = {
      showChatScreen: () => {},
      showWelcomeScreen: () => {},
      terminalManager: { closeTerminal, showTerminal: () => {}, fitActive: () => {} },
    };
    const tm = makeTabManager({ container: { app } });
    const setItemSpy = jest.spyOn(localStorage, 'setItem');

    tm.openTerminal('term-1', 'Terminal', '/work');
    tm.closeTab('term-1');

    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
    expect(setItemSpy).not.toHaveBeenCalled(); // terminals are deliberately never persisted
  });
});

// Pins the write shapes, including the legacy bare-number session entry, so e.g.
// dropping `moduleName` from module-pane.js's `entry()` fails here instead of
// only surfacing at reload-restore time.
describe('persistence write shapes (pinning, not changing)', () => {
  const NOW = 1_700_000_000_000;
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('openSession writes a bare-number entry to eve-open-sessions', () => {
    const app = { sessions: new Map([['sess-1', {}]]), showChatScreen: () => {} };
    const tm = makeTabManager({ container: { app } });
    tm.openSession('sess-1', { skipRender: true });
    expect(JSON.parse(localStorage.getItem('eve-open-sessions'))).toEqual({ 'sess-1': NOW });
  });

  it('openFile writes {projectId, path, ts} to eve-open-files', () => {
    const tm = makeTabManager({ container: { app: { showChatScreen: () => {} } } });
    tm.openFile('p1', '/a.js', 'a.js');
    expect(JSON.parse(localStorage.getItem('eve-open-files'))['p1:/a.js'])
      .toEqual({ projectId: 'p1', path: '/a.js', ts: NOW });
  });

  it('openModule writes {projectId, moduleName, ts} to eve-open-modules', () => {
    const tm = makeTabManager({ container: { app: { showChatScreen: () => {} } } });
    tm.openModule('p1', 'demo', 'Demo');
    expect(JSON.parse(localStorage.getItem('eve-open-modules'))['p1:demo'])
      .toEqual({ projectId: 'p1', moduleName: 'demo', ts: NOW });
  });
});
