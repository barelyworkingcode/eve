// In the browser, `panes` is core/pane-registry.js's file-scope const,
// already in scope here because its <script> tag runs first (index.html) —
// classic scripts share one top-level scope, so no import is needed and none
// is possible (redeclaring `panes` here would collide with it). Under Jest,
// this file is `require`d directly with no <script> ordering (see
// test/unit/tab-manager-logic.test.js), so hang the same singleton on
// `global` instead — exactly like that test's own document/window/history/
// localStorage/EVT fakes — so every bare `panes.type(...)` / `panes.view(...)`
// reference below resolves the same way in both environments.
if (typeof module !== 'undefined' && module.exports) {
  require('./core/pane-registry.js'); // also loads every panes/*.js and publishes `panes` on `global`
}

class TabManager {
  static SESSION_STORAGE_KEY = 'eve-open-sessions';
  static SESSION_META_KEY = 'eve-session-meta';
  static FILE_STORAGE_KEY = 'eve-open-files';
  static MODULE_STORAGE_KEY = 'eve-open-modules';
  static MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.container = container;
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.bus = container.get('bus');
    this.tabs = []; // [{ id, type: 'session'|'file'|'terminal', label, projectId, path?, modified? }]
    this.activeTabId = null;

    // Project-scoped tab bar: only tabs belonging to the active project are
    // shown; the rest stay open but hidden until that project is active again.
    this._activeProjectId = null;
    this._lastActiveByProject = new Map(); // projectId -> last active tabId

    this.initElements();
    this.initEventListeners();

    // Drag a tab to an edge of the content area to split it into two panes
    // (Pointer Events, so it works on iPad touch too).
    if (typeof PaneDnd !== 'undefined' && this.contentArea) {
      this.paneDnd = new PaneDnd(this);
    }

