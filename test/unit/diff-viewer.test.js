// Diff pane (docs/design-git-changes.md, "Opening a file: the diff pane").
// diff-viewer.js exports DiffViewer; panes/diff-pane.js registers the `diff`
// pane type/view on the `panes` singleton that core/pane-registry.js
// publishes when required from Node. Monaco is a stub — the real editor is
// covered by test/e2e/changes-panel.spec.js — and the DOM is the small fake
// in helpers/fake-dom.js (no jsdom in this repo).
const {
  createDocument,
  fakeLocalStorage,
  byTestId,
  loadConstants,
  loadEventBus,
} = require('./helpers/fake-dom');

const { EVT } = loadConstants();
const EventBus = loadEventBus();

const WS_OPEN = 1;

function fakeMonaco() {
  const models = [];
  const editors = [];
  const editor = {
    createModel: jest.fn((value, language) => {
      const m = {
        value,
        language,
        disposed: false,
        getValue() { return this.value; },
        setValue: jest.fn(function setValue(v) { this.value = v; }),
        dispose: jest.fn(function dispose() { this.disposed = true; }),
      };
      models.push(m);
      return m;
    }),
    createDiffEditor: jest.fn((el, options) => {
      const ed = {
        el,
        options: { ...options },
        model: null,
        getModel() { return this.model; },
        setModel: jest.fn(function setModel(m) { this.model = m; }),
        updateOptions: jest.fn(function updateOptions(o) { Object.assign(this.options, o); }),
        layout: jest.fn(),
        saveViewState: jest.fn(() => ({ scrollTop: 42 })),
        restoreViewState: jest.fn(),
        dispose: jest.fn(),
      };
      editors.push(ed);
      return ed;
    }),
    setTheme: jest.fn(),
  };
  return { editor, models, editors };
}

function setup({ storage = {}, innerWidth = 1200, wsOpen = true } = {}) {
  jest.resetModules();
  global.document = createDocument();
  const host = document.createElement('div');
  host.id = 'diffPane';
  host.className = 'diff-pane hidden';
  host.dataset.testid = 'diff-pane';
  document.body.appendChild(host);

  global.localStorage = fakeLocalStorage(storage);
  global.EVT = EVT;
  global.WebSocket = { OPEN: WS_OPEN };
  global.isPlanProject = () => false;
  global.history = { replaceState: jest.fn() };
  const monaco = fakeMonaco();
  global.window = {
    innerWidth,
    monaco,
    location: { hash: '', pathname: '/', search: '' },
    addEventListener() {},
  };

  const { panes } = require('../../public/core/pane-registry.js');
  const DiffViewer = require('../../public/diff-viewer.js');

  const bus = new EventBus();
  const ws = { readyState: wsOpen ? WS_OPEN : 3, send: jest.fn() };
  const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
  const services = { bus, logger };
  const container = {
    get: (k) => services[k],
    has: (k) => Object.prototype.hasOwnProperty.call(services, k),
  };
  const ctx = { container };

  // Mirrors TabManager#openPane + switchToTab's view dispatch, and closeTab's
  // descriptor dispose, through the REAL diff pane descriptors.
  const tabManager = {
    tabs: [],
    activeTabId: null,
    openPane: jest.fn((type, spec) => {
      const d = panes.type(type);
      const tab = d.create(spec, ctx);
      if (!tabManager.tabs.some((t) => t.id === tab.id)) tabManager.tabs.push(tab);
      tabManager.show(tab.id);
    }),
    show(tabId) {
      const tab = tabManager.tabs.find((t) => t.id === tabId);
      const d = panes.type(tab.type);
      const view = panes.view(d.view(tab, ctx));
      tabManager.activeTabId = tabId;
      view.show(d.ref(tab, ctx), ctx, document.getElementById(view.elementId));
    },
    closeTab(tabId) {
      const tab = tabManager.tabs.find((t) => t.id === tabId);
      tabManager.tabs = tabManager.tabs.filter((t) => t.id !== tabId);
      panes.type(tab.type).dispose(tab, ctx);
    },
    openFile: jest.fn(),
  };

  const app = {
    tabManager,
    ws,
    settings: { isLight: () => false, get: () => 13, getTerminalFontStack: () => 'monospace' },
    fileEditor: { detectLanguage: (p) => (p.endsWith('.js') ? 'javascript' : 'plaintext') },
  };
  services.app = app;
  const viewer = new DiffViewer(container);
  services.diffViewer = viewer;

  return { DiffViewer, viewer, panes, bus, ws, tabManager, app, monaco, host };
}

