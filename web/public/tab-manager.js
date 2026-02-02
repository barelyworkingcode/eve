class TabManager {
  constructor(client) {
    this.client = client;
    this.tabs = []; // [{ id, type: 'session'|'file', label, projectId, path?, modified? }]
    this.activeTabId = null;

    this.initElements();
    this.initEventListeners();
  }

  initElements() {
    this.tabBar = document.getElementById('tabBar');
    this.chatContent = document.getElementById('chat');
    this.editorContent = document.getElementById('editor');
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
  openSession(sessionId) {
    const session = this.client.sessions.get(sessionId);
    if (!session) return;

    // Check if tab already exists
    const existingTab = this.tabs.find(t => t.type === 'session' && t.id === sessionId);
    if (existingTab) {
      this.switchToTab(existingTab.id);
      return;
    }

    // Get project name or directory for label
    let label;
    if (session.projectId) {
      const project = this.client.projects.get(session.projectId);
      label = project?.name || session.directory;
    } else {
      // Use last part of directory path
      label = session.directory.split('/').filter(p => p).pop() || session.directory;
    }

    // Create new tab
    const tab = {
      id: sessionId,
      type: 'session',
      label,
      projectId: session.projectId
    };

    this.tabs.push(tab);
    this.switchToTab(sessionId);
    this.render();
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
    this.switchToTab(tabId);
    this.render();
  }

  /**
   * Switches active tab
   */
  switchToTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.activeTabId = tabId;

    // Show appropriate content container
    if (tab.type === 'session') {
      this.chatContent.style.display = 'flex';
      this.editorContent.style.display = 'none';

      // Update current session in client
      this.client.currentSessionId = tab.id;
      this.client.renderMessages();
    } else if (tab.type === 'file') {
      this.chatContent.style.display = 'none';
      this.editorContent.style.display = 'flex';

      // Notify file editor to show this file
      if (this.client.fileEditor) {
        this.client.fileEditor.showFile(tab.projectId, tab.path);
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
        this.chatContent.style.display = 'none';
        this.editorContent.style.display = 'none';
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
   * Renders the tab bar
   */
  render() {
    this.tabBar.innerHTML = '';

    for (const tab of this.tabs) {
      const tabEl = document.createElement('div');
      tabEl.className = 'tab';
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
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabManager;
}