    // The activity rail owns project selection; follow it.
    this.bus.on(EVT.PROJECT_ACTIVATED, ({ projectId }) => this.setActiveProject(projectId));
  }

  initElements() {
    this.tabBar = document.getElementById('tabBar');
    this.contentArea = document.getElementById('contentArea');

    // One element per registered view (public/panes/views.js). `elementId`
    // names static markup in index.html, so resolving it here — once, at
    // construction — is safe (see core/pane-registry.js). Kept in a Map for
    // _containerForView/_hideAllContent/_allContentEls, and mirrored onto the
    // named properties below because _showContentForRef and the render
    // helpers still reach for them by name.
    this._viewEls = new Map(panes.views().map(v => [v.view, document.getElementById(v.elementId)]));
    this.chatContent = this._viewEls.get('chat');
    this.voiceChatContent = this._viewEls.get('voice');
    this.editorContent = this._viewEls.get('editor');
    this.viewerContent = this._viewEls.get('viewer'); // shared with 'image' — see panes/views.js
    this.terminalContent = this._viewEls.get('terminal');
    this.moduleContent = this._viewEls.get('module');
    this.htmlPreviewContent = this._viewEls.get('htmlPreview');

    // Viewer-internal elements — not part of the view→container map, used
    // only inside the viewer's own render helper.
    this.viewerCanvas = document.getElementById('fileViewerCanvas');
    this.viewerPath = document.getElementById('fileViewerPath');
    this.viewerInfo = document.getElementById('fileViewerInfo');
  }

  initEventListeners() {
    // Tab close via Cmd/Ctrl+W
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) {
          this.closeTab(this.activeTabId);
        }
      }
    });

    // Keep split panes laid out when the viewport changes (Monaco / xterm need
    // an explicit relayout; CSS handles the rest).
    window.addEventListener('resize', () => {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab?.split) {
        this._layoutPanes(tab);
        this._positionPaneUndockButtons();
      }
    });
  }

  /**
   * Opens a session as a tab
   */
  openSession(sessionId, { skipRender = false } = {}) {
    const session = this.app.sessions.get(sessionId);
    if (!session) return;

    // Check if tab already exists
    const existingTab = this.tabs.find(t => t.id === sessionId);
    if (existingTab) {
      if (skipRender) return;
      this.switchToTab(existingTab.id);
      return;
    }

    const d = panes.type('session');
    const tab = d.create({ sessionId }, this._ctx());
    this.tabs.push(tab);
    if (d.persist) this._saveToStorage(d.persist.key, d.persist.entryId(tab), d.persist.entry(tab));
    if (session.sessionType) this._saveSessionMeta(sessionId, { sessionType: session.sessionType });

    if (skipRender) {
      // Verbatim, documented-divergent activation path — see
      // public/panes/session-pane.js's `activateSkipRender` header.
      d.activateSkipRender(tab, this._ctx());
    } else {
      this.switchToTab(sessionId);
    }
  }

  /**
   * Opens a file as a tab
   */
  openFile(projectId, filePath, label) {
    const tabId = `${projectId}:${filePath}`;

    // Check if tab already exists
    const existingTab = this.tabs.find(t => t.id === tabId);
    if (existingTab) {
      this.switchToTab(tabId);
      return;
    }

    const d = panes.type('file');
    const tab = d.create({ projectId, path: filePath, label }, this._ctx());
    this.tabs.push(tab);
    if (d.persist) this._saveToStorage(d.persist.key, d.persist.entryId(tab), d.persist.entry(tab));
    this.switchToTab(tabId);
  }

  /**
   * Opens a terminal as a tab
   */
  openTerminal(terminalId, label, directory) {
    // Check if tab already exists
    const existingTab = this.tabs.find(t => t.id === terminalId);
    if (existingTab) {
      this.switchToTab(terminalId);
      return;
    }

    const tab = panes.type('terminal').create({ terminalId, label, directory }, this._ctx());
    this.tabs.push(tab);
    this.switchToTab(terminalId);
  }

  /**
   * Opens a module as a tab
   */
  openModule(projectId, moduleName, label) {
    const tabId = `module:${projectId}:${moduleName}`;
    const existingTab = this.tabs.find(t => t.id === tabId);
    if (existingTab) {
      this.switchToTab(tabId);
      return;
    }
    const d = panes.type('module');
    const tab = d.create({ projectId, moduleName, label }, this._ctx());
    this.tabs.push(tab);
    if (d.persist) this._saveToStorage(d.persist.key, d.persist.entryId(tab), d.persist.entry(tab));
    this.switchToTab(tabId);
  }

  /**
   * Switches active tab
   */
  switchToTab(tabId) {
    let tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // A nested pane has no standalone view — activating it (deep link, an async
    // file-read response, restore) shows the host split it belongs to instead.
    if (tab._nestedIn) {
      const host = this.tabs.find(t => t.id === tab._nestedIn);
      if (host) { tab = host; tabId = host.id; }
    }

    this.activeTabId = tabId;
    this._rememberActive(tab);

    // Ensure chat screen is visible (hides welcome screen)
    this.app.showChatScreen();

    // Hide all content containers first
    this._hideAllContent();

    // Destroy active viewer when switching away (pause media, free memory)
    this._destroyActiveViewer();

    // Show content: a split tab renders two panes at once, otherwise one.
    if (tab.split) {
      const child = this.tabs.find(t => t.id === tab.split.paneTabId);
      this.contentArea.classList.add('content-area--split', `content-area--${tab.split.dir}`);
      this._showContentForRef(this._viewForTab(tab), this._refForTab(tab));
      if (child) this._showContentForRef(this._paneBView(tab, child), this._refForTab(child));
      this._applyPaneRatio(tab);
      this._mountDivider(tab);
      this._mountPaneUndockButtons(tab);
      this._layoutPanes(tab);
    } else {
      this._showContentForRef(this._viewForTab(tab), this._refForTab(tab));
    }

    // Deep links / restore / task-join can activate a tab outside the current
    // project — pull the rail across so the active tab stays visible.
    this._syncProjectToActiveTab();
    this.render();
    this._updateHash(tab);
  }

  /**
   * The object a pane descriptor's functions receive. Rebuilt on every call,
   * never captured: the services reached through `app` (fileEditor,
   * terminalManager, moduleHost, voiceChatManager, htmlPreviewPane,
   * viewerRegistry, messageDispatcher, ...) are constructed after `new
   * TabManager` runs (see app.js), so a descriptor that memoised one of them
   * would get `undefined` on first use.
   */
  _ctx() {
    return { container: this.container, app: this.app, tabs: this, bus: this.bus };
  }

  /**
   * Maps a tab to its pane "view" kind (the content container it renders into).
   * Both the single-view path and each pane of a split go through this.
   */
  _viewForTab(tab) {
    return panes.type(tab.type).view(tab, this._ctx());
  }

  /** The render args a view needs to bind its content. */
  _refForTab(tab) {
    return panes.type(tab.type).ref(tab);
  }

  /** The view used for the second pane — a split may override it (e.g. an HTML
   *  file docks as a live preview rather than its editor source). */
  _paneBView(tab, child) {
    return tab.split?.paneView || this._viewForTab(child);
  }

  /** The view a tab would take as a dragged-in second pane. Defaults to a
   *  migrated type's own `view()`; `file` overrides it (an HTML file previews
   *  live rather than opening its source, which also sidesteps the
   *  editor-vs-editor singleton block — see public/panes/file-pane.js). */
  _prospectiveView(tab) {
    const d = panes.type(tab.type);
    if (d) return d.prospectiveView ? d.prospectiveView(tab, this._ctx()) : d.view(tab, this._ctx());
    return this._viewForTab(tab);
  }

  /** The DOM container a pane view renders into. Two panes must map to two
   *  different containers — the singleton guard for splits. */
  _containerForView(view) {
    return this._viewEls.get(view) || null;
  }

  /**
   * Reveals the container for `view` and tells its owner to render `ref`.
   * Each view's own behavior lives on its descriptor now (public/panes/views.js).
   */
  _showContentForRef(view, ref) {
    const d = panes.view(view);
    if (d) d.show(ref, this._ctx(), this._containerForView(view));
  }

  /**
   * Updates location.hash to reflect the active tab.
   * Uses replaceState to avoid firing hashchange events.
   */
  _updateHash(tab) {
    let hash = '';
    if (tab) {
      const d = panes.type(tab.type);
      if (d) hash = d.hash ? d.hash(tab) : '';
    }
    const target = hash || (window.location.pathname + window.location.search);
    if (window.location.hash !== hash) {
      history.replaceState(null, '', target);
    }
  }

  /**
   * Closes a tab
   */
  closeTab(tabId) {
    let tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Gate the close on a per-type confirmation (currently `file`'s modified-
    // file confirm() only; every other migrated type defaults to true).
    const closeGate = panes.type(tab.type);
    if (closeGate?.confirmClose && !closeGate.confirmClose(tab, this._ctx())) {
      return;
    }

    // Closing a split host also closes its nested second pane.
    if (tab.split?.paneTabId) {
      const childId = tab.split.paneTabId;
      delete tab.split;
      const child = this.tabs.find(t => t.id === childId);
      if (child) { delete child._nestedIn; this.closeTab(childId); }
    }
    // Closing a tab that is itself a nested pane detaches it from its host.
    if (tab._nestedIn) {
      const parent = this.tabs.find(t => t.id === tab._nestedIn);
      if (parent?.split) delete parent.split;
      delete tab._nestedIn;
    }

    // Re-find the index — closing a nested pane above may have shifted the array.
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;
    tab = this.tabs[tabIndex];

    // Persistence removal + dispose — every pane type is on PaneRegistry now,
    // so this one block covers all five (session's leave_session +
    // dispatcher-buffer cleanup lives in its `dispose`, panes/session-pane.js).
    const migratedType = panes.type(tab.type);
    if (migratedType) {
      if (migratedType.persist) this._removeFromStorage(migratedType.persist.key, migratedType.persist.entryId(tab));
      if (migratedType.dispose) migratedType.dispose(tab, this._ctx());
    }

    // Remove tab
    this.tabs.splice(tabIndex, 1);

    // If this was the active tab, switch to the next tab in the same project,
    // falling back to the welcome screen when the project has none left.
    if (this.activeTabId === tabId) {
      const nextTab = this._nextTabInProject(tabIndex);
      if (nextTab) {
        this.switchToTab(nextTab.id);
      } else {
        this._showEmptyState();
      }
    }

    this.render();
  }

  // --- Project-scoped tab bar ---

  /**
   * Resolve which project a tab belongs to, for filtering. Sessions, files and
   * modules carry projectId directly; terminals are matched by their working
   * directory falling under a project's path (public/panes/terminal-pane.js's
   * `projectId`) — the descriptor override for pane types that need one.
   * Returns null when unscoped.
   */
  _tabProjectId(tab) {
    const d = panes.type(tab.type);
    if (d?.projectId) return d.projectId(tab, this._ctx());
    return tab.projectId || null;
  }

  /** Forwards to the `terminal` descriptor's pure longest-prefix match
   *  (public/panes/terminal-pane.js) — kept as a real method since the unit
   *  suite calls it on a bare instance, single-argument, with no `ctx`. */
  _projectIdForDirectory(directory) {
    return panes.type('terminal').projectId({ directory }, this._ctx());
  }

  _rememberActive(tab) {
    const projectId = this._tabProjectId(tab);
    if (projectId) this._lastActiveByProject.set(projectId, tab.id);
  }

  /**
   * Scope the tab bar to a project (driven by the activity rail). Keeps the
   * current tab if it belongs to the project; otherwise lands on that
   * project's most-recently-used tab, or the welcome screen when it has none.
   */
  setActiveProject(projectId) {
    if (projectId === this._activeProjectId) {
      this.render();
      return;
    }
    this._activeProjectId = projectId;

    const active = this.tabs.find(t => t.id === this.activeTabId);
    if (active && this._tabProjectId(active) === projectId) {
      this.render();
      return;
    }

    const target = this._lastActiveTabForProject(projectId);
    if (target) {
      this.switchToTab(target.id);
    } else {
      this._showEmptyState();
      this.render();
    }
  }

  /**
   * Keep the active project aligned with the active tab. When a tab from a
   * different project becomes active (deep link, reload restore, task-join),
   * pull the rail/sidebar across so the tab stays visible.
   */
  _syncProjectToActiveTab() {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab) return;
    const projectId = this._tabProjectId(tab);
    if (projectId && projectId !== this._activeProjectId) {
      this.app.projectTree?.setActive(projectId);
    }
  }

  _lastActiveTabForProject(projectId) {
    const remembered = this._lastActiveByProject.get(projectId);
    if (remembered) {
      const tab = this.tabs.find(t => t.id === remembered);
      if (tab && !tab._nestedIn && this._tabProjectId(tab) === projectId) return tab;
    }
    // Fall back to the rightmost tab belonging to this project.
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      if (!this.tabs[i]._nestedIn && this._tabProjectId(this.tabs[i]) === projectId) return this.tabs[i];
    }
    return null;
  }

  /**
   * Nearest tab in the active project relative to a closed index (prefer the
   * tab that shifted into its place, then look left). Null when none remain.
   */
  _nextTabInProject(fromIndex) {
    const inProject = (t) => !t._nestedIn && this._tabProjectId(t) === this._activeProjectId;
    for (let i = fromIndex; i < this.tabs.length; i++) {
      if (inProject(this.tabs[i])) return this.tabs[i];
    }
    for (let i = fromIndex - 1; i >= 0; i--) {
      if (inProject(this.tabs[i])) return this.tabs[i];
    }
    return null;
  }

  _hideAllContent() {
    for (const el of new Set(this._viewEls.values())) el?.classList.add('hidden');
    this._clearSplit();
  }

  // --- Split panes (two panes per tab) ---
  //
  // A split shows two tabs at once. The host (active) tab carries
  // `split = { dir, before, ratio, paneTabId }`; the second pane is an absorbed
  // tab marked `_nestedIn = hostId` so it's hidden from the tab bar but keeps
  // its content owner (session / editor / terminal / module) fully alive. We
  // never re-parent the heavy containers — split mode just un-hides two of them
  // and sizes them with flex, decoupling visual order from DOM order via CSS
  // `order`.

  _allContentEls() {
    return [...new Set(this._viewEls.values())].filter(Boolean);
  }

  /** Maps a drop edge to a split direction + which side the new pane lands on. */
  _edgeToDir(edge) {
    switch (edge) {
      case 'left': return { dir: 'row', before: true };
      case 'right': return { dir: 'row', before: false };
      case 'top': return { dir: 'col', before: true };
      case 'bottom': return { dir: 'col', before: false };
      default: return { dir: 'row', before: false };
    }
  }

  /**
   * Can the dragged tab become a second pane next to the active tab? Requires a
   * distinct, non-nested, splittable tab (per its view descriptor) whose
   * container differs from the active tab's (two panes can't share one
   * singleton container).
   */
  _canSplit(draggedTabId) {
    const active = this.tabs.find(t => t.id === this.activeTabId);
    if (!active || active._nestedIn) return false;
    if (!draggedTabId || draggedTabId === this.activeTabId) return false;
    const dragged = this.tabs.find(t => t.id === draggedTabId);
    if (!dragged || dragged._nestedIn) return false;

    const aView = this._viewForTab(active);
    const bView = this._prospectiveView(dragged);
    const splittable = (view) => panes.view(view)?.splittable !== false;
    if (!splittable(aView) || !splittable(bView)) return false;
    return this._containerForView(aView) !== this._containerForView(bView);
  }

  /** Drag-commit entry point (called by PaneDnd on drop). */
  commitSplit(draggedTabId, edge) {
    if (!this._canSplit(draggedTabId)) return false;
    const active = this.tabs.find(t => t.id === this.activeTabId);

    // Replace an existing second pane if the active tab is already split.
    if (active.split) {
      const old = this.tabs.find(t => t.id === active.split.paneTabId);
      if (old) delete old._nestedIn;
    }
    const dragged = this.tabs.find(t => t.id === draggedTabId);
    const paneView = this._prospectiveView(dragged) === 'htmlPreview' ? 'htmlPreview' : null;
    const { dir, before } = this._edgeToDir(edge);
    this.setPaneB(active.id, draggedTabId, dir, before, paneView);
    return true;
  }

  setPaneB(parentId, childId, dir, before, paneView = null) {
    const parent = this.tabs.find(t => t.id === parentId);
    const child = this.tabs.find(t => t.id === childId);
    if (!parent || !child) return;
    parent.split = { dir, before: !!before, ratio: 0.5, paneTabId: childId, paneView: paneView || null };
    child._nestedIn = parentId;
    this.switchToTab(parentId);
  }

  /**
   * Undock a pane: collapse the split so both panes become standalone tabs. The
   * pane that was NOT popped out stays the active full view; the popped pane
   * drops into the tab bar. Non-destructive — closing content is a tab-bar
   * action. `pane` is 'A' (host) or 'B' (the nested second pane).
   */
  undockPane(hostId, pane) {
    const host = this.tabs.find(t => t.id === hostId);
    if (!host?.split) return;
    const child = this.tabs.find(t => t.id === host.split.paneTabId);
    delete host.split;
    if (child) delete child._nestedIn;
    // Popping out A leaves B (child) filling the space, and vice versa.
    const fill = pane === 'A' ? child : host;
    this.switchToTab((fill || host).id);
  }

  _applyPaneRatio(tab) {
    const child = this.tabs.find(t => t.id === tab.split.paneTabId);
    if (!child) return;
    const aEl = this._containerForView(this._viewForTab(tab));
    const bEl = this._containerForView(this._paneBView(tab, child));
    if (!aEl || !bEl) return;

    const ratio = tab.split.ratio ?? 0.5;
    const before = !!tab.split.before;
    aEl.style.flex = `${ratio} 1 0`;
    bEl.style.flex = `${1 - ratio} 1 0`;
    aEl.style.minWidth = '0'; aEl.style.minHeight = '0';
    bEl.style.minWidth = '0'; bEl.style.minHeight = '0';
    aEl.style.order = before ? '2' : '0';
    bEl.style.order = before ? '0' : '2';
  }

  _mountDivider(tab) {
    if (!this._paneDivider) {
      this._paneDivider = document.createElement('div');
      this._paneDivider.className = 'pane-divider';
    }
    const divider = this._paneDivider;
    divider.style.order = '1';
    divider.classList.toggle('pane-divider--row', tab.split.dir === 'row');
    divider.classList.toggle('pane-divider--col', tab.split.dir === 'col');
    this.contentArea.appendChild(divider);

    this._detachDivider?.();
    this._detachDivider = attachDivider(divider, {
      container: this.contentArea,
      axis: tab.split.dir === 'row' ? 'x' : 'y',
      min: 140,
      onResize: (frac) => {
        tab.split.ratio = tab.split.before ? (1 - frac) : frac;
        this._applyPaneRatio(tab);
        this._layoutPanes(tab);
        this._positionPaneUndockButtons();
      },
    });
  }

  /** Relayout pane content that doesn't auto-fit (Monaco, xterm) after a resize. */
  _layoutPanes(tab) {
    requestAnimationFrame(() => {
      const child = this.tabs.find(t => t.id === tab.split?.paneTabId);
      const views = [this._viewForTab(tab)];
      if (child) views.push(this._paneBView(tab, child));
      const ctx = this._ctx();
      for (const view of views) {
        panes.view(view)?.layout?.(ctx);
      }
      this._positionPaneUndockButtons();
    });
  }

  _mountPaneUndockButtons(tab) {
    this._clearPaneUndockButtons();
    const child = this.tabs.find(t => t.id === tab.split.paneTabId);
    if (!child) return;

    const btnA = this._makePaneUndockBtn(() => this.undockPane(tab.id, 'A'));
    const btnB = this._makePaneUndockBtn(() => this.undockPane(tab.id, 'B'));
    btnA._paneEl = this._containerForView(this._viewForTab(tab));
    btnB._paneEl = this._containerForView(this._paneBView(tab, child));
    this.contentArea.appendChild(btnA);
    this.contentArea.appendChild(btnB);
    this._paneUndockBtns = [btnA, btnB];
    this._positionPaneUndockButtons();
  }

  _makePaneUndockBtn(onClick) {
    const btn = document.createElement('button');
    btn.className = 'pane-undock';
    btn.title = 'Undock this pane (move it to its own tab)';
    // Static markup (no user data) — a "pop out" arrow leaving a box.
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5"/></svg>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  _positionPaneUndockButtons() {
    if (!this._paneUndockBtns || !this.contentArea) return;
    const base = this.contentArea.getBoundingClientRect();
    for (const btn of this._paneUndockBtns) {
      const el = btn._paneEl;
      if (!el || el.classList.contains('hidden')) { btn.style.display = 'none'; continue; }
      const r = el.getBoundingClientRect();
      btn.style.display = '';
      btn.style.top = `${r.top - base.top + 4}px`;
      btn.style.left = `${r.right - base.left - 28}px`;
    }
  }

  _clearPaneUndockButtons() {
    if (this._paneUndockBtns) {
      for (const btn of this._paneUndockBtns) btn.remove();
      this._paneUndockBtns = null;
    }
  }

  /** Tear down any split layout (called at the top of every switch). */
  _clearSplit() {
    if (this.contentArea) {
      this.contentArea.classList.remove('content-area--split', 'content-area--row', 'content-area--col');
    }
    this._detachDivider?.();
    this._detachDivider = null;
    if (this._paneDivider?.parentNode) this._paneDivider.parentNode.removeChild(this._paneDivider);
    this._clearPaneUndockButtons();
    for (const el of this._allContentEls()) {
      el.style.flex = '';
      el.style.order = '';
      el.style.minWidth = '';
      el.style.minHeight = '';
    }
  }

  _showEmptyState() {
    this.activeTabId = null;
    this._hideAllContent();
    this.app.voiceChatManager?.deactivate();
    this._destroyActiveViewer();
    this.app.showWelcomeScreen();
    this._updateHash(null);
  }

  /**
   * Marks a file tab as modified/unmodified
   */
  setFileModified(projectId, filePath, modified) {
    const tabId = `${projectId}:${filePath}`;
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.modified = modified;
      this.render();
    }
  }

  /**
   * Updates tab label (e.g., when file renamed)
   */
  updateTabLabel(tabId, newLabel) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.label = newLabel;
      this.render();
    }
  }

  /**
   * Re-registers file watchers after WebSocket reconnection. The frame itself
   * (skip plan projects, mark viewer files binary) is the `file` descriptor's
   * `watchFile` — the same one `create` sends on first open (public/panes/file-pane.js).
   */
  reestablishFileWatches() {
    const d = panes.type('file');
    for (const tab of this.tabs) {
      if (tab.type === d.type) d.watchFile(tab, this._ctx());
    }
  }

  /**
   * Re-render a viewer tab whose file changed on disk. If the tab is currently
   * active, refresh in place; otherwise the next switchToTab picks up the new
   * version via the cache-busted URL. Whether `path` is a viewer file at all
   * is the `file` descriptor's `view()` decision, not a local viewerRegistry
   * reach-through.
   */
  handleViewerFileChanged(projectId, path) {
    const d = panes.type('file');
    const tab = this.tabs.find(t => t.type === d.type && t.projectId === projectId && t.path === path);
    if (!tab || d.view(tab, this._ctx()) !== 'viewer') return;

    tab._reloadVersion = Date.now();

    if (tab.id === this.activeTabId && !this.viewerContent.classList.contains('hidden')) {
      this._destroyActiveViewer();
      this._showContentForRef('viewer', this._refForTab(tab));
    }
  }

  /**
   * Destroys the currently active viewer (pause media, clear canvas). The
   * teardown itself lives on the `viewer`/`image` view descriptors — they
   * share it verbatim, since both render into `#fileViewer` via the same
   * `_activeViewer` (see public/panes/views.js).
   */
  _destroyActiveViewer() {
    panes.view('viewer')?.destroy?.(this._ctx());
  }

  // --- LLM-driven image tabs (eve-control MCP) ---
  //
  // Tabs the LLM opens carry an `owner` ({ actor:'llm', projectId }). The human
  // closes them through the normal UI; the LLM (refresh/close) may only touch
  // tabs it owns in its own project — see _ownedBy. The source is a direct image
  // URL (e.g. /api/generated/...), not a project file.

  openImageTab(tabRef, imageUrl, title, owner) {
    if (!tabRef || !imageUrl) return;
    const projectId = owner?.projectId || null;
    let tab = this.tabs.find(t => t.id === tabRef);
    if (tab) {
      // Re-open of a known ref behaves like a refresh.
      tab.url = imageUrl;
      tab._reloadVersion = Date.now();
      if (tab.id === this.activeTabId) { this._destroyActiveViewer(); this._showContentForRef('image', { imageTabId: tab.id }); }
      return;
    }
    tab = panes.type('image').create({ tabRef, imageUrl, title, owner }, this._ctx());
    this.tabs.push(tab);
    // Only steal focus when the tab's project is already on screen — an LLM
    // running in a background project shouldn't yank the user's view across.
    if (!this._activeProjectId || this._activeProjectId === projectId) {
      this.switchToTab(tab.id);
    } else {
      this.render();
    }
  }

  refreshImageTab(tabRef, identity, imageUrl) {
    const d = panes.type('image');
    const tab = this.tabs.find(t => t.id === tabRef);
    if (!tab || tab.type !== d.type || !d.ownedBy(tab, identity)) return false;
    if (imageUrl) tab.url = imageUrl;
    tab._reloadVersion = Date.now();
    if (tab.id === this.activeTabId && !this.viewerContent.classList.contains('hidden')) {
      this._destroyActiveViewer();
      this._showContentForRef('image', { imageTabId: tab.id });
    }
    return true;
  }

  closeImageTab(tabRef, identity) {
    const tab = this.tabs.find(t => t.id === tabRef);
    if (!tab || !panes.type('image').ownedBy(tab, identity)) return false;
    this.closeTab(tabRef);
    return true;
  }

  /** Forwards to the `image` descriptor's ownership gate (image-pane.js) —
   *  kept as a real method since the unit suite calls it on a bare instance. */
  _ownedBy(tab, identity) {
    return panes.type('image').ownedBy(tab, identity);
  }

  /**
   * Renders the tab bar
   */
  render() {
    this.tabBar.innerHTML = '';

    for (const tab of this.tabs) {
      // Nested panes (the second pane of a split) have no tab-bar entry of their
      // own — they show inside their host tab.
      if (tab._nestedIn) continue;

      // Project-scoped: hide tabs that belong to other projects. With no active
      // project (e.g. before projects load) everything shows — the safe default.
      if (this._activeProjectId && this._tabProjectId(tab) !== this._activeProjectId) {
        continue;
      }

      const tabEl = document.createElement('div');
      tabEl.className = 'tab';
      tabEl.dataset.tabId = tab.id;
      tabEl.dataset.testid = `tab-${tab.id}`;
      if (tab.id === this.activeTabId) {
        tabEl.classList.add('active');
      }

      // Tab label with modified indicator
      const labelEl = document.createElement('span');
      labelEl.className = 'tab-label';
      labelEl.textContent = tab.label;
      if (tab.modified) {
        labelEl.textContent += ' ●';
      }

      // Click to switch
      labelEl.addEventListener('click', () => {
        this.switchToTab(tab.id);
      });

      // Close button: tap to close tab; a type whose descriptor declares
      // `onCloseLongPress` (currently only `session`) also deletes on a
      // 500 ms press.
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.dataset.testid = `tab-close-${tab.id}`;
      closeBtn.textContent = '×';
      let closeLongPress = null;
      let closeLongFired = false;
      const startClose = () => {
        closeLongFired = false;
        const d = panes.type(tab.type);
        if (!d?.onCloseLongPress) return;
        closeLongPress = setTimeout(() => {
          closeLongFired = true;
          d.onCloseLongPress(tab, this._ctx());
        }, 500);
      };
      const cancelClose = () => { clearTimeout(closeLongPress); };
      closeBtn.addEventListener('mousedown', startClose);
      closeBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startClose(); });
      closeBtn.addEventListener('mouseup', cancelClose);
      closeBtn.addEventListener('mouseleave', cancelClose);
      closeBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        cancelClose();
        if (!closeLongFired) this.closeTab(tab.id);
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (closeLongFired) return;
        this.closeTab(tab.id);
      });

      tabEl.appendChild(labelEl);
      tabEl.appendChild(closeBtn);
      this.tabBar.appendChild(tabEl);
    }
  }

  // --- Session tab persistence (localStorage) ---

  // --- Tab persistence (localStorage, shared helpers) ---

  _saveToStorage(key, id, value) {
    const stored = this._getStorage(key);
    stored[id] = value;
    localStorage.setItem(key, JSON.stringify(stored));
  }

  _removeFromStorage(key, id) {
    const stored = this._getStorage(key);
    delete stored[id];
    localStorage.setItem(key, JSON.stringify(stored));
  }

  _getStorage(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch { return {}; }
  }

  _getRecentEntries(key) {
    const stored = this._getStorage(key);
    const now = Date.now();
    const valid = {};
    const result = [];
    for (const [id, entry] of Object.entries(stored)) {
      const ts = typeof entry === 'number' ? entry : entry?.ts;
      if (ts && now - ts < TabManager.MAX_AGE_MS) {
        valid[id] = entry;
        result.push({ id, ...( typeof entry === 'object' ? entry : { ts: entry }) });
      }
    }
    if (Object.keys(valid).length !== Object.keys(stored).length) {
      localStorage.setItem(key, JSON.stringify(valid));
    }
    return result;
  }

  // --- Session persistence ---
  // Writing/removing the `eve-open-sessions` entry is now generic — see
  // openSession and closeTab, which drive it off the `session` descriptor's
  // `persist` field (public/panes/session-pane.js). `eve-session-meta` is
  // separate — session metadata, not tab bookkeeping (spec §H.6) — and its
  // three methods below stay unmoved, called from `message-dispatcher.js`
  // and `voice-chat-manager.js` directly, plus from `openSession` and the
  // session descriptor's `dispose` through `ctx.tabs`.

  _saveSessionMeta(sessionId, meta) {
    try {
      const stored = JSON.parse(localStorage.getItem(TabManager.SESSION_META_KEY) || '{}');
      stored[sessionId] = meta;
      localStorage.setItem(TabManager.SESSION_META_KEY, JSON.stringify(stored));
    } catch { /* ignore */ }
  }

  _removeSessionMeta(sessionId) {
    try {
      const stored = JSON.parse(localStorage.getItem(TabManager.SESSION_META_KEY) || '{}');
      delete stored[sessionId];
      localStorage.setItem(TabManager.SESSION_META_KEY, JSON.stringify(stored));
    } catch { /* ignore */ }
  }

  getSessionMeta(sessionId) {
    try {
      const stored = JSON.parse(localStorage.getItem(TabManager.SESSION_META_KEY) || '{}');
      return stored[sessionId] || null;
    } catch { return null; }
  }

  getRecentSessionIds() {
    return this._getRecentEntries(TabManager.SESSION_STORAGE_KEY).map(e => e.id);
  }

  // --- File persistence ---
  // Writing/removing an entry is now generic — see openFile and closeTab,
  // which drive it off the `file` descriptor's `persist` field
  // (public/panes/file-pane.js). The reader stays here unchanged (§H.5):
  // its name and shape are called from app.js on every reconnect.

  getRecentFiles() {
    return this._getRecentEntries(TabManager.FILE_STORAGE_KEY);
  }

  // --- Module persistence ---
  // Writing/removing an entry is now generic — see openModule and closeTab,
  // which drive it off the `module` descriptor's `persist` field
  // (public/panes/module-pane.js). The reader stays here unchanged (§H.5):
  // its name and shape are called from app.js on every reconnect.

  getRecentModules() {
    return this._getRecentEntries(TabManager.MODULE_STORAGE_KEY);
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabManager;
}