function spec(overrides = {}) {
  return {
    projectId: 'p1', repo: '/feat-login', repoName: 'feat-login', branch: 'feat/login',
    path: 'routes/auth.js', oldPath: null, status: 'M', scope: 'uncommitted', ...overrides,
  };
}

function versions(s, overrides = {}) {
  return {
    type: 'git_file_versions', projectId: s.projectId, repo: s.repo, path: s.path, scope: s.scope || 'uncommitted',
    original: 'const t = read();\n', modified: 'const t = await read();\n',
    binary: false, tooLarge: false, originalSize: 18, modifiedSize: 24, ...overrides,
  };
}

function sent(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function message(host) {
  return host.querySelector('.diff-pane__message');
}

describe('diff pane descriptor', () => {
  it('keys the tab diff:<projectId>:<repo>:<path> and labels it with the file name', () => {
    const { panes } = setup();
    const tab = panes.type('diff').create(spec());
    expect(tab).toMatchObject({
      id: 'diff:p1:/feat-login:routes/auth.js',
      type: 'diff',
      label: 'auth.js',
      title: 'feat-login · feat/login',
      projectId: 'p1',
    });
  });

  it('is not persisted across reloads', () => {
    const { panes } = setup();
    expect(panes.type('diff').persist).toBeUndefined();
  });
});

describe('TabManager#openPane', () => {
  it('opens a diff tab once and focuses it on re-open', () => {
    setup();
    const TabManager = require('../../public/tab-manager.js');
    const bus = { on: () => {} };
    const tm = new TabManager({ get: (k) => (k === 'bus' ? bus : k === 'app' ? {} : undefined), has: () => false });
    tm.switchToTab = jest.fn();

    tm.openPane('diff', spec());
    tm.openPane('diff', spec());
    expect(tm.tabs.map((t) => t.id)).toEqual(['diff:p1:/feat-login:routes/auth.js']);
    expect(tm.switchToTab).toHaveBeenCalledTimes(2);
    expect(tm.switchToTab).toHaveBeenLastCalledWith('diff:p1:/feat-login:routes/auth.js');
  });

  it('ignores an unknown pane type', () => {
    setup();
    const TabManager = require('../../public/tab-manager.js');
    const tm = new TabManager({ get: (k) => (k === 'bus' ? { on() {} } : {}), has: () => false });
    tm.switchToTab = jest.fn();
    tm.openPane('nope', {});
    expect(tm.tabs).toEqual([]);
    expect(tm.switchToTab).not.toHaveBeenCalled();
  });
});

describe('DiffViewer opening a diff', () => {
  it('git:open-diff opens a diff tab and requests git_file_versions', () => {
    const { bus, tabManager, ws, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    expect(tabManager.tabs.map((t) => t.id)).toEqual(['diff:p1:/feat-login:routes/auth.js']);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(sent(ws)).toEqual([{
      type: 'git_file_versions', projectId: 'p1', repo: '/feat-login', path: 'routes/auth.js', scope: 'uncommitted',
    }]);
  });

  it('defaults a missing scope to uncommitted', () => {
    const { bus, ws } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ scope: undefined }));
    expect(sent(ws)[0].scope).toBe('uncommitted');
  });

  it('ignores an open without projectId, repo or path', () => {
    const { bus, tabManager } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ path: '' }));
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ repo: undefined }));
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ projectId: null }));
    expect(tabManager.openPane).not.toHaveBeenCalled();
  });

  it('re-opening the same file focuses the existing tab without refetching', async () => {
    const { bus, tabManager, ws } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    expect(tabManager.tabs).toHaveLength(1);
    expect(tabManager.openPane).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('re-opening in the other scope refetches in that scope', () => {
    const { bus, ws } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ scope: 'base' }));
    expect(sent(ws).map((f) => f.scope)).toEqual(['uncommitted', 'base']);
  });

  it('renders the header: status, file name, repo and branch', () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    expect(byTestId(host, 'diff-status').textContent).toBe('M');
    expect(byTestId(host, 'diff-name').textContent).toBe('auth.js');
    expect(byTestId(host, 'diff-meta').textContent).toBe('feat-login · ⎇ feat/login');
  });

  it('names a rename "old → new"', () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ status: 'R', path: 'public/login.css', oldPath: 'public/signin.css' }));
    expect(byTestId(host, 'diff-name').textContent).toBe('signin.css → login.css');
    expect(byTestId(host, 'diff-name').title).toBe('public/signin.css → public/login.css');
  });

  it('shows the loading state until versions arrive', () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    expect(message(host).dataset.testid).toBe('diff-loading');
    expect(message(host).classList.contains('hidden')).toBe(false);
  });

  it('shows an error without sending when the socket is down', () => {
    const { bus, host, ws } = setup({ wsOpen: false });
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    expect(ws.send).not.toHaveBeenCalled();
    expect(message(host).dataset.testid).toBe('diff-error');
    expect(message(host).textContent).toContain('Not connected to the server.');
  });
});

