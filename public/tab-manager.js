// `panes` is core/pane-registry.js's file-scope const, already in scope here
// because its <script> tag loads first (index.html) — classic scripts share
// one top-level scope, so no import is possible. Under Jest there's no such
// script ordering, so require it directly and hang the same singleton on
// `global` instead.
if (typeof module !== 'undefined' && module.exports) {
  require('./core/pane-registry.js'); // also loads every panes/*.js and publishes `panes` on `global`
}

class TabManager {
  static SESSION_STORAGE_KEY = 'eve-open-sessions';
  static SESSION_META_KEY = 'eve-session-meta';
  static FILE_STORAGE_KEY = 'eve-open-files';
  static MODULE_STORAGE_KEY = 'eve-open-modules';
  static MAX_AGE_MS = 24 * 60 * 60 * 1000;

  constructor(container) {
    this.container = container;
    this.app = container.get('app');
    this.bus = container.get('bus');
    this.tabs = [];
    this.activeTabId = null;

    this._activeProjectId = null;
    this._lastActiveByProject = new Map();

    this.initElements();
    this.initEventListeners();

    if (typeof PaneDnd !== 'undefined' && this.contentArea) {
      this.paneDnd = new PaneDnd(this);
    }

    this.bus.on(EVT.PROJECT_ACTIVATED, ({ projectId }) => this.setActiveProject(projectId));
  }

  initElements() {
    this.tabBar = document.getElementById('tabBar');
    this.contentArea = document.getElementById('contentArea');

    // One element per registered view (public/panes/views.js), keyed by
    // `elementId` from index.html. Also mirrored onto the named properties
    // below since other methods still look them up by name.
    this._viewEls = new Map(panes.views().map(v => [v.view, document.getElementById(v.elementId)]));
    this.chatContent = this._viewEls.get('chat');
    this.voiceChatContent = this._viewEls.get('voice');
    this.editorContent = this._viewEls.get('editor');
    this.viewerContent = this._viewEls.get('viewer'); // shared with 'image' — see panes/views.js
    this.terminalContent = this._viewEls.get('terminal');
    this.moduleContent = this._viewEls.get('module');
    this.htmlPreviewContent = this._viewEls.get('htmlPreview');

    this.viewerCanvas = document.getElementById('fileViewerCanvas');
    this.viewerPath = document.getElementById('fileViewerPath');
    this.viewerInfo = document.getElementById('fileViewerInfo');
  }

