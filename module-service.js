const fs = require('fs').promises;
const path = require('path');
const FileService = require('./file-service');

const MODULES_DIRNAME = 'modules';
const MANIFEST_FILENAME = 'module.json';
const MODULE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

class ModuleError extends Error {
  constructor(message, code = 'MODULE_ERROR') {
    super(message);
    this.name = 'ModuleError';
    this.code = code;
  }
}

class ModuleService {
  constructor(fileService) {
    this.fileService = fileService || new FileService();
  }

  /**
   * Lists all modules in <projectPath>/modules/.
   * Surfaces broken manifests in-line (with `broken: true`) so the UI can
   * show them instead of silently dropping them.
   *
   * No caching: directory-mtime invalidation misses edits inside existing
   * subdirs (POSIX semantics), and `module.json` is the file AI agents edit
   * most often. The N small JSON reads in parallel are cheap.
   */
  async listModules(projectPath) {
    const modulesDir = path.join(path.resolve(projectPath), MODULES_DIRNAME);

    let entries;
    try {
      entries = await fs.readdir(modulesDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
      throw err;
    }

    const candidates = entries.filter(e =>
      e.isDirectory() && !e.name.startsWith('.') && MODULE_NAME_RE.test(e.name)
    );

    const modules = await Promise.all(candidates.map(entry =>
      this._loadManifest(projectPath, entry.name)
        .then(m => this.publicView(m))
        .catch(err => ({ name: entry.name, displayName: entry.name, error: err.message, broken: true }))
    ));

    modules.sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name)
    );
    return modules;
  }

  /**
   * Loads and validates a single module's manifest. Throws on missing or invalid.
   */
  async getModule(projectPath, moduleName) {
    if (!MODULE_NAME_RE.test(moduleName)) {
      throw new Error(`Invalid module name: ${moduleName}`);
    }
    return this._loadManifest(projectPath, moduleName);
  }

  /**
   * Resolves a path inside <projectPath>/modules/<moduleName>/.
   * Returns the realpath (symlinks resolved) and rejects anything that
   * escapes the module folder. Route handlers branch on the error `code`s
   * below to pick HTTP status (403 for traversal/symlink, 404 for ENOENT).
   */
  async resolveModuleFile(projectPath, moduleName, relPath) {
    if (!MODULE_NAME_RE.test(moduleName)) {
      throw new Error(`Invalid module name: ${moduleName}`);
    }
    const moduleRoot = path.resolve(projectPath, MODULES_DIRNAME, moduleName);
    const stripped = (relPath || '').replace(/^\/+/, '') || 'index.html';
    const candidate = path.resolve(moduleRoot, stripped);
    if (!candidate.startsWith(moduleRoot + path.sep) && candidate !== moduleRoot) {
      throw new ModuleError('Path traversal not allowed', 'PATH_TRAVERSAL');
    }

    // realpath defeats symlinks pointing outside the module folder.
    let real;
    try {
      real = await fs.realpath(candidate);
    } catch (err) {
      if (err.code === 'ENOENT') throw new ModuleError('File not found', 'ENOENT');
      throw err;
    }
    const realRoot = await fs.realpath(moduleRoot);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      throw new ModuleError('Symlink escape blocked', 'SYMLINK_ESCAPE');
    }
    return real;
  }

  /**
   * Checks that `relProjectPath` is in the module's declared permissions.files
   * list. Paths are compared as normalized project-relative strings.
   */
  isFilePermitted(manifest, relProjectPath) {
    const list = manifest?.permissions?.files;
    if (!Array.isArray(list)) return false;
    const norm = this._normalizeRel(relProjectPath);
    return list.some(p => this._normalizeRel(p) === norm);
  }

  _normalizeRel(p) {
    return String(p || '').replace(/^\.?\/+/, '').replace(/\\/g, '/').trim();
  }

  // --- Internals ---

  async _loadManifest(projectPath, moduleName) {
    const manifestPath = path.resolve(
      projectPath, MODULES_DIRNAME, moduleName, MANIFEST_FILENAME
    );

    let raw;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new ModuleError(`Missing ${MANIFEST_FILENAME}`, 'MISSING_MANIFEST');
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in ${MANIFEST_FILENAME}: ${err.message}`);
    }

    this._validateManifest(parsed, moduleName);
    parsed.name = moduleName; // canonical — directory name always wins
    return parsed;
  }

  // Schema validation. The traversal check on `permissions.files` is
  // load-bearing — entries are trusted later in route handlers to permit
  // file reads/writes without re-validating against the project root.
  _validateManifest(m, dirName) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new Error('Manifest must be a JSON object');
    }
    if (m.name !== undefined && m.name !== dirName) {
      throw new Error(`Manifest name "${m.name}" does not match directory "${dirName}"`);
    }
    if (typeof m.displayName !== 'string' || !m.displayName.trim()) {
      throw new Error('displayName is required (non-empty string)');
    }
    if (m.entry !== undefined) {
      if (typeof m.entry !== 'string' || !m.entry.endsWith('.html')) {
        throw new Error('entry must be a string ending in .html');
      }
      if (m.entry.includes('..') || m.entry.startsWith('/')) {
        throw new Error('entry must be a module-relative path');
      }
    }
    if (m.model !== undefined && typeof m.model !== 'string') {
      throw new Error('model must be a string');
    }
    if (m.permissions !== undefined) {
      if (typeof m.permissions !== 'object' || m.permissions === null || Array.isArray(m.permissions)) {
        throw new Error('permissions must be an object');
      }
      if (m.permissions.files !== undefined) {
        if (!Array.isArray(m.permissions.files)) {
          throw new Error('permissions.files must be an array');
        }
        for (const p of m.permissions.files) {
          if (typeof p !== 'string') {
            throw new Error('permissions.files entries must be strings');
          }
          if (p.includes('..') || p.startsWith('/')) {
            throw new Error(`permissions.files entry "${p}" must be project-relative`);
          }
        }
      }
    }
  }

  publicView(manifest) {
    return {
      name: manifest.name,
      displayName: manifest.displayName,
      entry: manifest.entry || 'index.html',
      model: manifest.model || null,
      permissions: {
        files: (manifest.permissions?.files || []).slice(),
      },
    };
  }
}

module.exports = ModuleService;
module.exports.ModuleError = ModuleError;
module.exports.MODULES_DIRNAME = MODULES_DIRNAME;
module.exports.MANIFEST_FILENAME = MANIFEST_FILENAME;