describe('DiffViewer rendering versions', () => {
  it('creates one read-only Monaco diff editor with an original/modified model pair', async () => {
    const { bus, host, monaco } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();

    expect(monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1);
    const [el, options] = monaco.editor.createDiffEditor.mock.calls[0];
    expect(el).toBe(byTestId(host, 'diff-editor'));
    expect(options).toMatchObject({ readOnly: true, originalEditable: false, renderSideBySide: true });
    expect(monaco.models.map((m) => [m.value, m.language])).toEqual([
      ['const t = read();\n', 'javascript'],
      ['const t = await read();\n', 'javascript'],
    ]);
    const ed = monaco.editors[0];
    expect(ed.model).toEqual({ original: monaco.models[0], modified: monaco.models[1] });
    expect(message(host).classList.contains('hidden')).toBe(true);
    expect(byTestId(host, 'diff-editor').classList.contains('hidden')).toBe(false);
  });

  it('diffs an added file against empty and a deleted file to empty', async () => {
    const { bus, monaco } = setup();
    const added = spec({ path: 'token-store.js', status: 'A' });
    bus.emit(EVT.GIT_OPEN_DIFF, added);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(added, { original: null, modified: 'export {}\n' }));
    await flush();
    expect(monaco.models.slice(0, 2).map((m) => m.value)).toEqual(['', 'export {}\n']);

    const deleted = spec({ path: 'old-session.js', status: 'D' });
    bus.emit(EVT.GIT_OPEN_DIFF, deleted);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(deleted, { original: 'gone\n', modified: null }));
    await flush();
    expect(monaco.models.slice(2, 4).map((m) => m.value)).toEqual(['gone\n', '']);
  });

  it('ignores a versions frame for another scope', async () => {
    const { bus, monaco, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec({ scope: 'base' })));
    await flush();
    expect(monaco.editor.createDiffEditor).not.toHaveBeenCalled();
    expect(message(host).dataset.testid).toBe('diff-loading');
  });

  it('shows "Binary file changed" with the size delta and no editor', async () => {
    const { bus, host, monaco } = setup();
    const s = spec({ path: 'logo.png' });
    bus.emit(EVT.GIT_OPEN_DIFF, s);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(s, {
      binary: true, original: null, modified: null, originalSize: 1024, modifiedSize: 2048,
    }));
    await flush();
    expect(message(host).dataset.testid).toBe('diff-binary');
    expect(message(host).textContent).toBe('Binary file changed1.0 KB → 2.0 KB (+1.0 KB)');
    expect(monaco.editor.createDiffEditor).not.toHaveBeenCalled();
  });

  it('shows "File too large to diff" with an Open file action', async () => {
    const { bus, host, tabManager } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec(), { tooLarge: true, original: null, modified: null }));
    await flush();
    expect(message(host).dataset.testid).toBe('diff-too-large');
    byTestId(host, 'diff-too-large-file').click();
    expect(tabManager.openFile).toHaveBeenCalledWith('p1', '/feat-login/routes/auth.js');
  });

  it('treats a TOO_LARGE git_error for the file as the too-large state', () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', path: 'routes/auth.js', code: 'TOO_LARGE', error: 'too big' });
    expect(message(host).dataset.testid).toBe('diff-too-large');
  });

  it('shows a git_error for the file with a Retry that refetches', () => {
    const { bus, host, ws } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', path: 'routes/auth.js', code: 'FAILED', error: 'fatal: bad revision' });
    expect(message(host).dataset.testid).toBe('diff-error');
    expect(message(host).textContent).toContain('fatal: bad revision');

    byTestId(host, 'diff-retry').click();
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(message(host).dataset.testid).toBe('diff-loading');
  });

  it('ignores a git_error for a different file', () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', path: 'other.js', code: 'FAILED', error: 'x' });
    expect(message(host).dataset.testid).toBe('diff-loading');
  });

  it('a repo-level git_error settles a loading tab in that repo only', async () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/fix-timeouts', code: 'NOT_A_REPO', error: 'gone' });
    expect(message(host).dataset.testid).toBe('diff-loading');
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', code: 'NOT_A_REPO', error: 'Not a git repository' });
    expect(message(host).dataset.testid).toBe('diff-error');
  });

  it('a repo-level git_error leaves an already-loaded tab alone', async () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', code: 'TIMEOUT', error: 'git timed out' });
    expect(message(host).classList.contains('hidden')).toBe(true);
  });
});

