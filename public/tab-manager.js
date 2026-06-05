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

    // The activity rail owns project selection; follow it.
    this.bus.on(EVT.PROJECT_ACTIVATED, ({ projectId }) => this.setActiveProject(projectId));
  }

  initElements() {
    this.tabBar = document.getElementById('tabBar');
    this.chatContent = document.getElementById('chat');
    this.editorContent = document.getElementById('editor');
    this.viewerContent = document.getElementById('fileViewer');
    this.viewerCanvas = document.getElementById('fileViewerCanvas');
    this.viewerPath = document.getElementById('fileViewerPath');
    this.viewerInfo = document.getElementById('fileViewerInfo');
    this.terminalContent = document.getElementById('terminal');
    this.voiceChatContent = document.getElementById('voiceChat');
    this.moduleContent = document.getElementById('moduleContent');
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
  }

  /**
   * Opens a session as a tab
   */
  openSession(sessionId, { skipRender = false } = {}) {
    const session = this.app.sessions.get(sessionId);
    if (!session) return;

    // Check if tab already exists
    const existingTab = this.tabs.find(t => t.type === 'session' && t.id === sessionId);
    if (existingTab) {
      if (skipRender) return;
      this.switchToTab(existingTab.id);
      return;
    }

    // Get label: prefer custom name, then project name, then directory
    let label;
    if (session.name) {
      label = session.name;
    } else if (session.projectId) {
      const project = this.app.projects.get(session.projectId);
      label = project?.name || session.directory;
    } else {
      label = session.directory?.split('/').filter(p => p).pop() || session.directory || 'Session';
    }

    // Create new tab
    const tab = {
      id: sessionId,
      type: 'session',
      label,
      projectId: session.projectId
    };

    this.tabs.push(tab);
    this._saveSessionTab(sessionId);

    if (skipRender) {
      // Make tab active without triggering renderMessages
      this.activeTabId = sessionId;
      this._rememberActive(tab);
      this.app.showChatScreen();
      if (session.sessionType === 'voice') {
        this.voiceChatContent?.classList.remove('hidden');
        this.app.voiceChatManager?.activateForSession(sessionId);
      } else {
        this.chatContent.classList.remove('hidden');
      }
      this.app.currentSessionId = sessionId;
      this._syncProjectToActiveTab();
      this.render();
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

    // Create new tab
    const tab = {
      id: tabId,
      type: 'file',
      label: label || filePath.split('/').pop(),
      projectId,
      path: filePath,
      modified: false
    };

    this.tabs.push(tab);
    this._saveFileTab(projectId, filePath);

    this._sendWatchFile(projectId, filePath);

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

    // Create new tab
    const tab = {
      id: terminalId,
      type: 'terminal',
      label,
      directory
    };

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
    const tab = {
      id: tabId,
      type: 'module',
      label: label || moduleName,
      projectId,
      moduleName,
    };
    this.tabs.push(tab);
    this._saveModuleTab(projectId, moduleName);
    this.switchToTab(tabId);
  }

  /**
   * Switches active tab
   */
  switchToTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.activeTabId = tabId;
    this._rememberActive(tab);

    // Ensure chat screen is visible (hides welcome screen)
    this.app.showChatScreen();

    // Hide all content containers first
    this._hideAllContent();

    // Destroy active viewer when switching away (pause media, free memory)
    this._destroyActiveViewer();

    // Show appropriate content container
    if (tab.type === 'session') {
      const session = this.app.sessions.get(tab.id);
      if (session?.sessionType === 'voice') {
        this.voiceChatContent?.classList.remove('hidden');
        this.app.voiceChatManager?.activateForSession(tab.id);
      } else {
        this.chatContent.classList.remove('hidden');
        this.app.voiceChatManager?.deactivate();
      }
      this.app._updateVoiceUIBtnVisibility?.();

      // Flush any partial streaming message from the old session to its history
      const prevSessionId = this.app.currentSessionId;
      if (prevSessionId && prevSessionId !== tab.id) {
        this.app.messageRenderer.finishAssistantMessage();
      }

      // Flush background buffer for the session we're switching to
      if (this.app.messageDispatcher) {
        this.app.messageDispatcher.flushBackgroundBuffer(tab.id);
      }

      // Update current session in client
      this.app.currentSessionId = tab.id;
      this.app.renderMessages();
      this.app.updateStatsForSession(tab.id);

      // Restore stop button state based on whether this session is streaming
      if (this.app.messageDispatcher?.streamingSessions.has(tab.id)) {
        this.app.showStopButton();
        this.app.messageRenderer.showThinkingIndicator();
      } else {
        this.app.hideStopButton();
      }
    } else if (tab.type === 'file') {
      const registry = this.app.viewerRegistry;
      if (registry && registry.isViewerFile(tab.path)) {
        // Binary file: render with appropriate viewer
        this.viewerContent.classList.remove('hidden');
        this._renderViewer(tab);
      } else {
        // Text file: show in Monaco editor
        this.editorContent.classList.remove('hidden');
        if (this.app.fileEditor) {
          this.app.fileEditor.showFile(tab.projectId, tab.path);
        }
      }
    } else if (tab.type === 'terminal') {
      this.terminalContent.classList.remove('hidden');

      // Show terminal in container
      if (this.app.terminalManager) {
        this.app.terminalManager.showTerminal(tab.id);
      }
    } else if (tab.type === 'module') {
      if (this.moduleContent) this.moduleContent.classList.remove('hidden');
      if (this.app.moduleHost) this.app.moduleHost.activate(tab);
    } else if (tab.type === 'image') {
      // LLM image tab (eve-control MCP): source is a direct URL, not a project
      // file, so it renders through _renderImageTab rather than _renderViewer.
      this.viewerContent.classList.remove('hidden');
      this._renderImageTab(tab);
    }

    // Deep links / restore / task-join can activate a tab outside the current
    // project — pull the rail across so the active tab stays visible.
    this._syncProjectToActiveTab();
    this.render();
    this._updateHash(tab);
  }

  /**
   * Updates location.hash to reflect the active tab.
   * Uses replaceState to avoid firing hashchange events.
   */
  _updateHash(tab) {
    let hash = '';
    if (tab) {
      if (tab.type === 'session') {
        hash = `#session/${encodeURIComponent(tab.id)}`;
      } else if (tab.type === 'file') {
        hash = `#file/${encodeURIComponent(tab.projectId)}/${encodeURIComponent(tab.path)}`;
      } else if (tab.type === 'terminal') {
        hash = `#terminal/${encodeURIComponent(tab.id)}`;
      } else if (tab.type === 'module') {
        hash = `#module/${encodeURIComponent(tab.projectId)}/${encodeURIComponent(tab.moduleName)}`;
      }
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
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = this.tabs[tabIndex];

    // Check for unsaved changes on file tabs
    if (tab.type === 'file' && tab.modified) {
      if (!confirm(`"${tab.label}" has unsaved changes. Close anyway?`)) {
        return;
      }
    }

    // Remove from localStorage and unregister file watcher
    if (tab.type === 'file') {
      this._removeFileTab(tab.projectId, tab.path);
    }
    if (tab.type === 'file' && !isPlanProject(tab.projectId)) {
      this.app.ws?.send(JSON.stringify({
        type: 'unwatch_file',
        projectId: tab.projectId,
        path: tab.path
      }));
    }

    // Send leave_session to unbind from relayLLM when closing a session tab
    if (tab.type === 'session') {
      this._removeSessionTab(tab.id);
      this.app.wsClient.send({ type: 'leave_session', sessionId: tab.id });
      if (this.app.messageDispatcher) {
        this.app.messageDispatcher.backgroundBuffers.delete(tab.id);
        this.app.messageDispatcher.streamingSessions.delete(tab.id);
      }
    }

    // Clean up terminal if closing terminal tab
    if (tab.type === 'terminal' && this.app.terminalManager) {
      this.app.terminalManager.closeTerminal(tab.id);
    }

    // Destroy module iframe + drop from localStorage
    if (tab.type === 'module') {
      this._removeModuleTab(tab.projectId, tab.moduleName);
      if (this.app.moduleHost) this.app.moduleHost.destroy(tab.id);
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
   * directory falling under a project's path. Returns null when unscoped.
   */
  _tabProjectId(tab) {
    if (tab.type === 'terminal') return this._projectIdForDirectory(tab.directory);
    return tab.projectId || null;
  }

  /**
   * Longest-prefix match of a directory against known project paths.
   */
  _projectIdForDirectory(directory) {
    if (!directory) return null;
    const dir = directory.replace(/\/+$/, '').toLowerCase();
    let bestId = null;
    let bestLen = -1;
    for (const project of this.app.projects.values()) {
      if (!project.path) continue;
      const path = project.path.replace(/\/+$/, '').toLowerCase();
      if ((dir === path || dir.startsWith(path + '/')) && path.length > bestLen) {
        bestId = project.id;
        bestLen = path.length;
      }
    }
    return bestId;
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
      if (tab && this._tabProjectId(tab) === projectId) return tab;
    }
    // Fall back to the rightmost tab belonging to this project.
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      if (this._tabProjectId(this.tabs[i]) === projectId) return this.tabs[i];
    }
    return null;
  }

  /**
   * Nearest tab in the active project relative to a closed index (prefer the
   * tab that shifted into its place, then look left). Null when none remain.
   */
  _nextTabInProject(fromIndex) {
    const inProject = (t) => this._tabProjectId(t) === this._activeProjectId;
    for (let i = fromIndex; i < this.tabs.length; i++) {
      if (inProject(this.tabs[i])) return this.tabs[i];
    }
    for (let i = fromIndex - 1; i >= 0; i--) {
      if (inProject(this.tabs[i])) return this.tabs[i];
    }
    return null;
  }

  _hideAllContent() {
    this.chatContent.classList.add('hidden');
    this.editorContent.classList.add('hidden');
    this.viewerContent.classList.add('hidden');
    this.terminalContent.classList.add('hidden');
    if (this.voiceChatContent) this.voiceChatContent.classList.add('hidden');
    if (this.moduleContent) this.moduleContent.classList.add('hidden');
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
   * Re-registers file watchers after WebSocket reconnection.
   */
  reestablishFileWatches() {
    for (const tab of this.tabs) {
      if (tab.type === 'file') {
        this._sendWatchFile(tab.projectId, tab.path);
      }
    }
  }

  /**
   * Sends a watch_file message for the given path, skipping plan files and
   * marking viewer files as binary so the server omits content from updates.
   */
  _sendWatchFile(projectId, filePath) {
    if (isPlanProject(projectId)) return;
    const isViewer = !!this.app.viewerRegistry?.isViewerFile(filePath);
    this.app.ws?.send(JSON.stringify({
      type: 'watch_file',
      projectId,
      path: filePath,
      binary: isViewer
    }));
  }

  /**
   * Renders a viewer file into the viewer canvas.
   */
  _renderViewer(tab) {
    const registry = this.app.viewerRegistry;
    const viewer = registry.getViewer(tab.path);
    if (!viewer) return;

    const url = registry.buildFileUrl(tab.projectId, tab.path, tab._reloadVersion);
    this.viewerPath.textContent = tab.path;
    this.viewerInfo.textContent = '';
    this._activeViewer = viewer;

    viewer.render(this.viewerCanvas, {
      projectId: tab.projectId,
      path: tab.path,
      filename: tab.label,
      url
    });
  }

  /**
   * Re-render a viewer tab whose file changed on disk. If the tab is currently
   * active, refresh in place; otherwise the next switchToTab picks up the new
   * version via the cache-busted URL.
   */
  handleViewerFileChanged(projectId, path) {
    const tab = this.tabs.find(
      t => t.type === 'file' && t.projectId === projectId && t.path === path
    );
    if (!tab || !this.app.viewerRegistry?.isViewerFile(tab.path)) return;

    tab._reloadVersion = Date.now();

    if (tab.id === this.activeTabId && !this.viewerContent.classList.contains('hidden')) {
      this._destroyActiveViewer();
      this._renderViewer(tab);
    }
  }

  /**
   * Destroys the currently active viewer (pause media, clear canvas).
   */
  _destroyActiveViewer() {
    if (this._activeViewer) {
      this._activeViewer.destroy(this.viewerCanvas);
      this._activeViewer = null;
    }
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
      if (tab.id === this.activeTabId) { this._destroyActiveViewer(); this._renderImageTab(tab); }
      return;
    }
    tab = { id: tabRef, type: 'image', label: title || 'Image', projectId, url: imageUrl, owner: owner || null };
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
    const tab = this.tabs.find(t => t.id === tabRef);
    if (!tab || tab.type !== 'image' || !this._ownedBy(tab, identity)) return false;
    if (imageUrl) tab.url = imageUrl;
    tab._reloadVersion = Date.now();
    if (tab.id === this.activeTabId && !this.viewerContent.classList.contains('hidden')) {
      this._destroyActiveViewer();
      this._renderImageTab(tab);
    }
    return true;
  }

  closeImageTab(tabRef, identity) {
    const tab = this.tabs.find(t => t.id === tabRef);
    if (!tab || !this._ownedBy(tab, identity)) return false;
    this.closeTab(tabRef);
    return true;
  }

  /** The LLM may only mutate tabs it opened, and only within its own project. */
  _ownedBy(tab, identity) {
    return !!tab.owner && tab.owner.actor === 'llm'
      && identity?.actor === 'llm'
      && !!identity.projectId && tab.owner.projectId === identity.projectId;
  }

  _renderImageTab(tab) {
    const registry = this.app.viewerRegistry;
    // Strip any cache-bust query before extension matching; keep it on the src.
    const cleanName = String(tab.url).split('?')[0];
    const viewer = registry?.getViewer(cleanName) || registry?.getViewer('image.png');
    if (!viewer) return;
    const url = tab._reloadVersion
      ? `${tab.url}${tab.url.includes('?') ? '&' : '?'}v=${tab._reloadVersion}`
      : tab.url;
    this.viewerPath.textContent = tab.label;
    this.viewerInfo.textContent = '';
    this._activeViewer = viewer;
    viewer.render(this.viewerCanvas, { filename: tab.label, url });
  }

  /**
   * Renders the tab bar
   */
  render() {
    this.tabBar.innerHTML = '';

    for (const tab of this.tabs) {
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

      // Close button: tap to close tab, long-press to delete session from server
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.dataset.testid = `tab-close-${tab.id}`;
      closeBtn.textContent = '×';
      let closeLongPress = null;
      let closeLongFired = false;
      const startClose = () => {
        closeLongFired = false;
        if (tab.type !== 'session') return;
        closeLongPress = setTimeout(() => {
          closeLongFired = true;
          this.app.deleteSession(tab.id);
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

  _saveSessionTab(sessionId) {
    this._saveToStorage(TabManager.SESSION_STORAGE_KEY, sessionId, Date.now());
    // Persist session metadata (sessionType) for reload
    const session = this.app.sessions.get(sessionId);
    if (session?.sessionType) {
      this._saveSessionMeta(sessionId, { sessionType: session.sessionType });
    }
  }

  _removeSessionTab(sessionId) {
    this._removeFromStorage(TabManager.SESSION_STORAGE_KEY, sessionId);
    this._removeSessionMeta(sessionId);
  }

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

  _saveFileTab(projectId, filePath) {
    const key = `${projectId}:${filePath}`;
    this._saveToStorage(TabManager.FILE_STORAGE_KEY, key, { projectId, path: filePath, ts: Date.now() });
  }

  _removeFileTab(projectId, filePath) {
    const key = `${projectId}:${filePath}`;
    this._removeFromStorage(TabManager.FILE_STORAGE_KEY, key);
  }

  getRecentFiles() {
    return this._getRecentEntries(TabManager.FILE_STORAGE_KEY);
  }

  // --- Module persistence ---

  _saveModuleTab(projectId, moduleName) {
    const key = `${projectId}:${moduleName}`;
    this._saveToStorage(TabManager.MODULE_STORAGE_KEY, key, { projectId, moduleName, ts: Date.now() });
  }

  _removeModuleTab(projectId, moduleName) {
    const key = `${projectId}:${moduleName}`;
    this._removeFromStorage(TabManager.MODULE_STORAGE_KEY, key);
  }

  getRecentModules() {
    return this._getRecentEntries(TabManager.MODULE_STORAGE_KEY);
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabManager;
}
