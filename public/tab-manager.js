class TabManager {
  static SESSION_STORAGE_KEY = 'eve-open-sessions';
  static FILE_STORAGE_KEY = 'eve-open-files';
  static MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(client) {
    this.client = client;
    this.tabs = []; // [{ id, type: 'session'|'file'|'terminal', label, projectId, path?, modified? }]
    this.activeTabId = null;

    this.initElements();
    this.initEventListeners();
  }

  initElements() {
    this.tabBar = document.getElementById('tabBar');
    this.chatContent = document.getElementById('chat');
    this.editorContent = document.getElementById('editor');
    this.terminalContent = document.getElementById('terminal');
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
    const session = this.client.sessions.get(sessionId);
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
      const project = this.client.projects.get(session.projectId);
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
      this.client.showChatScreen();
      this.chatContent.classList.remove('hidden');
      this.client.currentSessionId = sessionId;
      this.render();
    } else {
      this.switchToTab(sessionId);
      this.render();
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

    // Register file watcher on server (skip plan files)
    if (!isPlanProject(projectId)) {
      this.client.ws?.send(JSON.stringify({
        type: 'watch_file',
        projectId,
        path: filePath
      }));
    }

    this.switchToTab(tabId);
    this.render();
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
    this.render();
  }

  /**
   * Switches active tab
   */
  switchToTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.activeTabId = tabId;

    // Ensure chat screen is visible (hides welcome screen)
    this.client.showChatScreen();

    // Hide all content containers first
    this.chatContent.classList.add('hidden');
    this.editorContent.classList.add('hidden');
    this.terminalContent.classList.add('hidden');

    // Show appropriate content container
    if (tab.type === 'session') {
      this.chatContent.classList.remove('hidden');

      // Flush any partial streaming message from the old session to its history
      const prevSessionId = this.client.currentSessionId;
      if (prevSessionId && prevSessionId !== tab.id) {
        this.client.messageRenderer.finishAssistantMessage();
      }

      // Flush background buffer for the session we're switching to
      if (this.client.messageDispatcher) {
        this.client.messageDispatcher.flushBackgroundBuffer(tab.id);
      }

      // Update current session in client
      this.client.currentSessionId = tab.id;
      this.client.renderMessages();
      this.client.updateStatsForSession(tab.id);

      // Restore stop button state based on whether this session is streaming
      if (this.client.messageDispatcher?.streamingSessions.has(tab.id)) {
        this.client.showStopButton();
        this.client.messageRenderer.showThinkingIndicator();
      } else {
        this.client.hideStopButton();
      }
    } else if (tab.type === 'file') {
      this.editorContent.classList.remove('hidden');

      // Notify file editor to show this file
      if (this.client.fileEditor) {
        this.client.fileEditor.showFile(tab.projectId, tab.path);
      }
    } else if (tab.type === 'terminal') {
      this.terminalContent.classList.remove('hidden');

      // Show terminal in container
      if (this.client.terminalManager) {
        this.client.terminalManager.showTerminal(tab.id);
      }
    }

    this.render();
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
      this.client.ws?.send(JSON.stringify({
        type: 'unwatch_file',
        projectId: tab.projectId,
        path: tab.path
      }));
    }

    // Send leave_session to unbind from relayLLM when closing a session tab
    if (tab.type === 'session') {
      this._removeSessionTab(tab.id);
      this.client.wsClient.send({ type: 'leave_session', sessionId: tab.id });
      if (this.client.messageDispatcher) {
        this.client.messageDispatcher.backgroundBuffers.delete(tab.id);
        this.client.messageDispatcher.streamingSessions.delete(tab.id);
      }
    }

    // Clean up terminal if closing terminal tab
    if (tab.type === 'terminal' && this.client.terminalManager) {
      this.client.terminalManager.closeTerminal(tab.id);
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
        this.terminalContent.classList.add('hidden');
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
      if (tab.type === 'file' && !isPlanProject(tab.projectId)) {
        this.client.ws?.send(JSON.stringify({
          type: 'watch_file',
          projectId: tab.projectId,
          path: tab.path
        }));
      }
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

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
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
  }

  _removeSessionTab(sessionId) {
    this._removeFromStorage(TabManager.SESSION_STORAGE_KEY, sessionId);
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
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabManager;
}
