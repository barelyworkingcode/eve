const FileService = require('./file-service');
const RemoteFileService = require('./remote-file-service');

class FileHandlers {
  constructor({ resolveProject, searchService, hostPool } = {}) {
    this.resolveProject = resolveProject;
    this.fileService = new FileService();
    this.searchService = searchService;
    this.hostPool = hostPool || null;
    // hostId -> RemoteFileService. Cheap to rebuild, but the pool's HostAgent
    // is the thing that actually holds the connection, so this is just an
    // adapter cache keyed alongside it.
    this._remoteFileServices = new Map();
  }

  _resolveProject(projectId) {
    return this.resolveProject(projectId) || null;
  }

  // Local for a console project, remote (SSH host agent-backed) for a host
  // project — see ../relay/docs/ssh-hosts.md and remote-file-service.js.
  // Every WS file handler and routes/index.js's /api/files must go through
  // this rather than touching this.fileService directly, or a host project's
  // files would silently resolve against eve's own disk.
  fileServiceFor(project) {
    if (!project || !project.hostId) return this.fileService;
    const agent = this.hostPool ? this.hostPool.get(project.hostId) : null;
    let svc = this._remoteFileServices.get(project.hostId);
    if (!svc || svc.hostAgent !== agent) {
      svc = new RemoteFileService(agent);
      this._remoteFileServices.set(project.hostId, svc);
    }
    return svc;
  }

  _sendError(ws, projectId, path, error) {
    ws.send(JSON.stringify({ type: 'file_error', projectId, path, error }));
  }

  async _handleFileOp(ws, projectId, errorPath, operation) {
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, errorPath, 'Project not found');

    try {
      await operation(project, this.fileServiceFor(project));
    } catch (err) {
      this._sendError(ws, projectId, errorPath, err.message);
    }
  }

  async listDirectory(ws, message) {
    const { projectId, path: relativePath, showHidden } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project, fs) => {
      const entries = await fs.listDirectory(project.path, relativePath || '/', { showHidden });
      ws.send(JSON.stringify({ type: 'directory_listing', projectId, path: relativePath || '/', entries }));
    });
  }

  async readFile(ws, message) {
    const { projectId, path: relativePath } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project, fs) => {
      const { content, size } = await fs.readFile(project.path, relativePath);
      ws.send(JSON.stringify({ type: 'file_content', projectId, path: relativePath, content, size }));
    });
  }

  async writeFile(ws, message) {
    const { projectId, path: relativePath, content } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project, fs) => {
      await fs.writeFile(project.path, relativePath, content);
      ws.send(JSON.stringify({ type: 'file_saved', projectId, path: relativePath }));
    });
  }

  async renameFile(ws, message) {
    const { projectId, path: relativePath, newName } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project, fs) => {
      const newPath = await fs.renameFile(project.path, relativePath, newName);
      ws.send(JSON.stringify({ type: 'file_renamed', projectId, oldPath: relativePath, newPath: '/' + newPath }));
    });
  }

  async moveFile(ws, message) {
    const { projectId, sourcePath, destDirectory } = message;
    await this._handleFileOp(ws, projectId, sourcePath, async (project, fs) => {
      const newPath = await fs.moveFile(project.path, sourcePath, destDirectory);
      ws.send(JSON.stringify({ type: 'file_moved', projectId, oldPath: sourcePath, newPath: '/' + newPath }));
    });
  }

  async deleteFile(ws, message) {
    const { projectId, path: relativePath } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project, fs) => {
      await fs.deleteFile(project.path, relativePath);
      ws.send(JSON.stringify({ type: 'file_deleted', projectId, path: relativePath }));
    });
  }

  async uploadFile(ws, message) {
    const { projectId, destDirectory, fileName, content, encoding } = message;
    await this._handleFileOp(ws, projectId, destDirectory, async (project, fs) => {
      await fs.uploadFile(project.path, destDirectory, fileName, content, encoding);
      ws.send(JSON.stringify({ type: 'file_uploaded', projectId, destDirectory, fileName }));
    });
  }

  async createDirectory(ws, message) {
    const { projectId, path: parentPath, name } = message;
    await this._handleFileOp(ws, projectId, parentPath, async (project, fs) => {
      const newPath = await fs.createDirectory(project.path, parentPath, name);
      ws.send(JSON.stringify({ type: 'directory_created', projectId, path: '/' + newPath, name }));
    });
  }

  async searchProject(ws, message) {
    const { requestId, projectId, query, options } = message;
    const project = this._resolveProject(projectId);
    if (!project) {
      ws.send(JSON.stringify({ type: 'search_error', requestId, projectId, error: 'Project not found' }));
      return;
    }

    if (project.hostId) {
      return this._searchRemoteProject(ws, { requestId, projectId, project, query, options });
    }

    if (!this.searchService) {
      ws.send(JSON.stringify({ type: 'search_error', requestId, projectId, error: 'Search not available' }));
      return;
    }

    try {
      // Anchors to the project root even if project.path itself is misconfigured.
      const safeRoot = this.fileService.validatePath(project.path, '/');
      const result = await this.searchService.run(safeRoot, query, { ...(options || {}), requestId });
      ws.send(JSON.stringify({
        type: 'search_results',
        requestId,
        projectId,
        matches: result.matches,
        truncated: result.truncated,
        durationMs: result.durationMs,
      }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'search_error', requestId, projectId, error: err.message }));
    }
  }

  // Runs remote-fs-agent.js's `search` op instead of spawning ripgrep, then
  // maps {path,line,col,text} matches into the same shape search-service.js
  // returns today (file/lineNumber/lineText/submatches) so the browser's
  // existing rendering path doesn't need to know the project is remote.
  async _searchRemoteProject(ws, { requestId, projectId, project, query, options }) {
    const agent = this.hostPool ? this.hostPool.get(project.hostId) : null;
    if (!agent) {
      ws.send(JSON.stringify({
        type: 'search_error', requestId, projectId,
        error: `Host "${project.host?.name || project.hostId}" is not connected`,
      }));
      return;
    }

    const start = Date.now();
    try {
      const opts = options || {};
      const res = await agent.request('search', {
        root: project.path,
        path: '.',
        query,
        regex: !!opts.regex,
        caseSensitive: !!opts.caseSensitive,
        globs: opts.globs,
        maxMatches: opts.maxMatches,
      });
      const matches = (res.matches || []).map((m) => {
        const start0 = Math.max(0, (m.col || 1) - 1);
        return {
          file: m.path,
          lineNumber: m.line,
          lineText: m.text,
          submatches: [{ start: start0, end: start0 + (m.len || 0) }],
        };
      });
      ws.send(JSON.stringify({
        type: 'search_results',
        requestId,
        projectId,
        matches,
        truncated: !!res.truncated,
        durationMs: Date.now() - start,
      }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'search_error', requestId, projectId, error: err.message }));
    }
  }
}

module.exports = FileHandlers;
