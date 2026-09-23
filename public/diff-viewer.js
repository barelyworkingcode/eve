/**
 * Controller for `diff` tabs (panes/diff-pane.js). Design and wire contract:
 * docs/design-git-changes.md, "Opening a file: the diff pane" and "Contract".
 *
 * Every diff tab renders into the one static #diffPane element (as file tabs
 * share #editor), so there is one Monaco diff editor; each tab owns its own
 * pair of models and saved view state. Side by side / Inline flip
 * `renderSideBySide` in place. The editor and models are disposed when the
 * last diff tab closes.
 */
const DIFF_MODE_KEY = 'eve-diff-mode';
const DIFF_MODES = ['side-by-side', 'inline'];
const DIFF_NARROW_PX = 768;
const DIFF_REFRESH_DEBOUNCE_MS = 300;

const DIFF_STATUS_TITLES = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflicted', '?': 'Untracked',
};

class DiffViewer {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('DiffViewer');
    this.host = document.getElementById('diffPane');
    this.states = new Map(); // tabId -> per-tab state
    this.activeTabId = null;
    this.diffEditor = null;
    this._monacoPromise = null;
    this.mode = this._loadMode();

    if (this.host) this._build();

    this.bus.on(EVT.GIT_OPEN_DIFF, (spec) => this.open(spec));
    this.bus.on(EVT.GIT_FILE_VERSIONS, (frame) => this._onVersions(frame));
    this.bus.on(EVT.GIT_ERROR, (frame) => this._onError(frame));
    this.bus.on(EVT.GIT_CHANGED, (frame) => this._onChanged(frame));
    this.bus.on(EVT.SETTINGS_CHANGED, () => this._applySettings());
  }

  // Resolved at call time: `app` services (tabManager, ws, fileEditor) are
  // constructed after features.boot() creates this.
  get app() { return this.container.get('app'); }

  static projectPath(repo, path) {
    return repo === '/' ? '/' + path : repo + '/' + path;
  }

  // ─── Tab lifecycle ────────────────────────────────────────────────────────

  open(spec) {
    if (!spec?.projectId || !spec.repo || !spec.path) return;
    const tabs = this.app.tabManager;
    if (!tabs) return;
    const normalized = { ...spec, scope: spec.scope || 'uncommitted' };
    const tabId = panes.type('diff').create(normalized).id;

    const prev = this.states.get(tabId);
    if (prev) {
      const changed = prev.spec.scope !== normalized.scope
        || prev.spec.status !== normalized.status
        || prev.spec.oldPath !== normalized.oldPath;
      prev.spec = normalized;
      if (changed) { prev.stale = true; prev.data = null; prev.error = null; }
      const tab = tabs.tabs.find(t => t.id === tabId);
      if (tab) tab.title = this._tabTitle(normalized);
    } else {
      this.states.set(tabId, {
        tabId,
        spec: normalized,
        data: null,
        error: null,
        loading: false,
        stale: true,
        models: null,
        viewState: null,
        refreshTimer: null,
      });
    }
    tabs.openPane('diff', normalized);
  }

  show(tabId) {
    const st = this.states.get(tabId);
    if (!st || !this.host) return;
    if (this.activeTabId !== tabId) this._saveViewState();
    this.activeTabId = tabId;
    this._renderHeader(st);
    if (st.stale && !st.loading) this._fetch(st);
    this._renderBody(st);
  }

  layout() {
    this.diffEditor?.layout();
  }

  close(tabId) {
    const st = this.states.get(tabId);
    if (!st) return;
    clearTimeout(st.refreshTimer);
    if (st.models && this.diffEditor) {
      const current = this.diffEditor.getModel();
      if (current && current.modified === st.models.modified) this.diffEditor.setModel(null);
    }
    this._disposeModels(st);
    this.states.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
    if (this.states.size === 0 && this.diffEditor) {
      this.diffEditor.dispose();
      this.diffEditor = null;
    }
  }

  _disposeModels(st) {
    if (!st.models) return;
    st.models.original.dispose();
    st.models.modified.dispose();
    st.models = null;
  }

  _isVisible(st) {
    return this.activeTabId === st.tabId && !!this.host && !this.host.classList.contains('hidden');
  }

  _tabTitle(spec) {
    const meta = [spec.repoName, spec.branch].filter(Boolean).join(' · ');
    if (spec.status === 'R' && spec.oldPath) return `${meta}\n${spec.oldPath} → ${spec.path}`;
    return meta;
  }

  // ─── Server traffic ───────────────────────────────────────────────────────

  _fetch(st) {
    st.stale = false;
    st.loading = true;
    const { projectId, repo, path, scope } = st.spec;
    const ws = this.app.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      st.loading = false;
      st.stale = true; // retry on next show
      st.error = { code: 'OFFLINE', message: 'Not connected to the server.' };
      return;
    }
    ws.send(JSON.stringify({ type: 'git_file_versions', projectId, repo, path, scope }));
  }

  _matches(st, frame) {
    return st.spec.projectId === frame.projectId
      && st.spec.repo === frame.repo
      && st.spec.path === frame.path;
  }

  _onVersions(frame) {
    if (!frame) return;
    for (const st of this.states.values()) {
      if (!this._matches(st, frame) || st.spec.scope !== (frame.scope || 'uncommitted')) continue;
      st.loading = false;
      st.error = null;
      st.data = frame;
      if (this._isVisible(st)) {
        this._renderHeader(st);
        this._renderBody(st);
      }
    }
  }

  // git_error carries no scope; a frame without `path` is a repo-level
  // failure and only settles tabs still waiting on that repo.
  _onError(frame) {
    if (!frame) return;
    for (const st of this.states.values()) {
      if (st.spec.projectId !== frame.projectId) continue;
      if (frame.repo && frame.repo !== st.spec.repo) continue;
      if (frame.path ? frame.path !== st.spec.path : !st.loading) continue;
      st.loading = false;
      if (frame.code === 'TOO_LARGE') {
        st.error = null;
        st.data = { tooLarge: true, binary: false, original: null, modified: null };
      } else {
        st.data = null;
        st.error = { code: frame.code || 'FAILED', message: frame.error || 'Could not load the diff.' };
      }
      if (this._isVisible(st)) this._renderBody(st);
    }
  }

  _onChanged(frame) {
    if (!frame) return;
    for (const st of this.states.values()) {
      if (st.spec.projectId !== frame.projectId) continue;
      if (frame.repo !== '*' && frame.repo !== st.spec.repo) continue;
      if (!this._isVisible(st)) { st.stale = true; continue; }
      clearTimeout(st.refreshTimer);
      st.refreshTimer = setTimeout(() => {
        st.refreshTimer = null;
        if (!this.states.has(st.tabId)) return;
        if (this._isVisible(st)) this._fetch(st);
        else st.stale = true;
      }, DIFF_REFRESH_DEBOUNCE_MS);
    }
  }

  // ─── Mode ─────────────────────────────────────────────────────────────────

  _loadMode() {
    try {
      const saved = localStorage.getItem(DIFF_MODE_KEY);
      if (DIFF_MODES.includes(saved)) return saved;
    } catch { /* storage blocked: fall through to the default */ }
    return window.innerWidth < DIFF_NARROW_PX ? 'inline' : 'side-by-side';
  }

  setMode(mode) {
    if (!DIFF_MODES.includes(mode)) return;
    this.mode = mode;
    try { localStorage.setItem(DIFF_MODE_KEY, mode); } catch { /* non-fatal */ }
    this._syncModeButtons();
    this.diffEditor?.updateOptions({ renderSideBySide: mode === 'side-by-side' });
  }

  _syncModeButtons() {
    for (const btn of this.modeButtons.querySelectorAll('[data-mode]')) {
      const active = btn.dataset.mode === this.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  openWorkingFile() {
    const st = this.states.get(this.activeTabId);
    if (!st || this._fileDisabled(st)) return;
    const { projectId, repo, path } = st.spec;
    this.app.tabManager?.openFile(projectId, DiffViewer.projectPath(repo, path));
  }

  _fileDisabled(st) {
    if (st.spec.status === 'D') return true;
    const d = st.data;
    return !!d && !d.binary && !d.tooLarge && d.modified === null;
  }

  // ─── DOM ──────────────────────────────────────────────────────────────────

  _build() {
    const el = (tag, cls, attrs = {}) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };

    const header = el('div', 'diff-pane__header');
    const title = el('div', 'diff-pane__title');
    this.statusEl = el('span', 'diff-pane__status', { 'data-testid': 'diff-status' });
    this.nameEl = el('span', 'diff-pane__name', { 'data-testid': 'diff-name' });
    this.metaEl = el('span', 'diff-pane__meta', { 'data-testid': 'diff-meta' });
    title.append(this.statusEl, this.nameEl, this.metaEl);

    this.modeButtons = el('div', 'view-mode-toggle diff-pane__modes', { role: 'group', 'aria-label': 'Diff view' });
    const modeBtn = (mode, label, testid) => {
      const b = el('button', 'view-mode-btn', { type: 'button', 'data-testid': testid });
      if (mode) b.dataset.mode = mode;
      b.textContent = label;
      return b;
    };
    const sideBtn = modeBtn('side-by-side', 'Side by side', 'diff-mode-side-by-side');
    const inlineBtn = modeBtn('inline', 'Inline', 'diff-mode-inline');
    this.fileBtn = modeBtn(null, 'File', 'diff-mode-file');
    this.fileBtn.title = 'Open the working-tree file in the editor';
    sideBtn.addEventListener('click', () => this.setMode('side-by-side'));
    inlineBtn.addEventListener('click', () => this.setMode('inline'));
    this.fileBtn.addEventListener('click', () => this.openWorkingFile());
    this.modeButtons.append(sideBtn, inlineBtn, this.fileBtn);
    header.append(title, this.modeButtons);

    const body = el('div', 'diff-pane__body');
    this.editorHost = el('div', 'diff-pane__editor', { 'data-testid': 'diff-editor' });
    this.messageEl = el('div', 'diff-pane__message hidden');
    body.append(this.editorHost, this.messageEl);

    this.host.replaceChildren(header, body);
    this._syncModeButtons();
  }

  _renderHeader(st) {
    const { spec } = st;
    const status = spec.status || 'M';
    this.statusEl.textContent = status;
    this.statusEl.dataset.status = status;
    this.statusEl.title = DIFF_STATUS_TITLES[status] || status;

    const base = (p) => p.split('/').pop();
    if (spec.status === 'R' && spec.oldPath) {
      const same = base(spec.oldPath) === base(spec.path);
      this.nameEl.textContent = same
        ? `${spec.oldPath} → ${spec.path}`
        : `${base(spec.oldPath)} → ${base(spec.path)}`;
      this.nameEl.title = `${spec.oldPath} → ${spec.path}`;
    } else {
      this.nameEl.textContent = base(spec.path);
      this.nameEl.title = spec.path;
    }

    const branch = spec.branch ? ` · ⎇ ${spec.branch}` : '';
    this.metaEl.textContent = `${spec.repoName || spec.repo}${branch}`;

    this.fileBtn.disabled = this._fileDisabled(st);
    this.fileBtn.title = this.fileBtn.disabled
      ? 'File was deleted'
      : 'Open the working-tree file in the editor';
  }

  _showMessage(testid, text, detail, action) {
    this.editorHost.classList.add('hidden');
    const msg = this.messageEl;
    msg.classList.remove('hidden');
    msg.dataset.testid = testid;
    msg.replaceChildren();
    const line = document.createElement('div');
    line.className = 'diff-pane__message-text';
    line.textContent = text;
    msg.appendChild(line);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'diff-pane__message-detail';
      d.textContent = detail;
      msg.appendChild(d);
    }
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'diff-pane__message-action';
      b.dataset.testid = action.testid;
      b.textContent = action.label;
      b.addEventListener('click', action.onClick);
      msg.appendChild(b);
    }
  }

  _renderBody(st) {
    this.fileBtn.disabled = this._fileDisabled(st);
    if (st.error) {
      const retry = { label: 'Retry', testid: 'diff-retry', onClick: () => { st.error = null; this._fetch(st); this._renderBody(st); } };
      this._showMessage('diff-error', 'Could not load the diff', st.error.message, retry);
      return;
    }
    const d = st.data;
    if (!d) {
      this._showMessage('diff-loading', 'Loading diff…');
      return;
    }
    if (d.binary) {
      this._showMessage('diff-binary', 'Binary file changed', this._sizeDelta(d.originalSize, d.modifiedSize));
      return;
    }
    if (d.tooLarge) {
      const action = this._fileDisabled(st)
        ? null
        : { label: 'Open file', testid: 'diff-too-large-file', onClick: () => this.openWorkingFile() };
      this._showMessage('diff-too-large', 'File too large to diff', null, action);
      return;
    }
    this._renderDiff(st);
  }

  async _renderDiff(st) {
    // Keep the previous diff on screen during a refresh; only a first load
    // shows the loading message.
    if (!st.models) this._showMessage('diff-loading', 'Loading diff…');
    let monaco;
    try {
      monaco = await this._loadMonaco();
    } catch (err) {
      this.log.error('Monaco failed to load:', err);
      st.error = { code: 'MONACO', message: 'The editor failed to load.' };
      if (this._isVisible(st)) this._renderBody(st);
      return;
    }
    // A tab switch or a newer frame may have landed while Monaco loaded.
    if (!this._isVisible(st) || !st.data || st.data.binary || st.data.tooLarge || st.error) return;

    this.messageEl.classList.add('hidden');
    this.editorHost.classList.remove('hidden');
    this._ensureEditor(monaco);

    const original = st.data.original ?? '';
    const modified = st.data.modified ?? '';
    const current = this.diffEditor.getModel();
    const attached = !!st.models && current?.modified === st.models.modified;

    if (!st.models) {
      const language = this._language(st.spec.path);
      st.models = {
        original: monaco.editor.createModel(original, language),
        modified: monaco.editor.createModel(modified, language),
      };
    } else {
      // Refresh in place: keep scroll position across the content swap.
      const view = attached ? this.diffEditor.saveViewState() : st.viewState;
      if (st.models.original.getValue() !== original) st.models.original.setValue(original);
      if (st.models.modified.getValue() !== modified) st.models.modified.setValue(modified);
      st.viewState = view;
    }

    if (!attached) {
      this.diffEditor.setModel({ original: st.models.original, modified: st.models.modified });
    }
    if (st.viewState) this.diffEditor.restoreViewState(st.viewState);
    this.diffEditor.layout();
  }

  _saveViewState() {
    const prev = this.states.get(this.activeTabId);
    if (!prev?.models || !this.diffEditor) return;
    const current = this.diffEditor.getModel();
    if (current?.modified === prev.models.modified) prev.viewState = this.diffEditor.saveViewState();
  }

  _ensureEditor(monaco) {
    if (this.diffEditor) return;
    const settings = this.app.settings;
    this.diffEditor = monaco.editor.createDiffEditor(this.editorHost, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: this.mode === 'side-by-side',
      // The user picked a mode explicitly; don't let Monaco override it.
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      theme: settings?.isLight() ? 'vs' : 'vs-dark',
      fontSize: settings?.get('fontSize'),
      fontFamily: settings?.getTerminalFontStack(),
    });
  }

  _applySettings() {
    if (!this.diffEditor || !window.monaco) return;
    const settings = this.app.settings;
    window.monaco.editor.setTheme(settings.isLight() ? 'vs' : 'vs-dark');
    this.diffEditor.updateOptions({
      fontSize: settings.get('fontSize'),
      fontFamily: settings.getTerminalFontStack(),
    });
  }

  _language(path) {
    return this.app.fileEditor?.detectLanguage(path) || 'plaintext';
  }

  // Same loader config as FileEditor#loadMonaco; the AMD loader dedupes if
  // both ask at once.
  _loadMonaco() {
    if (window.monaco?.editor) return Promise.resolve(window.monaco);
    if (this._monacoPromise) return this._monacoPromise;
    this._monacoPromise = new Promise((resolve, reject) => {
      if (typeof window.require !== 'function') {
        reject(new Error('Monaco loader missing'));
        return;
      }
      window.require.config({ paths: { vs: '/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    }).catch((err) => {
      this._monacoPromise = null;
      throw err;
    });
    return this._monacoPromise;
  }

  _sizeDelta(before, after) {
    const fmt = (n) => {
      if (typeof n !== 'number') return '—';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    };
    let text = `${fmt(before)} → ${fmt(after)}`;
    if (typeof before === 'number' && typeof after === 'number' && before !== after) {
      const diff = after - before;
      text += ` (${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))})`;
    }
    return text;
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'diffViewer',
    init: (container) => new DiffViewer(container),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DiffViewer;
}
