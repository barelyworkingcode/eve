class ProjectPanel {
  static TAB_STORAGE_KEY = 'eve-active-tab';
  static TABS = ['files', 'changes'];

  constructor(container, fileTreeNode) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ProjectPanel');
    this.state = container.get('state');
    this.fileTreeNode = fileTreeNode;
    this.changesPanel = new ChangesPanel(container);
    this.changesPanel.onUpdate = (opts) => this._onChangesUpdate(opts);

    this.projectId = null;
    this.activeTab = this._restoreTab();

    this.titleEl = null;
    this.headerActionsEl = null;
    this.tabsEl = null;
    this.contentEl = null;
    this.actionsEl = null;

    this._subscribed = false;
  }

  init() {
    this.titleEl = document.getElementById('panelTitle');
    this.headerActionsEl = document.getElementById('panelHeaderActions');
    this.tabsEl = document.getElementById('panelTabs');
    this.contentEl = document.getElementById('panelContent');
    this.actionsEl = document.getElementById('panelActions');
    this._subscribeEvents();
  }

  setProject(projectId) {
    this.projectId = projectId;
    // Fetch on selection, not just tab activation, so the badge is populated.
    this.changesPanel.setProject(projectId);
    this.render();
  }

  // Show `key` as the panel's tab.
  openTab(key) {
    if (!ProjectPanel.TABS.includes(key)) return;
    this.activeTab = key;
    this._saveTab();
    this.render();
  }

  render() {
    if (!this.contentEl) return;

    const project = this.projectId ? this.state.getProject(this.projectId) : null;
    if (!project) {
      this.titleEl.textContent = '';
      this.headerActionsEl.innerHTML = '';
      this.tabsEl.innerHTML = '';
      this.actionsEl.innerHTML = '';
      this.contentEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'project-tree__empty';
      empty.textContent = 'No projects. Click + to add one.';
      this.contentEl.appendChild(empty);
      return;
    }

    this.titleEl.textContent = project.name;
    this.titleEl.title = project.name;
    this._renderHostBar(project);
    this._renderHeaderActions();
    this._renderTabs();
    this._renderContent();
    this._renderActionBar();
  }

  _tabs() {
    return [
      { key: 'files', label: 'Files', icon: PANEL_ICONS.files, count: null },
      { key: 'changes', label: 'Changes', icon: PANEL_ICONS.changes, count: this.changesPanel.count() },
    ];
  }

  _renderTabs() {
    this.tabsEl.innerHTML = '';
    for (const tab of this._tabs()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `panel-tab${tab.key === this.activeTab ? ' panel-tab--active' : ''}`;
      btn.title = tab.label;
      btn.dataset.tab = tab.key;
      btn.dataset.testid = `panel-tab-${tab.key}`;

      const icon = document.createElement('span');
      icon.className = 'panel-tab__icon';
      icon.innerHTML = tab.icon;
      btn.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'panel-tab__label';
      label.textContent = tab.label;
      btn.appendChild(label);

      if (tab.count !== null && tab.count > 0) {
        const count = document.createElement('span');
        count.className = 'panel-tab__count';
        count.textContent = tab.count;
        btn.appendChild(count);
      }

      btn.addEventListener('click', () => {
        if (this.activeTab === tab.key) return;
        this.activeTab = tab.key;
        this._saveTab();
        this._renderHeaderActions();
        this._renderTabs();
        this._renderContent();
        if (tab.key === 'changes') this.changesPanel.setProject(this.projectId);
      });

      this.tabsEl.appendChild(btn);
    }
  }

  _renderHeaderActions() {
    this.headerActionsEl.innerHTML = '';
    if (this.activeTab === 'files') {
      this.headerActionsEl.appendChild(this._iconBtn('New Folder', UI_ICONS.newFolder(16),
        () => this.fileTreeNode.promptNewFolderAtRoot(this.projectId)));
      this.headerActionsEl.appendChild(this._iconBtn('Refresh', UI_ICONS.refresh(16),
        () => this.fileTreeNode.refreshRoot(this.projectId)));
    }
    if (this.activeTab === 'changes') {
      this.headerActionsEl.appendChild(this._iconBtn('Refresh', UI_ICONS.refresh(16),
        () => this.changesPanel.refresh(), 'changes-refresh'));
    }
    this.headerActionsEl.appendChild(this._iconBtn('Project page', PANEL_ICONS.page,
      () => {
        this.container.get('projectPage').open(this.projectId);
        this._closeSidebarOnMobile();
      }, 'panel-project-page'));
    this.headerActionsEl.appendChild(this._iconBtn('Search', UI_ICONS.search(16),
      () => this.bus.emit(EVT.DIALOG_SEARCH, { projectId: this.projectId }),
      `sidebar-project-search-${this.projectId}`));
    this.headerActionsEl.appendChild(this._iconBtn('More', UI_ICONS.more(16),
      (e) => this._showProjectMenu(e.clientX, e.clientY),
      `sidebar-project-more-${this.projectId}`));
  }

  _renderActionBar() {
    this.actionsEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-action-btn panel-action-btn--primary';
    btn.dataset.testid = `sidebar-new-session-${this.projectId}`;
    btn.innerHTML = `${PANEL_ICONS.plus}<span>New Session</span>`;
    btn.addEventListener('click', () => {
      this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: this.projectId });
    });
    this.actionsEl.appendChild(btn);
  }

  _renderContent() {
    this.contentEl.innerHTML = '';
    switch (this.activeTab) {
      case 'changes': return this.changesPanel.render(this.contentEl);
      case 'files':
      default: return this._renderFilesContent(this.contentEl);
    }
  }

  // ChangesPanel data arrived (or scope/collapse changed): the badge always
  // follows; the list re-renders only when visible, keeping scroll and focus.
  _onChangesUpdate({ focusTestId } = {}) {
    if (!this.projectId || !this.state.getProject(this.projectId)) return;
    this._renderTabs();
    if (this.container.has('projectPage')) this.container.get('projectPage').refreshChanges();
    if (this.activeTab !== 'changes') return;
    const scrollTop = this.contentEl.scrollTop;
    const active = document.activeElement;
    const refocus = focusTestId
      || (active && this.contentEl.contains(active) ? active.dataset.testid : null);
    this._renderContent();
    this.contentEl.scrollTop = scrollTop;
    if (refocus) {
      const el = [...this.contentEl.querySelectorAll('[data-testid]')]
        .find(n => n.dataset.testid === refocus);
      if (el) el.focus({ preventScroll: true });
    }
  }

  _renderFilesContent(container) {
    const treeContainer = document.createElement('div');
    treeContainer.className = 'file-tree';
    treeContainer.dataset.projectId = this.projectId;
    this.fileTreeNode.renderTree(this.projectId, treeContainer);
    container.appendChild(treeContainer);
  }

  _iconBtn(title, iconHtml, onClick, testid) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-header__btn';
    btn.title = title;
    btn.innerHTML = iconHtml;
    if (testid) btn.dataset.testid = testid;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return btn;
  }

  _showProjectMenu(x, y) {
    showContextMenu(x, y, [
      { label: 'Edit Project', action: () => this.bus.emit(EVT.DIALOG_PROJECT, { projectId: this.projectId }) },
      { label: 'Delete Project', danger: true, action: () => {
        this.bus.emit(EVT.DIALOG_CONFIRM, {
          message: `Delete project "${this.state.getProject(this.projectId)?.name}"? This cannot be undone.`,
          onConfirm: () => this.bus.emit(EVT.PROJECT_DELETED, { projectId: this.projectId }),
        });
      }},
    ]);
  }

  _closeSidebarOnMobile() {
    const app = this.container.has('app') ? this.container.get('app') : null;
    if (app?.closeSidebarOnMobile) app.closeSidebarOnMobile();
  }

  _restoreTab() {
    const t = localStorage.getItem(ProjectPanel.TAB_STORAGE_KEY);
    // A stored sessions or tasks tab (removed in S5a) opens Files.
    return ProjectPanel.TABS.includes(t) ? t : 'files';
  }

  _saveTab() {
    localStorage.setItem(ProjectPanel.TAB_STORAGE_KEY, this.activeTab);
  }

  _subscribeEvents() {
    if (this._subscribed) return;
    this._subscribed = true;

    if (EVT.HOST_STATUS) {
      this.bus.on(EVT.HOST_STATUS, ({ hostId }) => {
        const project = this.state.getProject(this.projectId);
        // hostId null = bulk host refresh; it may cover this project too.
        if (project?.host && (hostId === null || project.host.id === hostId)) {
          this._renderHostBar(project);
          this.changesPanel.onHostStatus();
          if (this.activeTab === 'changes') this._renderContent();
        }
      });
    }
  }

  // The header is one short line, so the host gets its own strip beneath
  // it: dot, host name, and the status word. Console projects hide it; the
  // strip's absence is the "this Mac" signal.
  _renderHostBar(project) {
    const bar = document.getElementById('panelHostBar');
    if (!bar) return;
    if (!project?.host) {
      bar.hidden = true;
      bar.innerHTML = '';
      bar.className = 'panel-host-bar';
      return;
    }
    const status = this.state.hostStatus?.(project.host.id) || project.host.status || 'unknown';
    bar.hidden = false;
    bar.className = `panel-host-bar panel-host-bar--${status}`;
    bar.innerHTML = '';
    bar.dataset.testid = `panel-host-bar-${project.host.id}`;
    const dot = document.createElement('span');
    dot.className = 'host-chip__dot';
    bar.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'panel-host-bar__name';
    name.textContent = project.host.name;
    bar.appendChild(name);
    const word = document.createElement('span');
    word.className = 'panel-host-bar__status';
    word.textContent = {
      connected: 'connected', connecting: 'connecting…', unreachable: 'unreachable', idle: 'idle', unknown: '',
    }[status] ?? status;
    bar.appendChild(word);
    if (typeof hostStatusLabel === 'function') bar.title = hostStatusLabel(project.host, status);
  }
}

const PANEL_ICONS = {
  files: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z"/><path d="M9 1.5V5h3.5"/></svg>',
  page: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h3.5"/></svg>',
  changes: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="4.5" r="1.5"/><path d="M5 5v6"/><path d="M11 6c0 3-6 2.5-6 5"/></svg>',
  branchSmall: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="4.5" r="1.5"/><path d="M5 5v6"/><path d="M11 6c0 3-6 2.5-6 5"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
};
