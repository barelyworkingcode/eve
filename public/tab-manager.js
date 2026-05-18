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
    this.tabs = []; // [{ id, type: 'session'|'file'|'terminal', label, projectId, path?, modified? }]
    this.activeTabId = null;

    this.initElements();
    this.initEventListeners();
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
      this.app.showChatScreen();
      if (session.sessionType === 'voice') {
        this.voiceChatContent?.classList.remove('hidden');
        this.app.voiceChatManager?.activateForSession(sessionId);
      } else {
        this.chatContent.classList.remove('hidden');
      }
      this.app.currentSessionId = sessionId;
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

    // Ensure chat screen is visible (hides welcome screen)
    this.app.showChatScreen();

    // Hide all content containers first
    this.chatContent.classList.add('hidden');
    this.editorContent.classList.add('hidden');
    this.viewerContent.classList.add('hidden');
    this.terminalContent.classList.add('hidden');
    if (this.voiceChatContent) this.voiceChatContent.classList.add('hidden');
    if (this.moduleContent) this.moduleContent.classList.add('hidden');

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
    }

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

    // If this was the active tab, switch to another
    if (this.activeTabId === tabId) {
      if (this.tabs.length > 0) {
        // Switch to tab to the right, or leftmost if closing rightmost
        const nextTab = this.tabs[tabIndex] || this.tabs[tabIndex - 1];
        this.switchToTab(nextTab.id);
      } else {
        // No tabs left
        this.activeTabId = null;
        this.chatContent.classList.add('hidden');
        this.editorContent.classList.add('hidden');
        this.viewerContent.classList.add('hidden');
        this.terminalContent.classList.add('hidden');
        if (this.voiceChatContent) this.voiceChatContent.classList.add('hidden');
        if (this.moduleContent) this.moduleContent.classList.add('hidden');
        this.app.voiceChatManager?.deactivate();
        this._destroyActiveViewer();
        this._updateHash(null);
      }
    }

    this.render();
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

  /**
   * Renders the tab bar
   */
  render() {
    this.tabBar.innerHTML = '';

    for (const tab of this.tabs) {
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