  initEventListeners() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) {
          this.closeTab(this.activeTabId);
        }
      }
    });

    // Monaco and xterm need an explicit relayout after resize; CSS alone won't do it.
    window.addEventListener('resize', () => {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab?.split) {
        this._layoutPanes(tab);
        this._positionPaneUndockButtons();
      }
    });
  }

  openSession(sessionId, { skipRender = false } = {}) {
    const session = this.app.sessions.get(sessionId);
    if (!session) return;

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
      // Deliberately diverges from switchToTab — see session-pane.js's activateSkipRender.
      d.activateSkipRender(tab, this._ctx());
    } else {
      this.switchToTab(sessionId);
    }
  }

  openFile(projectId, filePath, label) {
    const tabId = `${projectId}:${filePath}`;

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

  openTerminal(terminalId, label, directory) {
    const existingTab = this.tabs.find(t => t.id === terminalId);
    if (existingTab) {
      this.switchToTab(terminalId);
      return;
    }

    const tab = panes.type('terminal').create({ terminalId, label, directory }, this._ctx());
    this.tabs.push(tab);
    this.switchToTab(terminalId);
  }

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

  switchToTab(tabId) {
    let tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // A nested pane has no standalone view; activate its host split instead.
    if (tab._nestedIn) {
      const host = this.tabs.find(t => t.id === tab._nestedIn);
      if (host) { tab = host; tabId = host.id; }
    }

    this.activeTabId = tabId;
    this._rememberActive(tab);

    this.app.showChatScreen();

    this._hideAllContent();

    this._destroyActiveViewer();

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

    // Deep link / restore / task-join can activate a tab from another project.
    this._syncProjectToActiveTab();
    this.render();
    this._updateHash(tab);
  }

  /**
   * Rebuilt on every call, never captured: services reached through `app`
   * (fileEditor, terminalManager, moduleHost, voiceChatManager, ...) are
   * constructed after `new TabManager` runs (app.js), so a descriptor that
   * memoised this would get `undefined` on first use.
   */
  _ctx() {
    return { container: this.container, app: this.app, tabs: this, bus: this.bus };
  }

  _viewForTab(tab) {
    return panes.type(tab.type).view(tab, this._ctx());
  }

  _refForTab(tab) {
    return panes.type(tab.type).ref(tab);
  }

  /** A split may override the second pane's view (e.g. an HTML file docks as a live preview instead of its editor). */
  _paneBView(tab, child) {
    return tab.split?.paneView || this._viewForTab(child);
  }

  /** `file` overrides this so a dragged-in HTML file previews live instead of opening its editor source — see file-pane.js. */
  _prospectiveView(tab) {
    const d = panes.type(tab.type);
    if (d) return d.prospectiveView ? d.prospectiveView(tab, this._ctx()) : d.view(tab, this._ctx());
    return this._viewForTab(tab);
  }

  /** Two panes must resolve to different containers — the singleton guard for splits. */
  _containerForView(view) {
    return this._viewEls.get(view) || null;
  }

  _showContentForRef(view, ref) {
    const d = panes.view(view);
    if (d) d.show(ref, this._ctx(), this._containerForView(view));
  }

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

  closeTab(tabId) {
    let tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const closeGate = panes.type(tab.type);
    if (closeGate?.confirmClose && !closeGate.confirmClose(tab, this._ctx())) {
      return;
    }

    if (tab.split?.paneTabId) {
      const childId = tab.split.paneTabId;
      delete tab.split;
      const child = this.tabs.find(t => t.id === childId);
      if (child) { delete child._nestedIn; this.closeTab(childId); }
    }
    if (tab._nestedIn) {
      const parent = this.tabs.find(t => t.id === tab._nestedIn);
      if (parent?.split) delete parent.split;
      delete tab._nestedIn;
    }

    // Re-find the index — closing a nested pane above may have shifted the array.
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;
    tab = this.tabs[tabIndex];

    const migratedType = panes.type(tab.type);
    if (migratedType) {
      if (migratedType.persist) this._removeFromStorage(migratedType.persist.key, migratedType.persist.entryId(tab));
      if (migratedType.dispose) migratedType.dispose(tab, this._ctx());
    }

    this.tabs.splice(tabIndex, 1);

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

  /** Terminals resolve projectId by longest-prefix match on working directory (terminal-pane.js); others read tab.projectId directly. */
  _tabProjectId(tab) {
    const d = panes.type(tab.type);
    if (d?.projectId) return d.projectId(tab, this._ctx());
    return tab.projectId || null;
  }

  /** Kept as a real method — the unit suite calls it directly on a bare instance with no `ctx`. */
  _projectIdForDirectory(directory) {
    return panes.type('terminal').projectId({ directory }, this._ctx());
  }

  _rememberActive(tab) {
    const projectId = this._tabProjectId(tab);
    if (projectId) this._lastActiveByProject.set(projectId, tab.id);
  }

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

  // A tab from another project can become active via deep link, reload
  // restore, or task-join — pull the sidebar across so it stays visible.
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
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      if (!this.tabs[i]._nestedIn && this._tabProjectId(this.tabs[i]) === projectId) return this.tabs[i];
    }
    return null;
  }

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

  // Split mode never re-parents the heavy containers (session/editor/terminal
  // DOM survives) — it un-hides two of them and sizes them with flex,
  // ordering via CSS `order` instead of DOM order.

  _allContentEls() {
    return [...new Set(this._viewEls.values())].filter(Boolean);
  }

  _edgeToDir(edge) {
    switch (edge) {
      case 'left': return { dir: 'row', before: true };
      case 'right': return { dir: 'row', before: false };
      case 'top': return { dir: 'col', before: true };
      case 'bottom': return { dir: 'col', before: false };
      default: return { dir: 'row', before: false };
    }
  }

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

  commitSplit(draggedTabId, edge) {
    if (!this._canSplit(draggedTabId)) return false;
    const active = this.tabs.find(t => t.id === this.activeTabId);

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

  /** `pane` is 'A' (host) or 'B' (nested second pane); the one NOT popped out stays as the active full view. */
  undockPane(hostId, pane) {
    const host = this.tabs.find(t => t.id === hostId);
    if (!host?.split) return;
    const child = this.tabs.find(t => t.id === host.split.paneTabId);
    delete host.split;
    if (child) delete child._nestedIn;
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

  /** Monaco and xterm don't auto-fit their container — relayout them explicitly after resize. */
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
    // Static SVG, no user data — safe to set via innerHTML.
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

  setFileModified(projectId, filePath, modified) {
    const tabId = `${projectId}:${filePath}`;
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.modified = modified;
      this.render();
    }
  }

  updateTabLabel(tabId, newLabel) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.label = newLabel;
      this.render();
    }
  }

  // Delegates to the `file` descriptor's watchFile (file-pane.js) — the same one `create` sends on first open.
  reestablishFileWatches() {
    const d = panes.type('file');
    for (const tab of this.tabs) {
      if (tab.type === d.type) d.watchFile(tab, this._ctx());
    }
  }

  // Whether `path` is a viewer file is the `file` descriptor's view() decision, not looked up here.
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

  // Viewer and image share teardown since both render into #fileViewer via the same `_activeViewer` (panes/views.js).
  _destroyActiveViewer() {
    panes.view('viewer')?.destroy?.(this._ctx());
  }

  // Tabs the LLM opens carry an `owner` ({ actor:'llm', projectId }). The LLM
  // may only refresh/close tabs it owns in its own project — see _ownedBy.

  openImageTab(tabRef, imageUrl, title, owner) {
    if (!tabRef || !imageUrl) return;
    const projectId = owner?.projectId || null;
    let tab = this.tabs.find(t => t.id === tabRef);
    if (tab) {
      tab.url = imageUrl;
      tab._reloadVersion = Date.now();
      if (tab.id === this.activeTabId) { this._destroyActiveViewer(); this._showContentForRef('image', { imageTabId: tab.id }); }
      return;
    }
    tab = panes.type('image').create({ tabRef, imageUrl, title, owner }, this._ctx());
    this.tabs.push(tab);
    // Only steal focus if the tab's project is already on screen — a background-project LLM shouldn't yank the user's view across.
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

  /** Kept as a real method — the unit suite calls it directly on a bare instance. */
  _ownedBy(tab, identity) {
    return panes.type('image').ownedBy(tab, identity);
  }

  render() {
    this.tabBar.innerHTML = '';

    for (const tab of this.tabs) {
      if (tab._nestedIn) continue;

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

      const labelEl = document.createElement('span');
      labelEl.className = 'tab-label';
      labelEl.textContent = tab.label;
      if (tab.modified) {
        labelEl.textContent += ' ●';
      }

      labelEl.addEventListener('click', () => {
        this.switchToTab(tab.id);
      });

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

  // `eve-session-meta` is separate from tab persistence — called directly
  // from message-dispatcher.js and voice-chat-manager.js, plus openSession
  // and the session descriptor's dispose via ctx.tabs.

  _saveSessionMeta(sessionId, meta) {
    try {
      const stored = JSON.parse(localStorage.getItem(TabManager.SESSION_META_KEY) || '{}');
      stored[sessionId] = meta;
      localStorage.setItem(TabManager.SESSION_META_KEY, JSON.stringify(stored));
    } catch { }
  }

  _removeSessionMeta(sessionId) {
    try {
      const stored = JSON.parse(localStorage.getItem(TabManager.SESSION_META_KEY) || '{}');
      delete stored[sessionId];
      localStorage.setItem(TabManager.SESSION_META_KEY, JSON.stringify(stored));
    } catch { }
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

  getRecentFiles() {
    return this._getRecentEntries(TabManager.FILE_STORAGE_KEY);
  }

  getRecentModules() {
    return this._getRecentEntries(TabManager.MODULE_STORAGE_KEY);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabManager;
}
