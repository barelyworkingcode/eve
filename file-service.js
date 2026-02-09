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
              } catch (err) {
                // Ignore stat errors
              }
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
      if (err.code === 'ENOENT') {
        throw new Error('Directory not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      }
      throw err;
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

      // Check file size
      if (stats.size > this.maxFileSize) {
        throw new Error(`File too large (max ${this.maxFileSize / 1024 / 1024}MB)`);
      }

      const content = await fs.readFile(fullPath, 'utf8');

      return {
        content,
        size: stats.size
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('File not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      } else if (err.code === 'EISDIR') {
        throw new Error('Path is a directory');
      }
      throw err;
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
      if (err.code === 'ENOENT') {
        throw new Error('Directory not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      } else if (err.code === 'EISDIR') {
        throw new Error('Path is a directory');
      }
      throw err;
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

    // Check if destination already exists
    try {
      await fs.access(newPath);
      throw new Error('A file or directory with that name already exists');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    try {
      await fs.rename(fullPath, newPath);
      // Return the new relative path
      return path.relative(projectPath, newPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('File not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      }
      throw err;
    }
  }

  /**
   * Moves a file or directory to a new location
   */
  async moveFile(projectPath, sourcePath, destDirectory) {
    const fullSourcePath = this.validatePath(projectPath, sourcePath);
    const fullDestDir = this.validatePath(projectPath, destDirectory);

    // Check destination is a directory
    const destStats = await fs.stat(fullDestDir);
    if (!destStats.isDirectory()) {
      throw new Error('Destination must be a directory');
    }

    const fileName = path.basename(fullSourcePath);
    const fullDestPath = path.join(fullDestDir, fileName);

    // Validate destination path is still within project
    if (!fullDestPath.startsWith(path.resolve(projectPath))) {
      throw new Error('Path traversal not allowed');
    }

    // Check if destination already exists
    try {
      await fs.access(fullDestPath);
      throw new Error('A file or directory with that name already exists at destination');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // Prevent moving a directory into itself
    if (fullDestDir.startsWith(fullSourcePath + path.sep)) {
      throw new Error('Cannot move a directory into itself');
    }

    try {
      await fs.rename(fullSourcePath, fullDestPath);
      // Return the new relative path
      return path.relative(projectPath, fullDestPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('Source file not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      }
      throw err;
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
      // trash is ESM-only, must use dynamic import
      const { default: trash } = await import('trash');
      await trash(fullPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('File not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      }
      throw err;
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
      // Return the new relative path
      return path.relative(projectPath, fullPath);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new Error('Directory already exists');
      } else if (err.code === 'ENOENT') {
        throw new Error('Parent directory not found');
      } else if (err.code === 'EACCES') {
        throw new Error('Permission denied');
      }
      throw err;
    }
  }
}

module.exports = FileService;
