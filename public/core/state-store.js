/**
 * StateStore - centralized shared state with change events.
 * Single source of truth for sessions, projects, models.
 */
class StateStore {
  constructor(bus) {
    this.bus = bus;
    this.sessions = new Map();
    this.sessionHistories = new Map();
    this.projects = new Map();
    this.tasks = new Map();
    // Run IDs (chat sessionId OR PTY terminalId) owned by a scheduled task.
    // Used to filter task-owned tabs out of the user-sessions list — the
    // task already appears under TASKS. Single Set because TaskView IDs
    // share a namespace (both UUIDs from distinct services, never collide).
    this.taskRunIds = new Set();
    this.models = [];
    this.mcps = [];
    this.terminalTemplates = [];
    this.providerSettings = {};
    this.currentSessionId = null;
    this.scopedProjectId = null;
  }

  // --- Sessions ---

  setCurrentSession(id) {
    const prev = this.currentSessionId;
    this.currentSessionId = id;
    this.bus.emit(EVT.SESSION_SWITCH, { sessionId: id, prevSessionId: prev });
  }

  addSession(session) {
    const id = session.id || session.sessionId;
    this.sessions.set(id, {
      ...session,
      id,
      active: session.active !== undefined ? session.active : true,
      costUsd: session.costUsd || 0,
    });
    this.bus.emit(EVT.SESSION_UPDATED, { sessionId: id });
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  updateSession(id, updates) {
    const session = this.sessions.get(id);
    if (session) {
      Object.assign(session, updates);
      this.bus.emit(EVT.SESSION_UPDATED, { sessionId: id });
    }
  }

  removeSession(id) {
    this.sessions.delete(id);
    this.sessionHistories.delete(id);
    this.bus.emit(EVT.SESSION_REMOVED, { sessionId: id });
  }

  getSessionsForProject(projectId) {
    const result = [];
    for (const s of this.sessions.values()) {
      if (s.projectId === projectId) result.push(s);
    }
    return result;
  }

  // --- Projects ---

  setProjects(projects) {
    this.projects.clear();
    for (const p of projects) {
      this.projects.set(p.id, p);
    }
    this.bus.emit(EVT.PROJECTS_LOADED);
  }

  getProject(id) {
    return this.projects.get(id);
  }

  addProject(project) {
    this.projects.set(project.id, project);
    this.bus.emit(EVT.PROJECTS_LOADED);
  }

  removeProject(id) {
    if (this.scopedProjectId === id) this.scopedProjectId = null;
    this.projects.delete(id);
    this.bus.emit(EVT.PROJECT_DELETED, { projectId: id });
  }

  getVisibleProjects() {
    if (this.scopedProjectId && this.projects.has(this.scopedProjectId)) {
      return [this.projects.get(this.scopedProjectId)];
    }
    return Array.from(this.projects.values());
  }

  isProjectVisible(id) {
    return !this.scopedProjectId || this.scopedProjectId === id;
  }

  // --- Tasks ---

  setTasks(tasks) {
    this.tasks.clear();
    this.taskRunIds.clear();
    for (const t of tasks) {
      this.tasks.set(t.id, t);
      if (t.view?.runId) this.taskRunIds.add(t.view.runId);
    }
    this.bus.emit(EVT.TASKS_LOADED);
  }

  addTask(task) {
    this.tasks.set(task.id, task);
    if (task.view?.runId) this.taskRunIds.add(task.view.runId);
    this.bus.emit(EVT.TASKS_LOADED);
  }

  updateTask(id, updates) {
    const task = this.tasks.get(id);
    if (!task) return;
    // Skip the emit if nothing actually changed — scheduler status polls
    // fire task_status broadcasts every 30s with the same payload, which
    // otherwise cascades into a full Tasks-tab re-render in any open task
    // dialog. Shallow compare; view is replaced as a whole object so a
    // reference compare is correct for the new envelope.
    let changed = false;
    for (const k in updates) {
      if (task[k] !== updates[k]) {
        task[k] = updates[k];
        changed = true;
      }
    }
    if (!changed) return;
    if (updates.view?.runId) this.taskRunIds.add(updates.view.runId);
    this.bus.emit(EVT.TASK_UPDATED, { taskId: id });
  }

  removeTask(id) {
    this.tasks.delete(id);
    this.bus.emit(EVT.TASKS_LOADED);
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  getTasksForProject(projectId) {
    const result = [];
    for (const t of this.tasks.values()) {
      if (t.projectId === projectId) result.push(t);
    }
    return result;
  }

  /** True if the given chat sessionId or PTY terminalId belongs to a task. */
  isTaskRun(runId) {
    return this.taskRunIds.has(runId);
  }

  /**
   * Apply a TaskView envelope from a scheduler broadcast — replaces the
   * task's view object so all readers (sidebar, dialog, TaskViewer) see the
   * new run on next read. Extras carry event-specific fields like
   * lastStatus.
   */
  applyTaskViewUpdate(taskId, view, extraUpdates = {}) {
    const updates = { ...extraUpdates };
    if (view) {
      updates.view = { ...view, hasLastRun: !!view.runId };
    }
    this.updateTask(taskId, updates);
  }

  // --- Terminal Templates ---

  setTerminalTemplates(templates) {
    this.terminalTemplates = templates || [];
    this.bus.emit(EVT.TERMINAL_TEMPLATES_LOADED);
  }

  addTerminalTemplate(template) {
    const idx = this.terminalTemplates.findIndex(t => t.id === template.id);
    if (idx >= 0) {
      this.terminalTemplates[idx] = template;
    } else {
      this.terminalTemplates.push(template);
    }
    this.bus.emit(EVT.TERMINAL_TEMPLATES_LOADED);
  }

  removeTerminalTemplate(id) {
    this.terminalTemplates = this.terminalTemplates.filter(t => t.id !== id);
    this.bus.emit(EVT.TERMINAL_TEMPLATES_LOADED);
  }

  // --- Models ---

  setModels(models, providerSettings) {
    this.models = models || [];
    this.providerSettings = providerSettings || {};
    this.bus.emit(EVT.MODELS_LOADED);
  }

  // --- MCPs ---

  setMcps(mcps) {
    this.mcps = mcps || [];
  }
}
