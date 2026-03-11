const fs = require('fs').promises;
const path = require('path');

class FileService {
  constructor() {
    this.maxFileSize = 10 * 1024 * 1024; // 10MB

    this.allowedExtensions = new Set([
      'txt', 'md', 'json', 'yaml', 'yml', 'js', 'ts', 'jsx', 'tsx',
      'css', 'scss', 'html', 'xml', 'svg', 'py', 'rb', 'go', 'rs',
      'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'sql', 'toml',
      'ini', 'env', 'conf', 'config', 'lock', 'gitignore', 'log'
    ]);
  }

  /**
   * Validates and resolves a path within project directory
   * CRITICAL: Prevents path traversal attacks
   */
  validatePath(projectPath, relativePath) {
    // Normalize the relative path - strip leading slashes to prevent path.resolve
    // from treating it as an absolute path
    const normalizedRelative = relativePath.replace(/^\/+/, '') || '.';
    const resolved = path.resolve(projectPath, normalizedRelative);

    // Must be within project directory
    if (!resolved.startsWith(path.resolve(projectPath))) {
      throw new Error('Path traversal not allowed');
    }

    return resolved;
  }

  /**
   * Converts filesystem error codes to user-friendly messages.
   * Custom overrides can be provided per error code.
   */
  _handleFsError(err, overrides = {}) {
    const messages = {
      ENOENT: 'File not found',
      EACCES: 'Permission denied',
      EISDIR: 'Path is a directory',
      EEXIST: 'Already exists',
      ...overrides
    };
    const msg = messages[err.code];
    if (msg) throw new Error(msg);
    throw err;
  }

  /**
   * Throws if the path already exists.
   */
  async _assertNotExists(fullPath, message = 'Already exists') {
    try {
      await fs.access(fullPath);
      throw new Error(message);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Checks if file extension is allowed for editing
   */
  isAllowedFile(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return this.allowedExtensions.has(ext) || !ext; // Allow extensionless files
  }

  /**
   * Lists directory contents
   */
  async listDirectory(projectPath, relativePath) {
    const fullPath = this.validatePath(projectPath, relativePath);

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      const items = await Promise.all(
        entries
          .filter(entry => !entry.name.startsWith('.')) // Hide dotfiles
          .map(async (entry) => {
            const itemPath = path.join(fullPath, entry.name);
            let size = 0;

            if (entry.isFile()) {
              try {
                const stats = await fs.stat(itemPath);
                size = stats.size;
              } catch (_) {}
            }

            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size
            };
          })
      );

      // Sort: directories first, then alphabetically
      items.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return items;
    } catch (err) {
      this._handleFsError(err, { ENOENT: 'Directory not found' });
    }
  }

  /**
   * Reads file content
   */
  async readFile(projectPath, relativePath) {
    const fullPath = this.validatePath(projectPath, relativePath);

    // Check if file extension is allowed
    if (!this.isAllowedFile(fullPath)) {
      throw new Error('File type not allowed for editing');
    }

    try {
      const stats = await fs.stat(fullPath);

      if (stats.size > this.maxFileSize) {
        throw new Error(`File too large (max ${this.maxFileSize / 1024 / 1024}MB)`);
      }

      const content = await fs.readFile(fullPath, 'utf8');
      return { content, size: stats.size };
    } catch (err) {
      this._handleFsError(err);
    }
  }

  /**
   * Writes file content
   */
  async writeFile(projectPath, relativePath, content) {
    const fullPath = this.validatePath(projectPath, relativePath);

    // Check if file extension is allowed
    if (!this.isAllowedFile(fullPath)) {
      throw new Error('File type not allowed for editing');
    }

    // Check content size
    const contentSize = Buffer.byteLength(content, 'utf8');
    if (contentSize > this.maxFileSize) {
      throw new Error(`Content too large (max ${this.maxFileSize / 1024 / 1024}MB)`);
    }

    try {
      await fs.writeFile(fullPath, content, 'utf8');
    } catch (err) {
      this._handleFsError(err, { ENOENT: 'Directory not found' });
    }
  }

