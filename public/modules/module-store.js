class ModuleStore {
  constructor(container) {
    this.api = container.get('api');
    this.state = container.get('state');
    this.log = container.get('logger').child('ModuleStore');
    this._loading = new Map();
  }

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

  invalidate(projectId) {
    this.state.modules.delete(projectId);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModuleStore;
}
