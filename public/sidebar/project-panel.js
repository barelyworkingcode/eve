class ProjectPanel {
  static TAB_STORAGE_KEY = 'eve-active-tab';
  static FOLDERS_COLLAPSED_KEY = 'eve-session-folders-collapsed';

  constructor(container, fileTreeNode) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ProjectPanel');
    this.state = container.get('state');
    this.fileTreeNode = fileTreeNode;

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

  _refresh() {
    if (!this.projectId || !this.state.getProject(this.projectId)) return;
    this._renderHeaderActions();
    this._renderTabs();
    this._renderContent();
  }

  _tabs() {
    return [
      { key: 'files', label: 'Files', icon: PANEL_ICONS.files, count: null },
      { key: 'sessions', label: 'Sessions', icon: PANEL_ICONS.sessions, count: this._sectionCount('sessions') },
      { key: 'tasks', label: 'Tasks', icon: PANEL_ICONS.tasks, count: this._sectionCount('tasks') },
      { key: 'modules', label: 'Modules', icon: PANEL_ICONS.modules, count: this._sectionCount('modules') },
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
      });

      this.tabsEl.appendChild(btn);
    }
  }

  _sectionCount(key) {
    if (key === 'tasks') {
      return this.state.getTasksForProject(this.projectId).length;
    }
    if (key === 'sessions') {
      const sessionCount = this.state.getSessionsForProject(this.projectId)
        .filter(s => !this.state.isTaskRun(s.id)).length;
      const termMgr = this.container?.has('terminalManager') ? this.container.get('terminalManager') : null;
      const project = this.state.getProject(this.projectId);
      const terminalCount = (termMgr?.getTerminalsForPath(project?.path, project?.hostId || '') || [])
        .filter(t => !this.state.isTaskRun(t.id)).length;
      return sessionCount + terminalCount;
    }
    if (key === 'modules') {
      return this.state.getModulesForProject(this.projectId).length;
    }
    return null;
  }

  _renderHeaderActions() {
    this.headerActionsEl.innerHTML = '';
    if (this.activeTab === 'files') {
      this.headerActionsEl.appendChild(this._iconBtn('New Folder', UI_ICONS.newFolder(16),
        () => this.fileTreeNode.promptNewFolderAtRoot(this.projectId)));
      this.headerActionsEl.appendChild(this._iconBtn('Refresh', UI_ICONS.refresh(16),
        () => this.fileTreeNode.refreshRoot(this.projectId)));
    }
    if (this.activeTab === 'sessions') {
      this.headerActionsEl.appendChild(this._iconBtn('New Folder', UI_ICONS.newFolder(16),
        () => this.container.get('app').createSessionFolder(this.projectId),
        `sidebar-new-session-folder-${this.projectId}`));
    }
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
      case 'sessions': return this._renderSessionsContent(this.contentEl);
      case 'tasks': return this._renderTasksContent(this.contentEl);
      case 'modules': return this._renderModulesContent(this.contentEl);
      case 'files':
      default: return this._renderFilesContent(this.contentEl);
    }
  }

  _renderFilesContent(container) {
    const treeContainer = document.createElement('div');
    treeContainer.className = 'file-tree';
    treeContainer.dataset.projectId = this.projectId;
    this.fileTreeNode.renderTree(this.projectId, treeContainer);
    container.appendChild(treeContainer);
  }

  _renderTasksContent(container) {
    const tasks = this.state.getTasksForProject(this.projectId);
    const taskViewer = this.container.get('taskViewer');

    for (const task of tasks) {
      const hasLastRun = taskViewer.hasLastRun(task);

      const item = document.createElement('div');
      item.className = 'project-tree__task-item';
      item.dataset.testid = `sidebar-task-${task.id}`;
      if (hasLastRun) item.style.cursor = 'pointer';

      const nameEl = document.createElement('span');
      nameEl.className = 'project-tree__task-name';
      nameEl.textContent = task.name;
      item.appendChild(nameEl);

      const schedEl = document.createElement('span');
      schedEl.className = 'project-tree__task-schedule';
      schedEl.textContent = this._formatSchedule(task.schedule);
      item.appendChild(schedEl);

      const actions = document.createElement('span');
      actions.className = 'project-tree__task-actions';

      const runBtn = document.createElement('button');
      runBtn.className = 'project-tree__task-btn';
      runBtn.title = 'Run Now';
      runBtn.innerHTML = UI_ICONS.shell(12);
      runBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._runTask(task);
        this._closeSidebarOnMobile();
      });
      actions.appendChild(runBtn);

      const editBtn = document.createElement('button');
      editBtn.className = 'project-tree__task-btn';
      editBtn.title = 'Edit';
      editBtn.innerHTML = UI_ICONS.more(12);
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId, editTaskId: task.id });
      });
      actions.appendChild(editBtn);

      item.addEventListener('click', () => {
        if (!hasLastRun) return;
        taskViewer.openLastRun(task);
        this._closeSidebarOnMobile();
      });

      item.appendChild(actions);
      container.appendChild(item);
    }

    const newItem = document.createElement('div');
    newItem.className = 'project-tree__task-item project-tree__task-item--new';
    newItem.dataset.testid = `sidebar-task-new-${this.projectId}`;
    const label = document.createElement('span');
    label.className = 'project-tree__task-name';
    label.textContent = '+ New Task';
    newItem.appendChild(label);
    newItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId });
      this._closeSidebarOnMobile();
    });
    container.appendChild(newItem);
  }

  async _runTask(task) {
    try {
      const taskManager = this.container.has('taskManager') ? this.container.get('taskManager') : null;
      if (taskManager) taskManager.userTriggeredRuns.add(task.id);
      await this.container.get('api').runTask(task.id);
    } catch (err) {
      this.log.error('Failed to run task:', err);
    }
  }

  _formatSchedule(schedule) {
    if (!schedule) return '';
    switch (schedule.type) {
      case 'daily': return `Daily ${schedule.time || '09:00'}`;
      case 'hourly': return `Hourly :${schedule.minute || '00'}`;
      case 'weekly': return `${schedule.day || 'mon'} ${schedule.time || '09:00'}`;
      case 'cron': return schedule.expression || 'cron';
      case 'interval': return `Every ${schedule.minutes || 60}m`;
      case 'once': return 'Once';
      case 'on_demand': return 'On demand';
      default: return schedule.type || '';
    }
  }

  _renderSessionsContent(container) {
    const project = this.state.getProject(this.projectId);
    const sessions = this.state.getSessionsForProject(this.projectId)
      .filter(s => !this.state.isTaskRun(s.id));
    const termMgr = this.container?.has('terminalManager') ? this.container.get('terminalManager') : null;
    const terminals = (termMgr?.getTerminalsForPath(project?.path, project?.hostId || '') || [])
      .filter(t => !this.state.isTaskRun(t.id));

    if (sessions.length === 0 && terminals.length === 0) {
      this._renderEmpty(container, 'No sessions yet. Start one below.');
      return;
    }

    for (const terminal of terminals) {
      this._renderTerminalItem(container, terminal);
    }

    // Union, not just declared folders: a half-applied folder rename can't
    // hide a session, and a pre-folders session (folder "") always lands in
    // Ungrouped.
    const declared = project?.sessionFolders || [];
    const folderNames = [...declared];
    for (const s of sessions) {
      const f = (s.folder || '').trim();
      if (f && !folderNames.includes(f)) folderNames.push(f);
    }

    const byFolder = new Map();
    const ungrouped = [];
    for (const s of sessions) {
      const f = (s.folder || '').trim();
      if (f && folderNames.includes(f)) {
        if (!byFolder.has(f)) byFolder.set(f, []);
        byFolder.get(f).push(s);
      } else {
        ungrouped.push(s);
      }
    }

    // No folders anywhere → flat list, matching the pre-folders UI so
    // existing projects render unchanged.
    if (folderNames.length === 0) {
      for (const s of ungrouped) this._renderSessionRow(container, s, project);
      return;
    }

    for (const name of folderNames) {
      this._renderFolderGroup(container, project, name, byFolder.get(name) || []);
    }
    if (ungrouped.length > 0) {
      this._renderFolderGroup(container, project, '', ungrouped);
    }
  }

  _renderFolderGroup(container, project, name, sessions) {
    const isUngrouped = name === '';
    const collapseKey = `${this.projectId}/${name}`;
    const collapsed = this._collapsedFolders().has(collapseKey);

    const header = document.createElement('div');
    header.className = `project-tree__folder-header${collapsed ? ' project-tree__folder-header--collapsed' : ''}`;
    header.dataset.testid = `sidebar-folder-${this.projectId}-${isUngrouped ? '__ungrouped__' : name}`;

    const caret = document.createElement('span');
    caret.className = 'project-tree__folder-caret';
    caret.innerHTML = UI_ICONS.caret(12);
    header.appendChild(caret);

    const nameEl = document.createElement('span');
    nameEl.className = 'project-tree__folder-name';
    nameEl.textContent = isUngrouped ? 'Ungrouped' : name;
    header.appendChild(nameEl);

    const count = document.createElement('span');
    count.className = 'project-tree__folder-count';
    count.textContent = String(sessions.length);
    header.appendChild(count);

    if (!isUngrouped) {
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'project-tree__folder-menu-btn';
      menuBtn.title = 'Folder actions';
      menuBtn.innerHTML = UI_ICONS.more(14);
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showFolderMenu(e.clientX, e.clientY, name);
      });
      header.appendChild(menuBtn);
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._showFolderMenu(e.clientX, e.clientY, name);
      });
    }

    header.addEventListener('click', () => this._toggleFolderCollapsed(collapseKey));
    container.appendChild(header);

    if (collapsed) return;
    for (const s of sessions) this._renderSessionRow(container, s, project);
  }

  _renderSessionRow(container, session, project) {
    const wrapper = document.createElement('div');
    wrapper.className = 'project-tree__session-swipe';

    const deleteAction = document.createElement('div');
    deleteAction.className = 'project-tree__session-delete';
    deleteAction.textContent = 'Delete';
    deleteAction.addEventListener('click', (e) => {
      e.stopPropagation();
      this.container.get('app').deleteSession(session.id);
    });

    const item = document.createElement('div');
    const isActive = session.id === this.state.currentSessionId;
    item.className = `project-tree__session-item${isActive ? ' project-tree__session-item--active' : ''}`;
    item.dataset.testid = `sidebar-session-${session.id}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'project-tree__session-name';
    const displayName = sessionDisplayName(session, project) || session.id;
    nameEl.textContent = displayName;
    nameEl.title = displayName;
    item.appendChild(nameEl);

    if (session.active) {
      const live = document.createElement('span');
      live.className = 'project-tree__live';
      live.title = 'Running';
      item.appendChild(live);
    }

    const openedAt = this._sessionOpenedAt(session);
    if (openedAt) {
      const time = document.createElement('span');
      time.className = 'project-tree__session-time';
      time.textContent = relativeTime(openedAt);
      time.title = new Date(openedAt).toLocaleString();
      item.appendChild(time);
    }

    if (session.model) {
      const badge = document.createElement('span');
      badge.className = 'project-tree__session-badge';
      const modelParts = session.model.split('/');
      badge.textContent = modelParts[modelParts.length - 1];
      item.appendChild(badge);
    }

    const swipeState = { swiped: false, menuOpened: false };

    item.addEventListener('click', (e) => {
      // Also keeps a long-press's synthesized click from reaching the
      // just-opened context menu's outside-click closer.
      e.stopPropagation();
      if (swipeState.swiped || swipeState.menuOpened ||
          wrapper.classList.contains('project-tree__session-swipe--open')) return;
      this.container.get('app').joinSession(session.id);
      this._closeSidebarOnMobile();
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showSessionMenu(e.clientX, e.clientY, session);
    });

    this._attachSwipe(wrapper, item, swipeState);
    this._attachLongPress(item, swipeState, (x, y) => this._showSessionMenu(x, y, session));

    wrapper.appendChild(deleteAction);
    wrapper.appendChild(item);
    container.appendChild(wrapper);
  }

  // Local "last opened" wins (it's what you did); otherwise the server's
  // last-message / created time, when the list carries them.
  _sessionOpenedAt(session) {
    const local = (typeof SessionRecents !== 'undefined') ? SessionRecents.get(session.id)?.lastOpenedAt : null;
    if (local) return local;
    const server = Date.parse(session.lastMessageAt || session.createdAt || '');
    return Number.isNaN(server) ? null : server;
  }

  _showSessionMenu(x, y, session) {
    const app = this.container.get('app');
    showContextMenu(x, y, [
      { label: 'Rename', action: () => app.renameSession(session.id) },
      { label: 'Move to folder…', action: () => this._showMoveToFolderMenu(x, y, session) },
      { separator: true },
      { label: 'Delete', danger: true, action: () => app.deleteSession(session.id) },
    ]);
  }

  _showMoveToFolderMenu(x, y, session) {
    const app = this.container.get('app');
    const current = session.folder || '';
    const folders = app._projectFolders(this.projectId);
    const items = [
      { label: `${current === '' ? '✓ ' : ''}Ungrouped`, action: () => app.setSessionFolder(session.id, '') },
    ];
    for (const f of folders) {
      items.push({ label: `${current === f ? '✓ ' : ''}${f}`, action: () => app.setSessionFolder(session.id, f) });
    }
    items.push({ separator: true });
    items.push({ label: 'New folder…', action: () => app.moveSessionToNewFolder(session.id) });
    showContextMenu(x, y, items);
  }

  _showFolderMenu(x, y, name) {
    const app = this.container.get('app');
    showContextMenu(x, y, [
      { label: 'Rename Folder', action: () => app.renameSessionFolder(this.projectId, name) },
      { label: 'Delete Folder', danger: true, action: () => app.deleteSessionFolder(this.projectId, name) },
    ]);
  }

  _collapsedFolders() {
    try {
      const raw = localStorage.getItem(ProjectPanel.FOLDERS_COLLAPSED_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) {
      return new Set();
    }
  }

  _toggleFolderCollapsed(key) {
    const set = this._collapsedFolders();
    if (set.has(key)) set.delete(key); else set.add(key);
    try {
      localStorage.setItem(ProjectPanel.FOLDERS_COLLAPSED_KEY, JSON.stringify([...set]));
    } catch (_) { /* storage full / disabled — collapse just won't persist */ }
    this._renderContent();
  }

  _attachLongPress(item, swipeState, openMenu) {
    const DURATION = 500;
    let timer = null;
    let startX = 0;
    let startY = 0;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

    item.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      swipeState.menuOpened = false;
      clear();
      timer = setTimeout(() => {
        timer = null;
        swipeState.menuOpened = true;
        openMenu(startX, startY);
      }, DURATION);
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) clear();
    }, { passive: true });

    item.addEventListener('touchend', clear, { passive: true });
    item.addEventListener('touchcancel', clear, { passive: true });
  }

  _renderTerminalItem(container, terminal) {
    const item = document.createElement('div');
    item.className = 'project-tree__session-item';
    item.dataset.testid = `sidebar-terminal-${terminal.id}`;

    const iconEl = document.createElement('span');
    iconEl.className = 'project-tree__terminal-icon';
    iconEl.innerHTML = UI_ICONS.shell(12);
    item.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'project-tree__session-name';
    const project = this.state.getProject(this.projectId);
    let displayName = terminal.name || terminal.templateId || 'Terminal';
    if (project && displayName.startsWith(project.name + ' - ')) {
      displayName = displayName.slice(project.name.length + 3);
    }
    nameEl.textContent = displayName;
    item.appendChild(nameEl);

    const isRunning = terminal.state !== 'stopped';
    const badge = document.createElement('span');
    badge.className = `project-tree__session-badge${isRunning ? ' project-tree__session-badge--running' : ''}`;
    badge.textContent = isRunning ? 'running' : 'stopped';
    item.appendChild(badge);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabMgr = this.container.has('tabManager') ? this.container.get('tabManager') : null;
      if (tabMgr) tabMgr.switchToTab(terminal.id);
      this._closeSidebarOnMobile();
    });

    container.appendChild(item);
  }

  _renderModulesContent(container) {
    const store = this.container.has('moduleStore') ? this.container.get('moduleStore') : null;
    if (store && !this.state.modules.has(this.projectId)) {
      store.loadModulesForProject(this.projectId);
    }

    const modules = this.state.getModulesForProject(this.projectId);
    if (modules.length === 0 && this.state.modules.has(this.projectId)) {
      this._renderEmpty(container, 'No modules. Click + to ask Claude to build one.');
    } else if (modules.length === 0) {
      this._renderLoading(container);
    } else {
      for (const m of modules) {
        this._renderModuleItem(container, m);
      }
    }

    const newItem = document.createElement('div');
    newItem.className = 'project-tree__module-item project-tree__module-item--new';
    newItem.dataset.testid = `sidebar-module-new-${this.projectId}`;
    const label = document.createElement('span');
    label.className = 'project-tree__module-name';
    label.textContent = '+ New Module';
    newItem.appendChild(label);
    newItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.MODULE_CREATE_REQUEST, { projectId: this.projectId });
      this._closeSidebarOnMobile();
    });
    container.appendChild(newItem);
  }

  _renderModuleItem(container, m) {
    const item = document.createElement('div');
    item.className = 'project-tree__module-item';
    if (m.broken) item.classList.add('project-tree__module-item--broken');
    item.dataset.testid = `sidebar-module-${m.name}`;

    const iconEl = document.createElement('span');
    iconEl.className = 'project-tree__module-icon';
    iconEl.innerHTML = UI_ICONS.module(12);
    item.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'project-tree__module-name';
    nameEl.textContent = m.displayName || m.name;
    if (m.broken) nameEl.title = m.error || 'Module failed to load';
    item.appendChild(nameEl);

    if (!m.broken) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.bus.emit(EVT.MODULE_LAUNCH_REQUEST, {
          projectId: this.projectId,
          moduleName: m.name,
          displayName: m.displayName || m.name,
        });
        this._closeSidebarOnMobile();
      });
    }

    container.appendChild(item);
  }

  _renderLoading(container) {
    const el = document.createElement('div');
    el.className = 'project-tree__section-empty';
    el.textContent = 'Loading...';
    container.appendChild(el);
  }

  _renderEmpty(container, message) {
    const el = document.createElement('div');
    el.className = 'project-tree__section-empty';
    el.textContent = message;
    container.appendChild(el);
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
      { label: 'Regenerate Skills', action: () => this._regenerateSkills() },
      { label: 'Delete Project', danger: true, action: () => {
        this.bus.emit(EVT.DIALOG_CONFIRM, {
          message: `Delete project "${this.state.getProject(this.projectId)?.name}"? This cannot be undone.`,
          onConfirm: () => this.bus.emit(EVT.PROJECT_DELETED, { projectId: this.projectId }),
        });
      }},
    ]);
  }

  // Relay owns skill generation. Distinct progress/done toast ids avoid
  // colliding with the still-dismissing progress toast.
  async _regenerateSkills() {
    const id = this.projectId;
    if (!id) return;
    const progressId = `regen-skills-${id}`;
    const doneId = `regen-skills-done-${id}`;
    this.bus.emit(EVT.TOAST_SHOW, { id: progressId, message: 'Regenerating skills…', type: 'info', persistent: true });
    try {
      await this.container.get('api').regenerateSkills(id);
      this.bus.emit(EVT.TOAST_DISMISS, { id: progressId });
      this.bus.emit(EVT.TOAST_SHOW, { id: doneId, message: 'Skills regenerated', type: 'success' });
    } catch (err) {
      this.log.error('regenerate skills failed', err);
      this.bus.emit(EVT.TOAST_DISMISS, { id: progressId });
      this.bus.emit(EVT.TOAST_SHOW, { id: doneId, message: `Couldn't regenerate skills: ${err.message}`, type: 'error', duration: 7000 });
    }
  }

  _closeSidebarOnMobile() {
    const app = this.container.has('app') ? this.container.get('app') : null;
    if (app?.closeSidebarOnMobile) app.closeSidebarOnMobile();
  }

  _attachSwipe(wrapper, item, swipeState) {
    const DELETE_WIDTH = 64;
    const THRESHOLD = 20;
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let swiping = false;
    let locked = false;

    item.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      currentX = 0;
      swiping = false;
      locked = false;
      swipeState.swiped = false;
      item.style.transition = 'none';
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!locked && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        if (Math.abs(dy) > Math.abs(dx)) {
          swiping = false;
          return;
        }
        locked = true;
        swiping = true;
        window._sidebarSwipeLocked = true;
      }

      if (!swiping) return;
      e.preventDefault();

      currentX = Math.max(-DELETE_WIDTH * 1.2, Math.min(0, dx));
      item.style.transform = `translateX(${currentX}px)`;
    }, { passive: false });

    item.addEventListener('touchend', () => {
      if (!swiping) {
        window._sidebarSwipeLocked = false;
        return;
      }
      swipeState.swiped = true;
      item.style.transition = 'transform 0.2s ease';
      if (currentX < -DELETE_WIDTH / 2) {
        item.style.transform = `translateX(${-DELETE_WIDTH}px)`;
        wrapper.classList.add('project-tree__session-swipe--open');
      } else {
        item.style.transform = '';
        wrapper.classList.remove('project-tree__session-swipe--open');
      }
      setTimeout(() => { window._sidebarSwipeLocked = false; }, 300);
    }, { passive: true });

    item.addEventListener('touchstart', () => {
      const parent = wrapper.parentElement;
      if (!parent) return;
      for (const el of parent.querySelectorAll('.project-tree__session-swipe--open')) {
        if (el !== wrapper) {
          el.classList.remove('project-tree__session-swipe--open');
          const inner = el.querySelector('.project-tree__session-item');
          if (inner) {
            inner.style.transition = 'transform 0.2s ease';
            inner.style.transform = '';
          }
        }
      }
    }, { passive: true });
  }

  _restoreTab() {
    const t = localStorage.getItem(ProjectPanel.TAB_STORAGE_KEY);
    return ['files', 'sessions', 'tasks', 'modules'].includes(t) ? t : 'files';
  }

  _saveTab() {
    localStorage.setItem(ProjectPanel.TAB_STORAGE_KEY, this.activeTab);
  }

  _subscribeEvents() {
    if (this._subscribed) return;
    this._subscribed = true;

    const refresh = () => this._refresh();
    this.bus.on(EVT.TASKS_LOADED, refresh);
    this.bus.on(EVT.TASK_UPDATED, refresh);
    this.bus.on(EVT.SESSION_UPDATED, refresh);
    this.bus.on(EVT.SESSION_REMOVED, refresh);
    this.bus.on(EVT.TERMINAL_LIST, refresh);
    this.bus.on(EVT.MODULE_LIST_UPDATED, ({ projectId }) => {
      if (projectId === this.projectId) this._refresh();
    });
    if (EVT.HOST_STATUS) {
      this.bus.on(EVT.HOST_STATUS, ({ hostId }) => {
        const project = this.state.getProject(this.projectId);
        if (project?.host?.id === hostId) this._renderHostBar(project);
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
  sessions: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5h12v7H9l-3 2.5V11.5H2z"/></svg>',
  tasks: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>',
  modules: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
};
