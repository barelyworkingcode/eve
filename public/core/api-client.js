/**
 * ApiClient - HTTP API wrapper for relayLLM endpoints.
 * Replaces scattered fetch() calls throughout app.js and task-manager.js.
 */
class ApiClient {
  constructor() {
    this._getToken = () => localStorage.getItem('eve_session');
  }

  _headers(json = true) {
    const h = {};
    const token = this._getToken();
    if (token) h['X-Session-Token'] = token;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async _request(method, url, body) {
    const opts = { method, headers: this._headers() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const response = await fetch(url, opts);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return response.json().catch(() => ({}));
  }

  // Projects
  getProjects() { return this._request('GET', '/api/projects'); }
  createProject(data) { return this._request('POST', '/api/projects', data); }
  updateProject(id, data) { return this._request('PUT', `/api/projects/${id}`, data); }
  deleteProject(id) { return this._request('DELETE', `/api/projects/${id}`); }

  // Sessions
  getSessions() { return this._request('GET', '/api/sessions'); }

  // Models
  getModels() { return this._request('GET', '/api/models'); }

  // Tasks
  getTasks(projectId) {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this._request('GET', `/api/tasks${qs}`);
  }
  createTask(data) { return this._request('POST', '/api/tasks', data); }
  updateTask(id, data) { return this._request('PUT', `/api/tasks/${id}`, data); }
  deleteTask(id) { return this._request('DELETE', `/api/tasks/${id}`); }
  runTask(id) { return this._request('POST', `/api/tasks/${id}/run`); }
  getTaskHistory(id) { return this._request('GET', `/api/tasks/${id}/history`); }
  deleteTasksByProject(projectId) {
    return this._request('DELETE', `/api/tasks/by-project/${projectId}`);
  }

  // Terminal Templates
  getTerminalTemplates() { return this._request('GET', '/api/terminal/templates'); }
  createTerminalTemplate(data) { return this._request('POST', '/api/terminal/templates', data); }
  updateTerminalTemplate(id, data) { return this._request('PUT', `/api/terminal/templates/${id}`, data); }
  deleteTerminalTemplate(id) { return this._request('DELETE', `/api/terminal/templates/${id}`); }
}
