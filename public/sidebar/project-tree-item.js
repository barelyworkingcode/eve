/**
 * ProjectTreeItem - renders a single project header with action icons
 * and collapsible sections (Tasks, Sessions, Files).
 */
class ProjectTreeItem {
  constructor(container, projectId, fileTreeNode) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ProjectTree');
    this.state = container.get('state');
    this.projectId = projectId;
    this.fileTreeNode = fileTreeNode;
    this.expanded = false;
    this.sectionState = { tasks: false, sessions: false, files: false };
    this.onToggle = null;          // callback(projectId, expanded)
    this.onSectionToggle = null;   // callback() - persists section state
    this._subscribed = false;
    this.el = null;
  }

  render(parentEl) {
    const project = this.state.getProject(this.projectId);
    if (!project) return;

    this._subscribeEvents();

    this.el = document.createElement('div');
    this.el.className = 'project-tree__project';

    // Header row
    const header = document.createElement('div');
    header.className = `project-tree__header${this.expanded ? ' project-tree__header--expanded' : ''}`;
    header.dataset.testid = `sidebar-project-${this.projectId}`;

    // Chevron
    const chevron = document.createElement('span');
    chevron.className = 'project-tree__chevron';
    chevron.textContent = this.expanded ? '\u25BC' : '\u25B6';
    header.appendChild(chevron);

    // Project name
    const name = document.createElement('span');
    name.className = 'project-tree__project-name';
    name.textContent = project.name;
    header.appendChild(name);

    // Action icons (right-aligned)
    const actions = document.createElement('span');
    actions.className = 'project-tree__actions';

    actions.appendChild(this._actionBtn('New Shell', UI_ICONS.shell(14), () =>
      this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: this.projectId })));
    actions.appendChild(this._actionBtn('Tasks', UI_ICONS.tasks(14), () =>
      this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId })));
    actions.appendChild(this._actionBtn('More', UI_ICONS.more(14), (e) =>
      this._showProjectMenu(e.clientX, e.clientY)));

    header.appendChild(actions);

    // Click header to expand/collapse
    header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      if (this.onToggle) this.onToggle(this.projectId, this.expanded);
      this._rerender();
    });

    this.el.appendChild(header);

    // Collapsible sections (if project expanded)
    if (this.expanded) {
      const sections = document.createElement('div');
      sections.className = 'project-tree__sections';
      this._renderSection(sections, 'tasks', 'Tasks', (c) => this._renderTasksContent(c));
      this._renderSection(sections, 'sessions', 'Sessions', (c) => this._renderSessionsContent(c));
      this._renderSection(sections, 'files', 'Files', (c) => this._renderFilesContent(c));
      this.el.appendChild(sections);
    }

    parentEl.appendChild(this.el);
  }

  // --- Section rendering ---

  _renderSection(parent, key, label, contentRenderer) {
    const isExpanded = this.sectionState[key];
    const count = this._getSectionCount(key);

    // Section header
    const header = document.createElement('div');
    header.className = `project-tree__section-header${isExpanded ? ' project-tree__section-header--expanded' : ''}`;

    const chevron = document.createElement('span');
    chevron.className = 'project-tree__section-chevron';
    chevron.textContent = isExpanded ? '\u25BC' : '\u25B6';
    header.appendChild(chevron);

    const nameEl = document.createElement('span');
    nameEl.className = 'project-tree__section-name';
    nameEl.textContent = label;
    header.appendChild(nameEl);

    if (count !== null) {
      const countEl = document.createElement('span');
      countEl.className = 'project-tree__section-count';
      countEl.textContent = `(${count})`;
      header.appendChild(countEl);
    }

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      this.sectionState[key] = !this.sectionState[key];
      if (this.onSectionToggle) this.onSectionToggle();
      this._rerender();
    });

    parent.appendChild(header);

    // Section content
    if (isExpanded) {
      const content = document.createElement('div');
      content.className = 'project-tree__section-content';
      contentRenderer(content);
      parent.appendChild(content);
    }
  }

  _getSectionCount(key) {
    if (key === 'tasks') {
      return this.state.getTasksForProject(this.projectId).length;
    }
    if (key === 'sessions') {
      const sessionCount = this.state.getSessionsForProject(this.projectId)
        .filter(s => !this.state.isTaskRun(s.id)).length;
      const termMgr = this.container?.has('terminalManager') ? this.container.get('terminalManager') : null;
      const project = this.state.getProject(this.projectId);
      const terminalCount = (termMgr?.getTerminalsForPath(project?.path) || [])
        .filter(t => !this.state.isTaskRun(t.id)).length;
      return sessionCount + terminalCount;
    }
    return null; // files — no count
  }

  // --- Tasks content ---

  _renderTasksContent(container) {
    const tasks = this.state.getTasksForProject(this.projectId);
    this._renderTaskItems(container, tasks);
  }

  _renderTaskItems(container, tasks) {
    const taskViewer = this.container.get('taskViewer');

    for (const task of tasks) {
      // TaskViewer is the single point that knows interactive-vs-readonly.
      // The sidebar only asks "do you have something to show, and please
      // show it on click."
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

      // Click task row → open whatever the task says its last run is.
      item.addEventListener('click', () => {
        if (!hasLastRun) return;
        taskViewer.openLastRun(task);
        this._closeSidebarOnMobile();
      });

      item.appendChild(actions);
      container.appendChild(item);
    }

    // Always offer a "+ New Task" entry at the end. The Tasks icon in the
    // project header opens the same dialog, but it's non-obvious — adding
    // an in-list affordance means an empty project has a visible path to
    // create the first task.
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

  // --- Sessions content ---

  _renderSessionsContent(container) {
    const sessions = this.state.getSessionsForProject(this.projectId)
      .filter(s => !this.state.isTaskRun(s.id));
    const termMgr = this.container?.has('terminalManager') ? this.container.get('terminalManager') : null;
    const project = this.state.getProject(this.projectId);
    const terminals = (termMgr?.getTerminalsForPath(project?.path) || [])
      .filter(t => !this.state.isTaskRun(t.id));

    if (sessions.length === 0 && terminals.length === 0) {
      this._renderEmpty(container, 'No sessions');
      return;
    }

    for (const terminal of terminals) {
      this._renderTerminalItem(container, terminal);
    }

    for (const session of sessions) {
      // Swipe wrapper: clips overflow, holds content + delete action
      const wrapper = document.createElement('div');
      wrapper.className = 'project-tree__session-swipe';

      // Delete action (revealed on swipe left)
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
      // Strip project name prefix if present for cleaner display
      const project = this.state.getProject(this.projectId);
      let displayName = session.name || session.id;
      if (project && displayName.startsWith(project.name + ' - ')) {
        displayName = displayName.slice(project.name.length + 3);
      }
      nameEl.textContent = displayName;
      item.appendChild(nameEl);

      if (session.model) {
        const badge = document.createElement('span');
        badge.className = 'project-tree__session-badge';
        // Show short model name
        const modelParts = session.model.split('/');
        badge.textContent = modelParts[modelParts.length - 1];
        item.appendChild(badge);
      }

      const swipeState = { swiped: false };

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        // Don't navigate if we just swiped or delete is revealed
        if (swipeState.swiped || wrapper.classList.contains('project-tree__session-swipe--open')) return;
        this.container.get('app').joinSession(session.id);
        this._closeSidebarOnMobile();
      });

      this._attachSwipe(wrapper, item, swipeState);

      wrapper.appendChild(deleteAction);
      wrapper.appendChild(item);
      container.appendChild(wrapper);
    }
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

  // --- Files content ---

  _renderFilesContent(container) {
    const treeContainer = document.createElement('div');
    treeContainer.className = 'file-tree';
    treeContainer.dataset.projectId = this.projectId;
    this.fileTreeNode.renderTree(this.projectId, treeContainer);
    container.appendChild(treeContainer);
  }

  // --- Shared helpers ---

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

  _attachSwipe(wrapper, item, swipeState) {
    const DELETE_WIDTH = 64;
    const THRESHOLD = 20; // min px before swipe activates
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let swiping = false;
    let locked = false; // true once we commit to horizontal swipe

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

      // Decide direction on first significant movement
      if (!locked && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical scroll — bail out
          swiping = false;
          return;
        }
        locked = true;
        swiping = true;
        window._sidebarSwipeLocked = true;
      }

      if (!swiping) return;
      e.preventDefault();

      // Clamp: allow left swipe up to DELETE_WIDTH, slight resistance past that
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
        // Snap open — keep sidebar locked until closed or acted on
        item.style.transform = `translateX(${-DELETE_WIDTH}px)`;
        wrapper.classList.add('project-tree__session-swipe--open');
      } else {
        // Snap closed
        item.style.transform = '';
        wrapper.classList.remove('project-tree__session-swipe--open');
      }
      // Release lock after click event fires (next tick)
      setTimeout(() => { window._sidebarSwipeLocked = false; }, 300);
    }, { passive: true });

    // Close on tap elsewhere (any open swipe resets on next touchstart)
    item.addEventListener('touchstart', () => {
      // Close other open swipes in the same section
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

  _closeSidebarOnMobile() {
    const app = this.container.has('app') ? this.container.get('app') : null;
    if (app?.closeSidebarOnMobile) app.closeSidebarOnMobile();
  }

  _rerender() {
    const parent = this.el?.parentElement;
    if (!parent) return;
    const next = this.el.nextSibling;
    this.el.remove();
    // Build new element into a detached fragment, then insert at original position.
    const fragment = document.createDocumentFragment();
    this.render(fragment);
    parent.insertBefore(fragment, next);
  }

  _actionBtn(title, iconHtml, onClick) {
    const btn = document.createElement('button');
    btn.className = 'project-tree__action-btn';
    btn.title = title;
    btn.innerHTML = iconHtml;
    btn.dataset.testid = `sidebar-project-${title.toLowerCase().replace(/\s+/g, '-')}-${this.projectId}`;
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

  // --- Event subscriptions (one-time) ---

  _subscribeEvents() {
    if (this._subscribed) return;
    this._subscribed = true;

    // Tasks: re-render on any task state change
    const onTaskEvent = () => {
      if (!this.expanded) return;
      this._rerender();
    };
    this.bus.on(EVT.TASKS_LOADED, onTaskEvent);
    this.bus.on(EVT.TASK_UPDATED, onTaskEvent);

    // Sessions: re-render on session changes
    const onSessionEvent = () => {
      if (!this.expanded) return;
      this._rerender();
    };
    this.bus.on(EVT.SESSION_UPDATED, onSessionEvent);
    this.bus.on(EVT.SESSION_REMOVED, onSessionEvent);

    // Terminals: re-render when terminal list changes
    this.bus.on(EVT.TERMINAL_LIST, () => {
      this._rerender();  // Always rerender — count shown even when collapsed
    });
  }
}