describe('DiffViewer mode (eve-diff-mode)', () => {
  it('defaults to side by side on a wide viewport', () => {
    const { viewer, host } = setup({ innerWidth: 1200 });
    expect(viewer.mode).toBe('side-by-side');
    expect(byTestId(host, 'diff-mode-side-by-side').getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(host, 'diff-mode-inline').getAttribute('aria-pressed')).toBe('false');
  });

  it('defaults to inline below 768px', () => {
    expect(setup({ innerWidth: 767 }).viewer.mode).toBe('inline');
    expect(setup({ innerWidth: 768 }).viewer.mode).toBe('side-by-side');
  });

  it('a stored choice wins over the viewport default', () => {
    expect(setup({ innerWidth: 600, storage: { 'eve-diff-mode': 'side-by-side' } }).viewer.mode).toBe('side-by-side');
    expect(setup({ innerWidth: 1200, storage: { 'eve-diff-mode': 'inline' } }).viewer.mode).toBe('inline');
  });

  it('ignores an unknown stored value', () => {
    expect(setup({ innerWidth: 1200, storage: { 'eve-diff-mode': 'file' } }).viewer.mode).toBe('side-by-side');
  });

  it('creates the editor in the stored mode', async () => {
    const { bus, monaco } = setup({ storage: { 'eve-diff-mode': 'inline' } });
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    expect(monaco.editor.createDiffEditor.mock.calls[0][1].renderSideBySide).toBe(false);
  });

  it('toggling flips renderSideBySide in place and persists the choice', async () => {
    const { bus, host, monaco } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    const ed = monaco.editors[0];

    byTestId(host, 'diff-mode-inline').click();
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: false });
    expect(localStorage.getItem('eve-diff-mode')).toBe('inline');
    expect(byTestId(host, 'diff-mode-inline').getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(host, 'diff-mode-inline').classList.contains('active')).toBe(true);

    byTestId(host, 'diff-mode-side-by-side').click();
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: true });
    expect(localStorage.getItem('eve-diff-mode')).toBe('side-by-side');
    expect(monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1);
  });

  it('switching mode before any editor exists just persists it', () => {
    const { host } = setup();
    expect(() => byTestId(host, 'diff-mode-inline').click()).not.toThrow();
    expect(localStorage.getItem('eve-diff-mode')).toBe('inline');
  });
});

