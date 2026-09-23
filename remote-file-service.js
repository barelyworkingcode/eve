'use strict';

/**
 * Same method surface as FileService (file-service.js), backed by a
 * HostAgent (ssh-host-pool.js) instead of the local filesystem — the file
 * plane for a project whose `hostId` points at an SSH host
 * (../relay/docs/ssh-hosts.md). Every op sends `root: projectPath` and a
 * root-relative `path` to remote-fs-agent.js, which re-validates containment
 * on its own filesystem; this class only does the *lexical* half (decision 7:
 * "the host agent does the realpath half" — eve can't realpath a path that
 * lives on another machine). Paths are always POSIX here regardless of eve's
 * own OS: a host project's path is absolute-with-forward-slashes by the
 * relay-side validator, and Windows hosts are out of scope for v1.
 */

const path = require('path').posix;

const GIT_ERROR_CODES = new Set(['NOT_A_REPO', 'GIT_MISSING', 'TOO_LARGE', 'TIMEOUT', 'FAILED']);

// Required lazily so a host project that never opens the Changes panel
// doesn't pay for git-service.js at startup.
function loadGitModule() {
  return require('./git-service');
}

class RemoteFileService {
  constructor(hostAgent) {
    this.hostAgent = hostAgent;
  }

  isPathWithin(base, target) {
    const resolvedBase = path.resolve(base);
    return target === resolvedBase || target.startsWith(resolvedBase + '/');
  }

