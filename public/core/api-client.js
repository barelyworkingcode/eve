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
      const err = new Error(data.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return response.json().catch(() => ({}));
  }

  getProjects() { return this._request('GET', '/api/projects'); }
  createProject(data) { return this._request('POST', '/api/projects', data); }
  updateProject(id, data) { return this._request('PUT', `/api/projects/${id}`, data); }
  deleteProject(id) { return this._request('DELETE', `/api/projects/${id}`); }
  regenerateSkills(id) { return this._request('POST', `/api/projects/${id}/regen_skill`); }

  getSessions() { return this._request('GET', '/api/sessions'); }

  getModels() { return this._request('GET', '/api/models'); }

  getMcps() { return this._request('GET', '/api/mcps'); }

  // SSH hosts (../relay/docs/ssh-hosts.md).
  getHosts() { return this._request('GET', '/api/hosts'); }
  createHost(data) { return this._request('POST', '/api/hosts', data); }
  updateHost(id, data) { return this._request('PUT', `/api/hosts/${id}`, data); }
  deleteHost(id) { return this._request('DELETE', `/api/hosts/${id}`); }
  probeHost(id) { return this._request('POST', `/api/hosts/${id}/probe`); }
  disconnectHost(id) { return this._request('POST', `/api/hosts/${id}/disconnect`); }

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

  getTerminalTemplates(projectId) { return this._request('GET', `/api/terminal/templates${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`); }
  createTerminalTemplate(data) { return this._request('POST', '/api/terminal/templates', data); }
  updateTerminalTemplate(id, data) { return this._request('PUT', `/api/terminal/templates/${id}`, data); }
  deleteTerminalTemplate(id) { return this._request('DELETE', `/api/terminal/templates/${id}`); }

  // Persistent (tmux) sessions on a host project's host.
  getPersistentSessions(projectId) {
    return this._request('GET', `/api/projects/${encodeURIComponent(projectId)}/persistent-sessions`);
  }
  deletePersistentSession(projectId, name) {
    return this._request('DELETE', `/api/projects/${encodeURIComponent(projectId)}/persistent-sessions/${encodeURIComponent(name)}`);
  }

  // Body is the raw image; resolves to {path} of the temp file written where
  // the terminal runs (on the SSH host when hostId is set).
  async pasteTerminalImage(blob, hostId) {
    const query = hostId ? `?host=${encodeURIComponent(hostId)}` : '';
    const response = await fetch(`/api/terminal/paste-image${query}`, {
      method: 'POST',
      headers: { ...this._headers(false), 'Content-Type': blob.type },
      body: blob,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  // A project file's text (existing route GET /api/files/:projectId/*). Rejects with
  // err.tooLarge past maxBytes and err.binary for a file with NUL bytes, so "Ask about
  // this" never attaches either.
  async getFileText(projectId, path, maxBytes = Infinity) {
    const rel = String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`/api/files/${encodeURIComponent(projectId)}/${rel}`, { headers: this._headers(false) });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const length = Number(response.headers.get('Content-Length'));
    if (length > maxBytes) throw Object.assign(new Error('too large'), { tooLarge: true });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw Object.assign(new Error('too large'), { tooLarge: true });
    if (bytes.subarray(0, 8192).includes(0)) throw Object.assign(new Error('binary'), { binary: true });
    return new TextDecoder().decode(bytes);
  }

  // Payload is raw PTY bytes (ANSI escapes, possibly invalid UTF-8), not JSON.
  async getTerminalLog(terminalId) {
    const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/log`, {
      method: 'GET',
      headers: this._headers(false),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `HTTP ${response.status}`);
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }
}
