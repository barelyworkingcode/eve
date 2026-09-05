class StateStore {
  constructor(bus) {
    this.bus = bus;
    this.sessions = new Map();
    this.sessionHistories = new Map();
    this.projects = new Map();
    // id -> { id, name, status, error? } — SSH hosts (../relay/docs/ssh-hosts.md).
    // status is 'connecting'|'connected'|'unreachable' while eve's own file
    // agent is what changed it (host_status frames), or whatever GET
    // /api/hosts last reported ('idle'|'unreachable'|'unknown'|'connected')
    // when seeded via setHosts. A project's own `host` field (id/name/status)
    // is attached server-side and travels with the project record, not here.
    this.hosts = new Map();
    this.tasks = new Map();
    // Single Set for both chat sessionId and PTY terminalId runs: both are
    // UUIDs from distinct services and never collide.
    this.taskRunIds = new Set();
    this.models = [];
    this.mcps = [];
    this.terminalTemplates = [];
    this.modules = new Map(); // projectId -> Module[]
    this.providerSettings = {};
    this.currentSessionId = null;
    this.scopedProjectId = null;
  }

  setModulesForProject(projectId, modules) {
    const next = Array.isArray(modules) ? modules : [];
    const prev = this.modules.get(projectId);
    // loadModulesForProject runs on every sidebar re-render; skip the emit on
    // a cache hit or it cascades into another re-render via MODULE_LIST_UPDATED.
    if (prev && this._modulesEqual(prev, next)) return;
    this.modules.set(projectId, next);
    this.bus.emit(EVT.MODULE_LIST_UPDATED, { projectId });
  }

  _modulesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.name !== y.name || x.displayName !== y.displayName ||
          x.broken !== y.broken || x.error !== y.error) return false;
    }
    return true;
  }

  getModulesForProject(projectId) {
    return this.modules.get(projectId) || [];
  }

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
    if (typeof SessionRecents !== 'undefined') SessionRecents.remove(id);
    this.bus.emit(EVT.SESSION_REMOVED, { sessionId: id });
  }

  getSessionsForProject(projectId) {
    const result = [];
    for (const s of this.sessions.values()) {
      if (s.projectId === projectId) result.push(s);
    }
    return result;
  }

  setProjects(projects) {
    this.projects.clear();
    for (const p of projects) {
      this.projects.set(p.id, p);
    }
    this._projectColors = null;
    this.bus.emit(EVT.PROJECTS_LOADED);
  }

  getProject(id) {
    return this.projects.get(id);
  }

  addProject(project) {
    this.projects.set(project.id, project);
    this._projectColors = null;
    this.bus.emit(EVT.PROJECTS_LOADED);
  }

  removeProject(id) {
    if (this.scopedProjectId === id) this.scopedProjectId = null;
    this.projects.delete(id);
    this._projectColors = null;
    this.bus.emit(EVT.PROJECT_DELETED, { projectId: id });
  }

  // Avatar colour per project. Assigned by alphabetical rank with a
  // golden-angle step, not by hashing the name: a hash lands "Hermes Files"
  // and "Hermes Files v3" a few degrees apart, while rank order guarantees
  // every neighbour in the rail is far around the wheel from the next.
  projectColor(id) {
    if (!this._projectColors) {
      const sorted = Array.from(this.projects.values())
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
      this._projectColors = new Map(sorted.map((p, i) => [p.id, projectColorAtRank(i)]));
    }
    return this._projectColors.get(id) || projectColor(id || '');
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
    // Scheduler status polls fire task_status broadcasts every 30s with an
    // unchanged payload; skip the emit or it cascades into a full Tasks-tab
    // re-render in any open task dialog. `view` is always replaced as a whole
    // object, so a reference compare here is correct, not just cheap.
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

  isTaskRun(runId) {
    return this.taskRunIds.has(runId);
  }

  applyTaskViewUpdate(taskId, view, extraUpdates = {}) {
    const updates = { ...extraUpdates };
    if (view) {
      updates.view = { ...view, hasLastRun: !!view.runId };
    }
    this.updateTask(taskId, updates);
  }

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

  setModels(models, providerSettings) {
    this.models = models || [];
    this.providerSettings = providerSettings || {};
    this.bus.emit(EVT.MODELS_LOADED);
  }

  // Display filter only — matches relay's `isWildcard` convention, but relay
  // re-enforces the same allowlist on session creation as the actual boundary.
  modelsForProject(projectId) {
    const allowed = projectId ? this.projects.get(projectId)?.allowedModels : null;
    if (!allowed || allowed.length === 0 || (allowed.length === 1 && allowed[0] === '*')) {
      return this.models;
    }
    const allowSet = new Set(allowed);
    return this.models.filter(m => allowSet.has(m.value));
  }

  setMcps(mcps) {
    this.mcps = mcps || [];
  }

  // Seeds/replaces the full host list, e.g. from GET /api/hosts. Does not
  // clear entries only known from a live `host_status` frame that GET
  // /api/hosts hasn't reported yet — a host_status broadcast can arrive
  // before the next hosts fetch resolves.
  setHosts(hosts) {
    for (const h of (hosts || [])) {
      this.hosts.set(h.id, { ...this.hosts.get(h.id), ...h });
    }
    this.bus.emit(EVT.HOST_STATUS, { hostId: null });
  }

  getHost(id) {
    return this.hosts.get(id);
  }

  hostStatus(id) {
    return this.hosts.get(id)?.status || 'unknown';
  }

  // Applies a server `host_status` WS frame ({hostId, name, status, error?}).
  setHostStatus({ hostId, name, status, error }) {
    if (!hostId) return;
    const prev = this.hosts.get(hostId) || { id: hostId };
    this.hosts.set(hostId, { ...prev, id: hostId, name: name || prev.name, status, error: error || undefined });
    this.bus.emit(EVT.HOST_STATUS, { hostId });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StateStore;
}