describe('DiffViewer File mode', () => {
  it('opens the working file for a child repo at <repo>/<path>', () => {
    const { bus, host, tabManager } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    byTestId(host, 'diff-mode-file').click();
    expect(tabManager.openFile).toHaveBeenCalledWith('p1', '/feat-login/routes/auth.js');
  });

  it('opens the working file for the root repo at /<path>', () => {
    const { bus, host, tabManager } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ repo: '/', repoName: 'p1', path: 'src/app.js' }));
    byTestId(host, 'diff-mode-file').click();
    expect(tabManager.openFile).toHaveBeenCalledWith('p1', '/src/app.js');
  });

  it('projectPath maps repo + repo-relative path to a project-relative path', () => {
    const { DiffViewer } = setup();
    expect(DiffViewer.projectPath('/', 'README.md')).toBe('/README.md');
    expect(DiffViewer.projectPath('/fix-timeouts', 'lib/relay-client.js')).toBe('/fix-timeouts/lib/relay-client.js');
  });

  it('is disabled for a deleted file and does nothing when clicked', () => {
    const { bus, host, tabManager } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec({ path: 'old-session.js', status: 'D' }));
    const btn = byTestId(host, 'diff-mode-file');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('File was deleted');
    btn.click();
    tabManager.openFile.mockClear();
    btn.disabled = false; // even if forced, openWorkingFile refuses
    btn.click();
    expect(tabManager.openFile).not.toHaveBeenCalled();
  });

  it('is disabled when the working-tree side is missing', async () => {
    const { bus, host } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    expect(byTestId(host, 'diff-mode-file').disabled).toBe(false);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec(), { modified: null }));
    await flush();
    expect(byTestId(host, 'diff-mode-file').disabled).toBe(true);
  });

  it('stays enabled for a binary file', async () => {
    const { bus, host } = setup();
    const s = spec({ path: 'logo.png' });
    bus.emit(EVT.GIT_OPEN_DIFF, s);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(s, { binary: true, original: null, modified: null }));
    await flush();
    expect(byTestId(host, 'diff-mode-file').disabled).toBe(false);
  });
});

