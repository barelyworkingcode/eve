const FileService = require('./file-service');

class FileHandlers {
  constructor(projects) {
    this.projects = projects;
    this.fileService = new FileService();
  }

  _resolveProject(projectId) {
    return this.projects.get(projectId) || null;
  }

  _sendError(ws, projectId, path, error) {
    ws.send(JSON.stringify({ type: 'file_error', projectId, path, error }));
  }

  async listDirectory(ws, message) {
    const { projectId, path: relativePath } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, relativePath, 'Project not found');

    try {
      const entries = await this.fileService.listDirectory(project.path, relativePath || '/');
      ws.send(JSON.stringify({ type: 'directory_listing', projectId, path: relativePath || '/', entries }));
    } catch (err) {
      this._sendError(ws, projectId, relativePath, err.message);
    }
  }

  async readFile(ws, message) {
    const { projectId, path: relativePath } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, relativePath, 'Project not found');

    try {
      const { content, size } = await this.fileService.readFile(project.path, relativePath);
      ws.send(JSON.stringify({ type: 'file_content', projectId, path: relativePath, content, size }));
    } catch (err) {
      this._sendError(ws, projectId, relativePath, err.message);
    }
  }

  async writeFile(ws, message) {
    const { projectId, path: relativePath, content } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, relativePath, 'Project not found');

    try {
      await this.fileService.writeFile(project.path, relativePath, content);
      ws.send(JSON.stringify({ type: 'file_saved', projectId, path: relativePath }));
    } catch (err) {
      this._sendError(ws, projectId, relativePath, err.message);
    }
  }

  async renameFile(ws, message) {
    const { projectId, path: relativePath, newName } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, relativePath, 'Project not found');

    try {
      const newPath = await this.fileService.renameFile(project.path, relativePath, newName);
      ws.send(JSON.stringify({ type: 'file_renamed', projectId, oldPath: relativePath, newPath: '/' + newPath }));
    } catch (err) {
      this._sendError(ws, projectId, relativePath, err.message);
    }
  }

  async moveFile(ws, message) {
    const { projectId, sourcePath, destDirectory } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, sourcePath, 'Project not found');

    try {
      const newPath = await this.fileService.moveFile(project.path, sourcePath, destDirectory);
      ws.send(JSON.stringify({ type: 'file_moved', projectId, oldPath: sourcePath, newPath: '/' + newPath }));
    } catch (err) {
      this._sendError(ws, projectId, sourcePath, err.message);
    }
  }

  async deleteFile(ws, message) {
    const { projectId, path: relativePath } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, relativePath, 'Project not found');

    try {
      await this.fileService.deleteFile(project.path, relativePath);
      ws.send(JSON.stringify({ type: 'file_deleted', projectId, path: relativePath }));
    } catch (err) {
      this._sendError(ws, projectId, relativePath, err.message);
    }
  }

  async createDirectory(ws, message) {
    const { projectId, parentPath, name } = message;
    const project = this._resolveProject(projectId);
    if (!project) return this._sendError(ws, projectId, parentPath, 'Project not found');

    try {
      const newPath = await this.fileService.createDirectory(project.path, parentPath, name);
      ws.send(JSON.stringify({ type: 'directory_created', projectId, path: '/' + newPath, name }));
    } catch (err) {
      this._sendError(ws, projectId, parentPath, err.message);
    }
  }
}

module.exports = FileHandlers;
