const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class FileService {
  constructor() {
    this.maxFileSize = 10 * 1024 * 1024;

    this.allowedExtensions = new Set([
      'txt', 'md', 'json', 'yaml', 'yml', 'js', 'ts', 'jsx', 'tsx',
      'css', 'scss', 'html', 'xml', 'svg', 'py', 'rb', 'go', 'rs',
      'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'sql', 'toml',
      'ini', 'env', 'conf', 'config', 'lock', 'gitignore', 'log'
    ]);
  }

  // Must compare with a trailing separator so a project at `/home/u/proj`
  // does NOT match a sibling `/home/u/proj-secrets` — a bare
  // `startsWith(base)` prefix check is a path-traversal hole.
  // See docs/security-audit-frontend.md (H1).
  isPathWithin(base, target) {
    const resolvedBase = path.resolve(base);
    return target === resolvedBase || target.startsWith(resolvedBase + path.sep);
  }

  _isWithin(base, target) {
    return this.isPathWithin(base, target);
  }

  // Resolves symlinks on the longest *existing* prefix of `p` and re-appends
  // the not-yet-existing tail — a path component that doesn't exist on disk
  // can't itself be a symlink, so this is sufficient even when `p` doesn't
  // exist yet (new file/dir). Only ENOENT is swallowed during the walk.
  _realpathExistingPrefix(p) {
    let current = path.resolve(p);
    const tail = [];
    for (;;) {
      try {
        const real = fsSync.realpathSync(current);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(p); // chain has no existing ancestor
        tail.push(path.basename(current));
        current = parent;
      }
    }
  }

  validatePath(projectPath, relativePath) {
    // Strip leading slashes so path.resolve doesn't treat relativePath as absolute
    // (which would discard projectPath entirely).
    const normalizedRelative = relativePath.replace(/^\/+/, '') || '.';
    const resolved = path.resolve(projectPath, normalizedRelative);

    if (!this._isWithin(projectPath, resolved)) {
      throw new Error('Path traversal not allowed');
    }

    // The lexical check above only sees the textual path, so a symlink
    // *inside* the project pointing outside it (e.g. `proj/link -> /etc`)
    // would slip past — recheck containment in realpath space. Comparing
    // realRoot vs realResolved (not projectPath vs realResolved) is required
    // so a project living under a symlinked ancestor (e.g. macOS `/var` ->
    // `/private/var`) isn't false-flagged. Mirrors module-service.js resolveModuleFile().
    const realRoot = this._realpathExistingPrefix(projectPath);
    const realResolved = this._realpathExistingPrefix(resolved);
    if (!this._isWithin(realRoot, realResolved)) {
      throw new Error('Path traversal not allowed');
    }

    return resolved;
  }

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

  async _assertNotExists(fullPath, message = 'Already exists') {
    try {
      await fs.access(fullPath);
      throw new Error(message);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  isAllowedFile(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return this.allowedExtensions.has(ext) || !ext; // Allow extensionless files
  }

  async listDirectory(projectPath, relativePath, { showHidden = false } = {}) {
    const fullPath = this.validatePath(projectPath, relativePath);

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      const items = await Promise.all(
        entries
          .filter(entry => showHidden || !entry.name.startsWith('.'))
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

  async readFile(projectPath, relativePath) {
    const fullPath = this.validatePath(projectPath, relativePath);

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

  async writeFile(projectPath, relativePath, content) {
    const fullPath = this.validatePath(projectPath, relativePath);

    if (!this.isAllowedFile(fullPath)) {
      throw new Error('File type not allowed for editing');
    }

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

  async renameFile(projectPath, relativePath, newName) {
    const fullPath = this.validatePath(projectPath, relativePath);

    if (newName.includes('/') || newName.includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }

    const stats = await fs.stat(fullPath);
    if (stats.isFile() && !this.isAllowedFile(newName)) {
      throw new Error('File type not allowed');
    }

    const dir = path.dirname(fullPath);
    const newPath = path.join(dir, newName);

    if (!this._isWithin(projectPath, newPath)) {
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

  async moveFile(projectPath, sourcePath, destDirectory) {
    const fullSourcePath = this.validatePath(projectPath, sourcePath);
    const fullDestDir = this.validatePath(projectPath, destDirectory);

    const destStats = await fs.stat(fullDestDir);
    if (!destStats.isDirectory()) {
      throw new Error('Destination must be a directory');
    }

    const fileName = path.basename(fullSourcePath);
    const fullDestPath = path.join(fullDestDir, fileName);

    if (!this._isWithin(projectPath, fullDestPath)) {
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

  // Moves to system trash rather than permanently deleting.
  async deleteFile(projectPath, relativePath) {
    const fullPath = this.validatePath(projectPath, relativePath);

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

  // Unlike writeFile, does not enforce allowedExtensions.
  async uploadFile(projectPath, destDirectory, fileName, content, encoding) {
    const fullDestDir = this.validatePath(projectPath, destDirectory);

    if (fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('File name cannot contain path separators');
    }

    const fullPath = path.join(fullDestDir, fileName);

    if (!this._isWithin(projectPath, fullPath)) {
      throw new Error('Path traversal not allowed');
    }

    // rawSize estimates decoded size so the 10MB cap applies to actual bytes,
    // not the ~33% larger base64 text.
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

  async createDirectory(projectPath, parentPath, name) {
    const fullParentPath = this.validatePath(projectPath, parentPath);

    if (name.includes('/') || name.includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }

    const fullPath = path.join(fullParentPath, name);

    if (!this._isWithin(projectPath, fullPath)) {
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
