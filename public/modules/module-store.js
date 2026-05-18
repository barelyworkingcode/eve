/**
 * ModuleStore — lazy loader for modules under a project.
 * Fetches GET /api/modules?projectId=... and pushes results into StateStore.
 */
class ModuleStore {
  constructor(container) {
    this.api = container.get('api');
    this.state = container.get('state');
    this.log = container.get('logger').child('ModuleStore');
    this._loading = new Map(); // projectId -> Promise
  }

  /**
   * Fetch and cache. If already loaded (or in flight), returns the existing promise.
   * Pass { force: true } to bypass the cache.
   */
  async loadModulesForProject(projectId, { force = false } = {}) {
    if (!projectId) return [];
    if (!force && this.state.modules.has(projectId)) {
      return this.state.getModulesForProject(projectId);
    }
    if (this._loading.has(projectId)) return this._loading.get(projectId);

    const p = this._fetch(projectId).finally(() => this._loading.delete(projectId));
    this._loading.set(projectId, p);
    return p;
  }

  async _fetch(projectId) {
    try {
      const data = await this.api.listModules(projectId);
      const modules = Array.isArray(data.modules) ? data.modules : [];
      this.state.setModulesForProject(projectId, modules);
      return modules;
    } catch (err) {
      this.log.error(`Failed to load modules for ${projectId}:`, err.message);
      this.state.setModulesForProject(projectId, []);
      return [];
    }
  }

  /**
   * Drop cache for a project (call after a module is created/deleted via chat).
   */
  invalidate(projectId) {
    this.state.modules.delete(projectId);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModuleStore;
}