  // Lexical pre-check only. Doubles as the self-write dedupe key: the
  // file-watcher's remote backend resolves an incoming {event, path} frame
  // with this exact same path.resolve(root, relPath) so the two agree on
  // what "the same file" looks like as a string, without either side ever
  // touching the host's real filesystem.
  validatePath(projectPath, relativePath) {
    const normalizedRelative = String(relativePath || '').replace(/^\/+/, '') || '.';
    const resolved = path.resolve(projectPath, normalizedRelative);
    if (!this.isPathWithin(projectPath, resolved)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  async _request(op, params) {
    if (!this.hostAgent) throw new Error('Host is not connected');
    return this.hostAgent.request(op, params);
  }

  async listDirectory(projectPath, relativePath, { showHidden = false } = {}) {
    this.validatePath(projectPath, relativePath || '/');
    const res = await this._request('list', { root: projectPath, path: relativePath || '/', showHidden });
    return res.entries;
  }

  async readFile(projectPath, relativePath) {
    this.validatePath(projectPath, relativePath);
    const res = await this._request('read', { root: projectPath, path: relativePath });
    return { content: res.content, size: res.size };
  }

  async writeFile(projectPath, relativePath, content) {
    this.validatePath(projectPath, relativePath);
    await this._request('write', { root: projectPath, path: relativePath, content });
  }

  async renameFile(projectPath, relativePath, newName) {
    this.validatePath(projectPath, relativePath);
    if (String(newName || '').includes('/') || String(newName || '').includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }
    const res = await this._request('rename', { root: projectPath, path: relativePath, newName });
    return res.path;
  }

  async moveFile(projectPath, sourcePath, destDirectory) {
    this.validatePath(projectPath, sourcePath);
    this.validatePath(projectPath, destDirectory);
    const res = await this._request('move', { root: projectPath, path: sourcePath, destDir: destDirectory });
    return res.path;
  }

  async deleteFile(projectPath, relativePath) {
    this.validatePath(projectPath, relativePath);
    await this._request('delete', { root: projectPath, path: relativePath });
  }

  // Unlike writeFile, does not enforce an extension allowlist — mirrors
  // FileService.uploadFile.
  async uploadFile(projectPath, destDirectory, fileName, content, encoding) {
    if (String(fileName || '').includes('/') || String(fileName || '').includes('\\')) {
      throw new Error('File name cannot contain path separators');
    }
    const relDest = path.join((destDirectory || '/').replace(/^\/+/, '') || '.', fileName);
    this.validatePath(projectPath, relDest);
    if (encoding === 'base64') {
      await this._request('writeb64', { root: projectPath, path: relDest, data: content });
    } else {
      await this._request('write', { root: projectPath, path: relDest, content });
    }
  }

  async createDirectory(projectPath, parentPath, name) {
    this.validatePath(projectPath, parentPath || '/');
    if (String(name || '').includes('/') || String(name || '').includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }
    const res = await this._request('mkdir', { root: projectPath, parent: parentPath, name });
    return res.path;
  }

  // onChunk receives raw Buffers (HostAgent already base64-decodes each
  // `chunk` frame); resolves once the agent's terminal {ok, size} frame lands.
  async stream(projectPath, relativePath, onChunk) {
    this.validatePath(projectPath, relativePath);
    if (!this.hostAgent) throw new Error('Host is not connected');
    const res = await this.hostAgent.stream('stream', { root: projectPath, path: relativePath }, onChunk);
    return { size: res.size };
  }

  // GitService's `run`, backed by the agent's `git` op. The agent resolves
  // `cwd` inside root itself (realpath half); stdout crosses as base64.
  async _gitRun(root, cwdRel, args, { maxBytes } = {}) {
    const { GitError } = loadGitModule();
    if (!this.hostAgent) throw new GitError('FAILED', 'Host is not connected');
    let res;
    try {
      res = await this.hostAgent.request('git', { root, cwd: cwdRel, args, maxBytes });
    } catch (err) {
      // The agent reports a missing/non-directory cwd as NO_DIR — the local
      // runner calls that NOT_A_REPO.
      const raw = err && err.code === 'NO_DIR' ? 'NOT_A_REPO' : err && err.code;
      const code = GIT_ERROR_CODES.has(raw) ? raw : 'FAILED';
      throw new GitError(code, (err && err.message) || 'git failed on host');
    }
    return { code: res.code, stdout: Buffer.from(res.stdout || '', 'base64'), stderr: res.stderr || '' };
  }

  // Mirrors FileService#_readFileForGit: the agent's `read` enforces the diff
  // pane's 2 MB cap itself, so an oversize file never crosses SSH. Its
  // TOO_LARGE reply carries no size; one `stat` round-trip (only on that path)
  // recovers it for the pane.
  async _readFileForGit(projectPath, relativePath) {
    const { GitService, GitError } = loadGitModule();
    this.validatePath(projectPath, relativePath);
    try {
      const res = await this._request('read', { root: projectPath, path: relativePath, maxBytes: GitService.FILE_MAX_BYTES });
      return { content: res.content, size: res.size };
    } catch (err) {
      if (!err || err.code !== 'TOO_LARGE') throw err;
      const tooLarge = new GitError('TOO_LARGE', 'File too large to diff');
      try {
        const st = await this._request('stat', { root: projectPath, path: relativePath });
        tooLarge.size = st.size;
      } catch { /* size stays unknown */ }
      throw tooLarge;
    }
  }

  _git() {
    if (!this._gitService) {
      const { GitService } = loadGitModule();
      this._gitService = new GitService({
        run: (root, cwdRel, args, opts) => this._gitRun(root, cwdRel, args, opts),
        listDirectory: (root, rel, opts) => this.listDirectory(root, rel, opts),
        readFile: (root, rel) => this._readFileForGit(root, rel),
      });
    }
    return this._gitService;
  }

  async gitRepos(projectPath) {
    this.validatePath(projectPath, '/');
    return this._git().repos(projectPath);
  }

  async gitStatus(projectPath, repoPath, scope) {
    this.validatePath(projectPath, repoPath);
    return this._git().status(projectPath, repoPath, scope);
  }

  async gitFileVersions(projectPath, repoPath, filePath, scope) {
    this.validatePath(projectPath, repoPath);
    const repoRel = String(repoPath || '').replace(/^\/+/, '');
    this.validatePath(projectPath, path.join(repoRel || '.', String(filePath || '')));
    return this._git().fileVersions(projectPath, repoPath, filePath, scope);
  }
}

module.exports = RemoteFileService;
