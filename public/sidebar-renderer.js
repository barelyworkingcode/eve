/**
 * Sidebar rendering: project list, session items, task items,
 * inline rename, ungrouped sessions.
 */
class SidebarRenderer {
  constructor(app) {
    this.app = app;
    this.renamingSessionId = null;
  }

  renderProjectList() {
    // Capture in-progress rename value before re-rendering
    const activeRenameId = this.renamingSessionId;
    let activeRenameValue = null;
    if (activeRenameId) {
      const input = this.app.elements.projectList.querySelector('.session-rename-input');
      if (input) activeRenameValue = input.value;
    }

    this.renamingSessionId = null;
    this.app.elements.projectList.innerHTML = '';

    const { projectSessions, ungroupedSessions } = this.groupSessions();

    for (const [projectId, project] of this.app.projects) {
      const sessions = projectSessions.get(projectId) || [];
      this.renderProjectGroup(projectId, project, sessions);
    }

    if (ungroupedSessions.length > 0) {
      this.renderUngroupedSessions(ungroupedSessions);
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

    for (const [id, session] of this.app.sessions) {
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

  renderProjectGroup(projectId, project, sessions) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);
    const projectEl = document.createElement('div');
    projectEl.className = project.disabled ? 'project-group disabled collapsed' : 'project-group collapsed';

    const disabledNote = project.disabled ? '<span class="disabled-note">(provider disabled)</span>' : '';
    const toolsBadge = project.allowedTools?.length > 0 ? `<span class="project-tools-badge" title="${escapeHtml(project.allowedTools.join(', '))}">${project.allowedTools.length} tools</span>` : '';
    const mcpBadge = project.integrations?.length > 0 ? `<span class="project-tools-badge" title="${escapeHtml(project.integrations.join(', '))}">${project.integrations.length} mcp</span>` : '';

    projectEl.innerHTML = `
      <div class="project-header">
        <span class="project-toggle">▶</span>
        <span class="project-name">${escapeHtml(project.name)}</span>
        ${toolsBadge}
        ${mcpBadge}
        ${disabledNote}
        <button class="project-files-toggle" title="Browse files">📁</button>
        <button class="project-edit" title="Edit project">&#9998;</button>
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
    const quickAddBtn = projectEl.querySelector('.project-quick-add');
    const deleteBtn = projectEl.querySelector('.project-delete');

    header.addEventListener('click', (e) => {
      if (e.target === deleteBtn || e.target === quickAddBtn || e.target === filesToggleBtn || e.target === editBtn || project.disabled) return;
      projectEl.classList.toggle('collapsed');
      toggle.textContent = projectEl.classList.contains('collapsed') ? '▶' : '▼';
    });

    filesToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!project.disabled) {
        this.app.fileBrowser.toggleFileTree(projectId);
      }
    });

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.toggleSidebar(false);
      this.app.modalManager.showProjectModal(projectId);
    });

    quickAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!project.disabled) {
        this.app.toggleSidebar(false);
        this.app.modalManager.showSessionModal(projectId);
      }
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.deleteProject(projectId);
    });

    // Render sessions
    for (const session of sessions) {
      this.renderSessionItem(session, sessionsList, !project.disabled);
    }

    this.app.elements.projectList.appendChild(projectEl);
  }

  renderUngroupedSessions(sessions) {
    const ungroupedEl = document.createElement('div');
    ungroupedEl.className = 'project-group ungrouped collapsed';
    ungroupedEl.innerHTML = `
      <div class="project-header">
        <span class="project-toggle">&#9656;</span>
        <span class="project-name">Ungrouped</span>
      </div>
      <ul class="project-sessions"></ul>
    `;

    const header = ungroupedEl.querySelector('.project-header');
    const toggle = ungroupedEl.querySelector('.project-toggle');
    const sessionsList = ungroupedEl.querySelector('.project-sessions');

    header.addEventListener('click', () => {
      ungroupedEl.classList.toggle('collapsed');
      toggle.textContent = ungroupedEl.classList.contains('collapsed') ? '&#9656;' : '&#9662;';
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
        this.app.toggleSidebar(false);
      });
    }

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
