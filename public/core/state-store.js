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
    this.models = [];
    this.providerSettings = {};
    this.currentSessionId = null;
  }

  // --- Sessions ---

  setCurrentSession(id) {
    const prev = this.currentSessionId;
    this.currentSessionId = id;
    this.bus.emit(EVT.SESSION_SWITCH, { sessionId: id, prevSessionId: prev });
  }

  addSession(session) {
    this.sessions.set(session.id || session.sessionId, {
      id: session.id || session.sessionId,
      projectId: session.projectId || null,
      name: session.name || null,
      directory: session.directory,
      model: session.model || null,
      active: session.active !== undefined ? session.active : true,
      costUsd: 0,
    });
    this.bus.emit(EVT.SESSION_UPDATED, { sessionId: session.id || session.sessionId });
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
    this.projects.delete(id);
    this.bus.emit(EVT.PROJECT_DELETED, { projectId: id });
  }

  // --- Models ---

  setModels(models, providerSettings) {
    this.models = models || [];
    this.providerSettings = providerSettings || {};
    this.bus.emit(EVT.MODELS_LOADED);
  }
}