  /**
   * Renames a file or directory
   */
  async renameFile(projectPath, relativePath, newName) {
    const fullPath = this.validatePath(projectPath, relativePath);

    // Reject names with path separators
    if (newName.includes('/') || newName.includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }

    // Check extension for files (not directories)
    const stats = await fs.stat(fullPath);
    if (stats.isFile() && !this.isAllowedFile(newName)) {
      throw new Error('File type not allowed');
    }

    // Build new path
    const dir = path.dirname(fullPath);
    const newPath = path.join(dir, newName);

    // Validate new path is still within project
    if (!newPath.startsWith(path.resolve(projectPath))) {
      throw new Error('Path traversal not allowed');
    }

    await this._assertNotExists(newPath, 'A file or directory with that name already exists');

    try {
      await fs.rename(fullPath, newPath);
      return path.relative(projectPath, newPath);
    } catch (err) {
      this._handleFsError(err);
    }
  }

  /**
   * Moves a file or directory to a new location
   */
  async moveFile(projectPath, sourcePath, destDirectory) {
    const fullSourcePath = this.validatePath(projectPath, sourcePath);
    const fullDestDir = this.validatePath(projectPath, destDirectory);

    const destStats = await fs.stat(fullDestDir);
    if (!destStats.isDirectory()) {
      throw new Error('Destination must be a directory');
    }

    const fileName = path.basename(fullSourcePath);
    const fullDestPath = path.join(fullDestDir, fileName);

    if (!fullDestPath.startsWith(path.resolve(projectPath))) {
      throw new Error('Path traversal not allowed');
    }

    await this._assertNotExists(fullDestPath, 'A file or directory with that name already exists at destination');

    if (fullDestDir.startsWith(fullSourcePath + path.sep)) {
      throw new Error('Cannot move a directory into itself');
    }

    try {
      await fs.rename(fullSourcePath, fullDestPath);
      return path.relative(projectPath, fullDestPath);
    } catch (err) {
      this._handleFsError(err, { ENOENT: 'Source file not found' });
    }
  }

  /**
   * Deletes a file or directory (moves to system trash)
   */
  async deleteFile(projectPath, relativePath) {
    const fullPath = this.validatePath(projectPath, relativePath);

    // Prevent deleting the project root
    if (fullPath === path.resolve(projectPath)) {
      throw new Error('Cannot delete project root');
    }

    try {
      await fs.access(fullPath);
      const { default: trash } = await import('trash');
      await trash(fullPath);
    } catch (err) {
      this._handleFsError(err);
    }
  }

  /**
   * Uploads a file (any type) to a directory.
   * Unlike writeFile, does not enforce allowedExtensions.
   */
  async uploadFile(projectPath, destDirectory, fileName, content, encoding) {
    const fullDestDir = this.validatePath(projectPath, destDirectory);

    // Reject path separators in fileName
    if (fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('File name cannot contain path separators');
    }

    // Reject dotfiles
    if (fileName.startsWith('.')) {
      throw new Error('Cannot upload dotfiles');
    }

    const fullPath = path.join(fullDestDir, fileName);

    // Validate resolved path is within project
    if (!fullPath.startsWith(path.resolve(projectPath))) {
      throw new Error('Path traversal not allowed');
    }

    // Size limit (10MB, accounting for base64 ~33% overhead)
    const maxUploadSize = this.maxFileSize;
    const rawSize = encoding === 'base64'
      ? Math.ceil(content.length * 3 / 4)
      : Buffer.byteLength(content, 'utf8');
    if (rawSize > maxUploadSize) {
      throw new Error(`File too large (max ${maxUploadSize / 1024 / 1024}MB)`);
    }

    await this._assertNotExists(fullPath, 'A file with that name already exists');

    try {
      if (encoding === 'base64') {
        await fs.writeFile(fullPath, Buffer.from(content, 'base64'));
      } else {
        await fs.writeFile(fullPath, content, 'utf8');
      }
    } catch (err) {
      this._handleFsError(err, { ENOENT: 'Destination directory not found' });
    }
  }

  /**
   * Creates a new directory
   */
  async createDirectory(projectPath, parentPath, name) {
    const fullParentPath = this.validatePath(projectPath, parentPath);

    // Reject names with path separators
    if (name.includes('/') || name.includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }

    const fullPath = path.join(fullParentPath, name);

    // Validate new path is still within project
    if (!fullPath.startsWith(path.resolve(projectPath))) {
      throw new Error('Path traversal not allowed');
    }

    try {
      await fs.mkdir(fullPath);
      return path.relative(projectPath, fullPath);
    } catch (err) {
      this._handleFsError(err, {
        EEXIST: 'Directory already exists',
        ENOENT: 'Parent directory not found'
      });
    }
  }
}

module.exports = FileService;
