/**
 * Sidebar rendering: project list, session items, task items,
 * inline rename, ungrouped sessions.
 */
class SidebarRenderer {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.renamingSessionId = null;
  }

  renderProjectList() {
    // Guard: the new project tree sidebar replaces this element
    if (!this.app.elements.projectList) return;

    // Capture in-progress rename value before re-rendering
    const activeRenameId = this.renamingSessionId;
    let activeRenameValue = null;
    if (activeRenameId) {
      const input = this.app.elements.projectList.querySelector('.session-rename-input');
      if (input) activeRenameValue = input.value;
    }

    // Capture expanded (non-collapsed) project groups before re-rendering
    const expandedProjects = new Set();
    for (const el of this.app.elements.projectList.querySelectorAll('.project-group:not(.collapsed)')) {
      const key = el.dataset.projectId || (el.classList.contains('ungrouped') ? '__ungrouped' : null);
      if (key) expandedProjects.add(key);
    }

    this.renamingSessionId = null;
    this.app.elements.projectList.innerHTML = '';

    const { projectSessions, ungroupedSessions } = this.groupSessions();

    for (const [projectId, project] of this.app.projects) {
      const sessions = projectSessions.get(projectId) || [];
      const expanded = expandedProjects.has(projectId);
      this.renderProjectGroup(projectId, project, sessions, expanded);
    }

    if (ungroupedSessions.length > 0) {
      const expanded = expandedProjects.has('__ungrouped');
      this.renderUngroupedSessions(ungroupedSessions, expanded);
    }

    // Restore in-progress rename after re-render
    if (activeRenameId) {
      const nameEl = this.app.elements.projectList
        .querySelector(`[data-session-id="${activeRenameId}"] .session-name`);
      if (nameEl) {
        this.startInlineRename(activeRenameId, nameEl, activeRenameValue);
      }
    }
  }

  groupSessions() {
    const projectSessions = new Map();
    const ungroupedSessions = [];
    const taskSessionIds = this.app.taskManager ? this.app.taskManager.getTaskSessionIds() : new Set();

    for (const [id, session] of this.app.sessions) {
      if (taskSessionIds.has(id)) continue;
      if (session.projectId && this.app.projects.has(session.projectId)) {
        if (!projectSessions.has(session.projectId)) {
          projectSessions.set(session.projectId, []);
        }
        projectSessions.get(session.projectId).push({ id, ...session });
      } else {
        ungroupedSessions.push({ id, ...session });
      }
    }

    return { projectSessions, ungroupedSessions };
  }

  renderProjectGroup(projectId, project, sessions, expanded = false) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);
    const projectEl = document.createElement('div');
    projectEl.className = expanded ? 'project-group' : 'project-group collapsed';

    const toolsBadge = project.allowedTools?.length > 0 ? `<span class="project-tools-badge" title="${escapeHtml(project.allowedTools.join(', '))}">${project.allowedTools.length} tools</span>` : '';

    const projectTasks = this.app.taskManager ? this.app.taskManager.getTasksForProject(projectId) : [];
    const taskBadge = projectTasks.length > 0 ? `<span class="project-tasks-badge">${projectTasks.length} task${projectTasks.length !== 1 ? 's' : ''}</span>` : '';

    projectEl.innerHTML = `
      <div class="project-header">
        <span class="project-toggle">${expanded ? '▼' : '▶'}</span>
        <span class="project-name">${escapeHtml(project.name)}</span>
        ${toolsBadge}
        ${taskBadge}
        <button class="project-files-toggle" title="Browse files">📁</button>
        <button class="project-edit" title="Edit project">&#9998;</button>
        <button class="project-add-task" title="New task">⏱</button>
        <button class="project-quick-add" title="New session in this project">+</button>
        <button class="project-delete" title="Delete project">&times;</button>
      </div>
      <div class="file-tree" style="display: none;"></div>
      <ul class="project-sessions"></ul>
    `;
    projectEl.dataset.projectId = projectId;

    const header = projectEl.querySelector('.project-header');
    const toggle = projectEl.querySelector('.project-toggle');
    const sessionsList = projectEl.querySelector('.project-sessions');
    const filesToggleBtn = projectEl.querySelector('.project-files-toggle');
    const editBtn = projectEl.querySelector('.project-edit');
    const addTaskBtn = projectEl.querySelector('.project-add-task');
    const quickAddBtn = projectEl.querySelector('.project-quick-add');
    const deleteBtn = projectEl.querySelector('.project-delete');

    header.addEventListener('click', (e) => {
      if (e.target === deleteBtn || e.target === quickAddBtn || e.target === filesToggleBtn || e.target === editBtn || e.target === addTaskBtn) return;
      projectEl.classList.toggle('collapsed');
      toggle.textContent = projectEl.classList.contains('collapsed') ? '▶' : '▼';
    });

    filesToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.fileBrowser.toggleFileTree(projectId);
    });

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.bus.emit(EVT.DIALOG_PROJECT, { projectId });
    });

    quickAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.modalManager.showSessionModal(projectId);
    });

    addTaskBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.modalManager.showTaskModal(projectId);
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.deleteProject(projectId);
    });

    // Render tasks
    for (const task of projectTasks) {
      this.renderTaskItem(task, sessionsList);
    }

    // Render sessions
    for (const session of sessions) {
      this.renderSessionItem(session, sessionsList, true);
    }

    this.app.elements.projectList.appendChild(projectEl);
  }

  renderUngroupedSessions(sessions, expanded = false) {
    const ungroupedEl = document.createElement('div');
    ungroupedEl.className = expanded ? 'project-group ungrouped' : 'project-group ungrouped collapsed';
    ungroupedEl.innerHTML = `
      <div class="project-header">
        <span class="project-toggle">${expanded ? '▼' : '▶'}</span>
        <span class="project-name">Ungrouped</span>
      </div>
      <ul class="project-sessions"></ul>
    `;

    const header = ungroupedEl.querySelector('.project-header');
    const toggle = ungroupedEl.querySelector('.project-toggle');
    const sessionsList = ungroupedEl.querySelector('.project-sessions');

    header.addEventListener('click', () => {
      ungroupedEl.classList.toggle('collapsed');
      toggle.textContent = ungroupedEl.classList.contains('collapsed') ? '▶' : '▼';
    });

    for (const session of sessions) {
      this.renderSessionItem(session, sessionsList, true);
    }

    this.app.elements.projectList.appendChild(ungroupedEl);
  }

  renderSessionItem(session, parentEl, clickable) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);
    const li = document.createElement('li');
    li.className = `session-item ${session.id === this.app.currentSessionId ? 'active' : ''}`;
    li.dataset.sessionId = session.id;
    li.innerHTML = `
      <div class="session-name" title="${escapeHtml(session.directory)}">${escapeHtml(this.app.getSessionDisplayName(session.id))}</div>
      <div class="session-actions">
        ${session.model ? `<span class="session-model">${escapeHtml(session.model)}</span>` : ''}
        <span class="status">${session.active ? 'Active' : 'Inactive'}</span>
        <button class="session-rename" title="Rename session">&#9998;</button>
        <button class="session-delete" title="Delete session">&times;</button>
      </div>
    `;

    const nameEl = li.querySelector('.session-name');
    const renameBtn = li.querySelector('.session-rename');
    const deleteBtn = li.querySelector('.session-delete');

    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startInlineRename(session.id, nameEl);
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.deleteSession(session.id);
    });

    if (clickable) {
      li.addEventListener('click', () => {
        if (this.renamingSessionId) return;
        this.app.joinSession(session.id);
      });
    }

    parentEl.appendChild(li);
  }

  renderTaskItem(task, parentEl) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);
    const li = document.createElement('li');
    li.className = 'session-item task-item';
    const statusIcon = task.enabled ? '⏱' : '⏸';
    const lastStatus = task.lastStatus === 'error' ? ' err' : task.lastStatus === 'running' ? ' run' : '';
    const scheduleDesc = this.app.taskManager.formatSchedule(task.schedule);
    li.innerHTML = `
      <div class="session-name task-name" title="${escapeHtml(task.prompt)}">
        <span class="task-icon">${statusIcon}</span>
        ${escapeHtml(task.name)}
      </div>
      <div class="session-actions">
        <span class="session-model">${escapeHtml(scheduleDesc)}${lastStatus}</span>
        <button class="task-edit" title="Edit task">&#9998;</button>
        <button class="task-run" title="Run now">▶</button>
        <button class="session-delete" title="Delete task">&times;</button>
      </div>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.task-edit') || e.target.closest('.task-run') || e.target.closest('.session-delete')) return;
      if (!task.lastSessionId) return;
      this.app.joinSession(task.lastSessionId);
    });

    li.querySelector('.task-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.modalManager.showTaskModal(task.projectId, task.id);
    });

    const runBtn = li.querySelector('.task-run');
    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (runBtn.classList.contains('running')) return;
      runBtn.classList.add('running');
      runBtn.textContent = '';
      const spinner = document.createElement('span');
      spinner.className = 'task-run-spinner';
      runBtn.appendChild(spinner);

      // Don't delete the old session here — the scheduler handles cleanup
      // (EndSession on old session before creating a new one). The old
      // session stays visible until task_completed arrives with the new
      // sessionId, at which point auto-join switches to it.

      this.app.taskManager.userTriggeredRuns.add(task.id);
      this.app.taskManager.runTask(task.id);
    });

    // Show spinner if task is currently running (handles page refresh + other-tab runs)
    if (task.lastStatus === 'running') {
      runBtn.classList.add('running');
      runBtn.textContent = '';
      const spinner = document.createElement('span');
      spinner.className = 'task-run-spinner';
      runBtn.appendChild(spinner);
    }

    li.querySelector('.session-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.modalManager.showConfirmModal(`Delete task "${task.name}"?`, async () => {
        await this.app.taskManager.deleteTask(task.id);
        this.app.sidebarRenderer.renderProjectList();
      });
    });

    parentEl.appendChild(li);
  }

  startInlineRename(sessionId, nameEl, initialValue) {
    if (this.renamingSessionId) return;
    this.renamingSessionId = sessionId;

    const currentName = initialValue ?? this.app.getSessionDisplayName(sessionId);
    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.maxLength = 100;
    input.value = currentName;

    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      if (!this.renamingSessionId) return;
      this.renamingSessionId = null;
      const newName = input.value.trim();
      const session = this.app.sessions.get(sessionId);
      if (session) session.name = newName || null;
      this.app.wsClient.send({
        type: 'rename_session',
        sessionId,
        name: newName
      });
      this.renderProjectList();
    };

    const cancel = () => {
      if (!this.renamingSessionId) return;
      this.renamingSessionId = null;
      this.renderProjectList();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });

    input.addEventListener('blur', () => commit());
  }
}
