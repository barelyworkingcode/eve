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
}

module.exports = FileService;
