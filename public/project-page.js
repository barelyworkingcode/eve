// Project page (docs/design-workbench.md, S5a-A1/A2): one main-area tab per
// project with its threads and tasks. The thread list (folders, rename, move,
// delete, swipe, long-press) and the task list moved here from ProjectPanel
// unchanged. The Agents section is an empty mount point for the agent board.
// Collaborators are reached through the container at call time: this is
// constructed by features.boot(), before most of them exist.
class ProjectPage {
  static FOLDERS_COLLAPSED_KEY = 'eve-session-folders-collapsed';

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ProjectPage');
    this.state = container.get('state');
    this.projectId = null;
    this._builtFor = null;
    this._subscribed = false;
    this._subscribeEvents();
  }

  get el() { return document.getElementById('projectPane'); }

  // Open or focus the project's tab.
  open(projectId) {
    this.container.get('tabManager').openPane('project', { projectId });
  }

  show(projectId) {
    this.projectId = projectId;
    this.render();
  }

  _visible() {
    const el = this.el;
    return !!(el && this.projectId && !el.classList.contains('hidden'));
  }

  render() {
    const root = this.el;
    if (!root || !this.projectId) return;
    const project = this.state.getProject(this.projectId);
    if (!project) {
      this._builtFor = null;
      root.textContent = '';
      const gone = document.createElement('div');
      gone.className = 'project-page__empty';
      gone.dataset.testid = `project-page-${this.projectId}`;
      gone.textContent = 'Project not found.';
      root.appendChild(gone);
      return;
    }
    // The skeleton is built once per project so the Agents mount survives the
    // re-renders that session and task events cause.
    if (this._builtFor !== this.projectId) this._build(root);
    this._renderHeader(project);
    this._renderRows();
    this._renderThreads(project);
    this._renderTasks();
  }

  _build(root) {
    const id = this.projectId;
    root.textContent = '';
    const page = this._div('project-page', `project-page-${id}`);

    const header = this._div('project-page__header');
    this._header = header;
    page.appendChild(header);

    this._rows = this._div('project-page__rows');
    page.appendChild(this._rows);

    const agents = this._section('Agents', 'agents');
    this._agentsMount = this._div('project-page__agents', `project-agents-${id}`);
    agents.section.appendChild(this._agentsMount);
    page.appendChild(agents.section);

    const threads = this._section('Threads', 'threads', 'project-threads-count');
    this._threadsCount = threads.count;
    const newFolder = this._textBtn('New folder', () => this.container.get('app').createSessionFolder(id),
      `project-new-folder-${id}`);
    threads.head.appendChild(newFolder);
    this._threadsList = this._div('project-page__list');
    threads.section.appendChild(this._threadsList);
    page.appendChild(threads.section);

    const tasks = this._section('Tasks', 'tasks', 'project-tasks-count');
    this._tasksCount = tasks.count;
    this._tasksList = this._div('project-page__list');
    tasks.section.appendChild(this._tasksList);
    page.appendChild(tasks.section);

    root.appendChild(page);
    this._builtFor = id;
  }

  _div(cls, testid) {
    const el = document.createElement('div');
    el.className = cls;
    if (testid) el.dataset.testid = testid;
    return el;
  }

  _section(title, key, countTestid) {
    const section = document.createElement('section');
    section.className = 'project-page__section';
    section.dataset.section = key;
    const head = this._div('project-page__section-head');
    const h = document.createElement('h2');
    h.className = 'project-page__section-title';
    h.textContent = title;
    head.appendChild(h);
    const count = document.createElement('span');
    count.className = 'project-page__count';
    if (countTestid) count.dataset.testid = countTestid;
    head.appendChild(count);
    section.appendChild(head);
    return { section, head, count };
  }

  _textBtn(label, onClick, testid, primary = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `project-page__btn${primary ? ' project-page__btn--primary' : ''}`;
    btn.textContent = label;
    if (testid) btn.dataset.testid = testid;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return btn;
  }

  _renderHeader(project) {
    const h = this._header;
    h.textContent = '';
    const name = document.createElement('h1');
    name.className = 'project-page__name';
    name.textContent = project.name;
    h.appendChild(name);

    const where = this._div('project-page__where');
    if (project.host) {
      const status = this.state.hostStatus?.(project.host.id) || project.host.status || 'unknown';
      const chip = hostChip(project.host, { status });
      if (chip) where.appendChild(chip);
    } else {
      const mac = document.createElement('span');
      mac.className = 'project-page__local';
      mac.textContent = 'this Mac';
      where.appendChild(mac);
    }
    const path = document.createElement('span');
    path.className = 'project-page__path';
    path.textContent = project.path || '';
    path.title = project.path || '';
    where.appendChild(path);
    h.appendChild(where);

    h.appendChild(this._textBtn('New thread',
      () => this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: this.projectId }),
      `project-new-thread-${this.projectId}`, true));
  }

  // Files and Changes live in the sidebar panel; these rows open it on that tab.
  _renderRows() {
    const id = this.projectId;
    const rows = this._rows;
    rows.textContent = '';
    const changes = this._changesCount();
    for (const [key, label, count] of [['files', 'Files', null], ['changes', 'Changes', changes]]) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'project-page__row';
      row.dataset.testid = `project-${key}-${id}`;
      const text = document.createElement('span');
      text.textContent = label;
      row.appendChild(text);
      if (count !== null && count > 0) {
        const n = document.createElement('span');
        n.className = 'project-page__count';
        n.textContent = String(count);
        row.appendChild(n);
      }
      row.addEventListener('click', () => this._openPanel(key));
      rows.appendChild(row);
    }
  }

  // The sidebar's Changes data belongs to its active project; a project tab
  // activates its project, so they agree while this page is the shown tab.
  _changesCount() {
    const panel = this.container.get('app')?.projectTree?.panel;
    if (!panel || panel.projectId !== this.projectId) return null;
    return panel.changesPanel.count();
  }

  // ProjectPanel calls this when Changes data arrives.
  refreshChanges() {
    if (this._visible() && this._rows) this._renderRows();
  }

  _openPanel(key) {
    const app = this.container.get('app');
    app.projectTree.setActive(this.projectId);
    app.projectTree.panel.openTab(key);
    app.toggleSidebar(true);
  }

  // ---- Threads ----------------------------------------------------------

  _renderThreads(project) {
    const container = this._threadsList;
    container.textContent = '';
    const sessions = this.state.getSessionsForProject(this.projectId)
      .filter(s => !this.state.isTaskRun(s.id));
    this._threadsCount.textContent = String(sessions.length);

    if (sessions.length === 0) {
      this._renderEmpty(container, 'No threads yet.');
      return;
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

    // No folders anywhere: flat list, matching the pre-folders UI.
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
    header.dataset.testid = `project-folder-${this.projectId}-${isUngrouped ? '__ungrouped__' : name}`;

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
    item.dataset.testid = `project-thread-${session.id}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'project-tree__session-name';
    const displayName = sessionDisplayName(session, project) || session.id;
    nameEl.textContent = displayName;
    nameEl.title = displayName;
    item.appendChild(nameEl);

    // A dot means a turn is in progress, not that the provider process is alive.
    const activity = this.container.has('sessionActivity') ? this.container.get('sessionActivity').statusOf(session.id) : 'idle';
    if (activity === 'running') {
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
      const raw = localStorage.getItem(ProjectPage.FOLDERS_COLLAPSED_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) {
      return new Set();
    }
  }

  _toggleFolderCollapsed(key) {
    const set = this._collapsedFolders();
    if (set.has(key)) set.delete(key); else set.add(key);
    try {
      localStorage.setItem(ProjectPage.FOLDERS_COLLAPSED_KEY, JSON.stringify([...set]));
    } catch (_) { /* storage full / disabled — collapse just won't persist */ }
    this._renderThreads(this.state.getProject(this.projectId));
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

  // ---- Tasks ------------------------------------------------------------

  _renderTasks() {
    const container = this._tasksList;
    container.textContent = '';
    const tasks = this.state.getTasksForProject(this.projectId);
    this._tasksCount.textContent = String(tasks.length);
    const taskViewer = this.container.get('taskViewer');

    for (const task of tasks) {
      const hasLastRun = taskViewer.hasLastRun(task);

      const item = document.createElement('div');
      item.className = 'project-tree__task-item';
      item.dataset.testid = `project-task-${task.id}`;
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
      });

      item.appendChild(actions);
      container.appendChild(item);
    }

    const newItem = document.createElement('div');
    newItem.className = 'project-tree__task-item project-tree__task-item--new';
    newItem.dataset.testid = `project-task-new-${this.projectId}`;
    const label = document.createElement('span');
    label.className = 'project-tree__task-name';
    label.textContent = '+ New Task';
    newItem.appendChild(label);
    newItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId });
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
      case 'weekly': return `${TaskSchedule.shortDay(schedule.day || 'monday')} ${schedule.time || '09:00'}`;
      case 'cron': return schedule.expression || 'cron';
      case 'interval': return `Every ${schedule.minutes || 60}m`;
      case 'once': return 'Once';
      case 'on_demand': return 'On demand';
      default: return schedule.type || '';
    }
  }

  _renderEmpty(container, message) {
    const el = document.createElement('div');
    el.className = 'project-tree__section-empty';
    el.textContent = message;
    container.appendChild(el);
  }

  _subscribeEvents() {
    if (this._subscribed) return;
    this._subscribed = true;
    const refresh = () => { if (this._visible()) this.render(); };
    for (const evt of [EVT.TASKS_LOADED, EVT.TASK_UPDATED, EVT.SESSION_UPDATED, EVT.SESSION_REMOVED,
      EVT.SESSION_CREATED, EVT.PROJECTS_LOADED, EVT.PROJECT_RENAMED]) {
      if (evt) this.bus.on(evt, refresh);
    }
    if (EVT.HOST_STATUS) this.bus.on(EVT.HOST_STATUS, refresh);
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'projectPage',
    init: (container) => new ProjectPage(container),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProjectPage;
}
