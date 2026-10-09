const GIT_SCOPES = new Set(['uncommitted', 'base']);
// WebSocket CLOSING / CLOSED. A streamed git_changes can outlive the socket.
const WS_CLOSING = 2;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

class FileHandlers {
  // files: the RelayFileClient (relay-file-client.js). Every project's files,
  // console or SSH host, are reached through it.
  constructor({ resolveProject, files } = {}) {
    this.resolveProject = resolveProject;
    this.files = files;
    // requestId -> AbortController of a search in flight.
    this._searches = new Map();
  }

  _resolveProject(projectId) {
    return this.resolveProject(projectId) || null;
  }

  // Every WS file handler and routes/index.js's /api/files must go through
  // this rather than reaching for the client directly.
  fileServiceFor(project) {
    return this.files.forProject(project);
  }

  cancelSearch(requestId) {
    const ctl = this._searches.get(requestId);
    if (!ctl) return false;
    this._searches.delete(requestId);
    ctl.abort();
    return true;
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

    const ctl = new AbortController();
    if (requestId) this._searches.set(requestId, ctl);
    try {
      const result = await this.fileServiceFor(project).search(project.path, query, options || {}, { signal: ctl.signal });
      ws.send(JSON.stringify({
        type: 'search_results',
        requestId,
        projectId,
        matches: result.matches,
        truncated: result.truncated,
        durationMs: result.durationMs,
      }));
    } catch (err) {
      // A cancelled search has nobody waiting for an answer.
      if (err && err.name === 'AbortError') return;
      ws.send(JSON.stringify({ type: 'search_error', requestId, projectId, error: err.message }));
    } finally {
      if (requestId && this._searches.get(requestId) === ctl) this._searches.delete(requestId);
    }
  }

  // --- Git changes (docs/design-git-changes.md) ---------------------------

  _sendGitError(ws, fields, err, project) {
    ws.send(JSON.stringify({
      type: 'git_error',
      ...fields,
      code: (err && err.code) || 'FAILED',
      error: this._gitErrorMessage(err, project),
    }));
  }

  // git's stderr routinely names the absolute repo path; the browser only
  // ever deals in project-relative paths, so strip the server-side root.
  _gitErrorMessage(err, project) {
    let msg = (err && err.message) || 'git failed';
    if (project && project.path) msg = msg.split(project.path).join('');
    return msg;
  }

  _gitScope(scope) {
    if (scope === undefined || scope === null) return 'uncommitted';
    return GIT_SCOPES.has(scope) ? scope : null;
  }

  // One repo's git_changes entry: its meta merged with status(), which owns
  // upstream/ahead/behind (repos() leaves them null/0). A failure becomes the
  // entry's `error` rather than failing the frame.
  async _gitRepoEntry(fs, project, meta, scope) {
    try {
      const st = await fs.gitStatus(project.path, meta.path, scope);
      const entry = { ...meta };
      for (const k of ['upstream', 'ahead', 'behind']) {
        if (st[k] !== undefined) entry[k] = st[k];
      }
      return { ...entry, pending: false, files: st.files, base: st.base, truncated: !!st.truncated };
    } catch (err) {
      return {
        ...meta, pending: false, files: [], base: null, truncated: false,
        error: { code: err.code || 'FAILED', message: this._gitErrorMessage(err, project) },
      };
    }
  }

  // Full request (no `repo`) streams per the design doc's "Streaming"
  // contract: a full-list frame with every repo pending, then one
  // single-repo frame per repo in completion order. GitService caps how many
  // git processes actually run at once.
  async gitChanges(ws, message) {
    const { projectId, repo } = message;
    const scope = this._gitScope(message.scope);
    const fields = { projectId };
    if (repo !== undefined) fields.repo = repo;

    if (!scope) return this._sendGitError(ws, fields, { code: 'INVALID', message: 'Invalid scope' });
    if (repo !== undefined && !isNonEmptyString(repo)) {
      return this._sendGitError(ws, fields, { code: 'INVALID', message: 'Invalid repo' });
    }
    const project = this._resolveProject(projectId);
    if (!project) return this._sendGitError(ws, fields, { code: 'NOT_FOUND', message: 'Project not found' });

    let fs;
    let metas;
    try {
      fs = this.fileServiceFor(project);
      metas = await fs.gitRepos(project.path);
    } catch (err) {
      return this._sendGitError(ws, fields, err, project);
    }

    // `repo` is echoed only on a single-repo frame; its absence tells the
    // client to replace its list rather than merge.
    const send = (repos, repoPath) => {
      if (ws.readyState >= WS_CLOSING) return;
      const frame = { type: 'git_changes', projectId, scope, repos };
      if (repoPath !== undefined) frame.repo = repoPath;
      ws.send(JSON.stringify(frame));
    };

    if (repo !== undefined) {
      const meta = metas.find((m) => m.path === repo);
      if (!meta) return this._sendGitError(ws, fields, { code: 'NOT_A_REPO', message: 'Not a git repository' });
      return send([await this._gitRepoEntry(fs, project, meta, scope)], repo);
    }

    send(metas.map((m) => ({ ...m, pending: true, files: [], base: null, truncated: false })));
    await Promise.all(metas.map(async (meta) => {
      const entry = await this._gitRepoEntry(fs, project, meta, scope);
      send([entry], meta.path);
    }));
  }

  async gitFileVersions(ws, message) {
    const { projectId, repo, path: filePath } = message;
    const scope = this._gitScope(message.scope);
    const fields = { projectId, repo, path: filePath };

    if (!scope) return this._sendGitError(ws, fields, { code: 'INVALID', message: 'Invalid scope' });
    if (!isNonEmptyString(repo) || !isNonEmptyString(filePath)) {
      return this._sendGitError(ws, fields, { code: 'INVALID', message: 'Invalid repo or path' });
    }
    const project = this._resolveProject(projectId);
    if (!project) return this._sendGitError(ws, fields, { code: 'NOT_FOUND', message: 'Project not found' });

    try {
      const fs = this.fileServiceFor(project);
      const v = await fs.gitFileVersions(project.path, repo, filePath, scope);
      ws.send(JSON.stringify({
        type: 'git_file_versions',
        projectId, repo, path: filePath, scope,
        original: v.original,
        modified: v.modified,
        binary: !!v.binary,
        tooLarge: !!v.tooLarge,
        originalSize: v.originalSize,
        modifiedSize: v.modifiedSize,
      }));
    } catch (err) {
      this._sendGitError(ws, fields, err, project);
    }
  }
}

module.exports = FileHandlers;