describe('DiffViewer live refresh (git:changed)', () => {
  async function loadedTab(overrides) {
    const ctx = setup();
    const s = spec(overrides);
    ctx.bus.emit(EVT.GIT_OPEN_DIFF, s);
    ctx.bus.emit(EVT.GIT_FILE_VERSIONS, versions(s));
    await flush();
    ctx.ws.send.mockClear();
    return { ...ctx, s };
  }

  it('refetches the visible tab 300 ms after the last change in its repo', async () => {
    const { bus, ws } = await loadedTab();
    jest.useFakeTimers();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    jest.advanceTimersByTime(200);
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    jest.advanceTimersByTime(299);
    expect(ws.send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(sent(ws)).toEqual([{
      type: 'git_file_versions', projectId: 'p1', repo: '/feat-login', path: 'routes/auth.js', scope: 'uncommitted',
    }]);
  });

  it('"*" refreshes every tab of the project', async () => {
    const { bus, ws } = await loadedTab();
    jest.useFakeTimers();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
    jest.advanceTimersByTime(300);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('ignores changes in another repo or another project', async () => {
    const { bus, ws } = await loadedTab();
    jest.useFakeTimers();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/fix-timeouts' });
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p2', repo: '/feat-login' });
    jest.advanceTimersByTime(1000);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('updates the existing models in place and keeps the view state', async () => {
    const { bus, monaco, s } = await loadedTab();
    const ed = monaco.editors[0];
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(s, { modified: 'const t = await read(1);\n' }));
    await flush();
    expect(monaco.models).toHaveLength(2);
    expect(monaco.models[1].setValue).toHaveBeenCalledWith('const t = await read(1);\n');
    expect(monaco.models[0].setValue).not.toHaveBeenCalled();
    expect(ed.saveViewState).toHaveBeenCalled();
    expect(ed.restoreViewState).toHaveBeenCalledWith({ scrollTop: 42 });
  });

  it('a hidden tab is marked stale and refetches when shown again', async () => {
    const { bus, ws, tabManager, s } = await loadedTab();
    const other = spec({ path: 'token-store.js', status: 'A' });
    bus.emit(EVT.GIT_OPEN_DIFF, other);
    ws.send.mockClear();
    jest.useFakeTimers();

    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    // Only the visible tab (token-store.js) is debounced; auth.js is just stale.
    tabManager.show(`diff:p1:/feat-login:${s.path}`);
    expect(sent(ws).map((f) => f.path)).toEqual(['routes/auth.js']);
  });

  // Suspected bug: file-watcher attributes a change at `src/app.js` to repo
  // `/src` (first path segment). ChangesPanel treats an unknown repo as
  // "refresh everything", but DiffViewer only matches `frame.repo` exactly,
  // so a root-repo diff of a file in a subdirectory never live-refreshes.
  it('refetches a root-repo diff when the watcher attributes the change to its first path segment', async () => {
    const { bus, ws } = await loadedTab({ repo: '/', repoName: 'p1', branch: 'main', path: 'src/app.js' });
    jest.useFakeTimers();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/src' });
    jest.advanceTimersByTime(300);
    expect(sent(ws)).toEqual([{
      type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'src/app.js', scope: 'uncommitted',
    }]);
  });
});

describe('DiffViewer tab close', () => {
  it('disposes the tab models when a tab closes, and the editor only with the last tab', async () => {
    const { bus, tabManager, monaco } = setup();
    const a = spec();
    const b = spec({ path: 'token-store.js', status: 'A' });
    bus.emit(EVT.GIT_OPEN_DIFF, a);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(a));
    await flush();
    bus.emit(EVT.GIT_OPEN_DIFF, b);
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(b));
    await flush();
    const ed = monaco.editors[0];
    expect(monaco.editors).toHaveLength(1);
    expect(monaco.models).toHaveLength(4);

    tabManager.closeTab('diff:p1:/feat-login:token-store.js');
    expect(monaco.models[2].dispose).toHaveBeenCalled();
    expect(monaco.models[3].dispose).toHaveBeenCalled();
    expect(ed.setModel).toHaveBeenLastCalledWith(null); // detached before disposal
    expect(ed.dispose).not.toHaveBeenCalled();

    tabManager.closeTab('diff:p1:/feat-login:routes/auth.js');
    expect(monaco.models[0].dispose).toHaveBeenCalled();
    expect(ed.dispose).toHaveBeenCalledTimes(1);
  });

  it('a fresh editor is created after the last tab closed and a new one opens', async () => {
    const { bus, tabManager, monaco } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    tabManager.closeTab('diff:p1:/feat-login:routes/auth.js');

    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    expect(monaco.editor.createDiffEditor).toHaveBeenCalledTimes(2);
  });

  it('a pending refresh timer does not fire after close', async () => {
    const { bus, tabManager, ws } = setup();
    bus.emit(EVT.GIT_OPEN_DIFF, spec());
    bus.emit(EVT.GIT_FILE_VERSIONS, versions(spec()));
    await flush();
    ws.send.mockClear();
    jest.useFakeTimers();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    tabManager.closeTab('diff:p1:/feat-login:routes/auth.js');
    jest.advanceTimersByTime(1000);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
