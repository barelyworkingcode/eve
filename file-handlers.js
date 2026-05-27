const FileService = require('./file-service');

class FileHandlers {
  constructor({ resolveProject, searchService } = {}) {
    this.resolveProject = resolveProject;
    this.fileService = new FileService();
    this.searchService = searchService;
  }

  _resolveProject(projectId) {
    return this.resolveProject(projectId) || null;
  }

  _sendError(ws, projectId, path, error) {
    ws.send(JSON.stringify({ type: 'file_error', projectId, path, error }));
  }

  /**
   * Resolves the project, runs the operation, and sends the response.
   * Handles the common resolve-try-call-send pattern.
   */
  async _handleFileOp(ws, projectId, errorPath, operation) {
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, errorPath, 'Project not found');

    try {
      await operation(project);
    } catch (err) {
      this._sendError(ws, projectId, errorPath, err.message);
    }
  }

  async listDirectory(ws, message) {
    const { projectId, path: relativePath, showHidden } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project) => {
      const entries = await this.fileService.listDirectory(project.path, relativePath || '/', { showHidden });
      ws.send(JSON.stringify({ type: 'directory_listing', projectId, path: relativePath || '/', entries }));
    });
  }

  async readFile(ws, message) {
    const { projectId, path: relativePath } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project) => {
      const { content, size } = await this.fileService.readFile(project.path, relativePath);
      ws.send(JSON.stringify({ type: 'file_content', projectId, path: relativePath, content, size }));
    });
  }

  async writeFile(ws, message) {
    const { projectId, path: relativePath, content } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project) => {
      await this.fileService.writeFile(project.path, relativePath, content);
      ws.send(JSON.stringify({ type: 'file_saved', projectId, path: relativePath }));
    });
  }

  async renameFile(ws, message) {
    const { projectId, path: relativePath, newName } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project) => {
      const newPath = await this.fileService.renameFile(project.path, relativePath, newName);
      ws.send(JSON.stringify({ type: 'file_renamed', projectId, oldPath: relativePath, newPath: '/' + newPath }));
    });
  }

  async moveFile(ws, message) {
    const { projectId, sourcePath, destDirectory } = message;
    await this._handleFileOp(ws, projectId, sourcePath, async (project) => {
      const newPath = await this.fileService.moveFile(project.path, sourcePath, destDirectory);
      ws.send(JSON.stringify({ type: 'file_moved', projectId, oldPath: sourcePath, newPath: '/' + newPath }));
    });
  }

  async deleteFile(ws, message) {
    const { projectId, path: relativePath } = message;
    await this._handleFileOp(ws, projectId, relativePath, async (project) => {
      await this.fileService.deleteFile(project.path, relativePath);
      ws.send(JSON.stringify({ type: 'file_deleted', projectId, path: relativePath }));
    });
  }

  async uploadFile(ws, message) {
    const { projectId, destDirectory, fileName, content, encoding } = message;
    await this._handleFileOp(ws, projectId, destDirectory, async (project) => {
      await this.fileService.uploadFile(project.path, destDirectory, fileName, content, encoding);
      ws.send(JSON.stringify({ type: 'file_uploaded', projectId, destDirectory, fileName }));
    });
  }

  async createDirectory(ws, message) {
    const { projectId, path: parentPath, name } = message;
    await this._handleFileOp(ws, projectId, parentPath, async (project) => {
      const newPath = await this.fileService.createDirectory(project.path, parentPath, name);
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
    if (!this.searchService) {
      ws.send(JSON.stringify({ type: 'search_error', requestId, projectId, error: 'Search not available' }));
      return;
    }

    try {
      // validatePath anchors the search to the project root and rejects any
      // funny business with the project's own configured path.
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
}

module.exports = FileHandlers;
