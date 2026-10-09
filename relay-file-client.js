'use strict';

/**
 * The only way eve reaches a project's files. Every operation is a route on
 * relay's frontend socket (docs/project-files.md in relay) sent through
 * RelayTransport; change notifications and host status arrive on one
 * WebSocket, /ws/files, that relay owns. Console and SSH-host projects look
 * the same from here: relay picks the backend.
 *
 *   RelayFileClient  one per eve process: the /ws/files socket (capped
 *                    reconnect, ref-counted watches, latest host status) and
 *                    the HTTP calls.
 *   ProjectFiles     one per project: FileService's method surface and return
 *                    shapes, so the handlers, routes and watcher never learn
 *                    that the disk moved to another process.
 *
 * Deliberately no `fs` or `child_process` here: see test/unit/file-plane-guard.test.js.
 */

const EventEmitter = require('events');
const path = require('path').posix;

const { NullLogger } = require('./logger');
const { GitService, GitError } = require('./git-service');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_LEN = 1000;
const MAX_GLOBS = 5;
const MAX_GLOB_LEN = 200;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const WS_OPEN = 1;
const ERROR_BODY_LIMIT = 64 * 1024;

// Editor extension allowlist: console projects only (a host project never had
// one). Extensionless files are allowed.
const ALLOWED_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'js', 'ts', 'jsx', 'tsx',
  'css', 'scss', 'html', 'xml', 'svg', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'sql', 'toml',
  'ini', 'env', 'conf', 'config', 'lock', 'gitignore', 'log',
]);

const MESSAGES = {
  ENOENT: 'File not found',
  EACCES: 'Permission denied',
  EISDIR: 'Path is a directory',
  ENOTDIR: 'Not a directory',
  EEXIST: 'Already exists',
  TRAVERSAL: 'Path traversal not allowed',
  TOO_LARGE: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`,
  SYMLINK: 'Symbolic links are not opened',
  READ_ONLY: 'This project is read-only',
  RELAY_DOWN: 'Relay is not reachable',
  PROJECT_NOT_FOUND: 'Project not found',
  TIMEOUT: 'Request timed out',
};

// The per-operation texts FileService used, so a file_error reads the same.
const OP_MESSAGES = {
  list: { ENOENT: 'Directory not found' },
  write: { ENOENT: 'Directory not found' },
  rename: { EEXIST: 'A file or directory with that name already exists' },
  move: {
    ENOENT: 'Source file not found',
    ENOTDIR: 'Destination must be a directory',
    EEXIST: 'A file or directory with that name already exists at destination',
  },
  upload: {
    ENOENT: 'Destination directory not found',
    EEXIST: 'A file with that name already exists',
  },
  mkdir: { EEXIST: 'Directory already exists', ENOENT: 'Parent directory not found' },
};

function coded(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

// What a person reads for `code` when running `op` against `project`.
function messageFor(op, code, relayMessage, hostName) {
  if (code === 'HOST_UNREACHABLE') return `Host "${hostName}" is not connected`;
  const perOp = OP_MESSAGES[op] && OP_MESSAGES[op][code];
  return perOp || MESSAGES[code] || relayMessage || code || 'File operation failed';
}

function isAllowedFile(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) || !ext;
}

class RelayFileClient extends EventEmitter {
  /**
   * relayTransport  the RelayTransport (fetch, stream, createWebSocket)
   * timers          { setTimeout, clearTimeout }: injected so a test drives the
   *                 reconnect backoff with fake timers
   * now             () => ms, for search durations
   * Events: 'fs_event' {projectId,path,kind}, 'watch_ok' {projectId},
   *         'watch_error' {projectId,code,error}, 'host_status' {hostId,name,status,error}
   */
  constructor({ relayTransport, log, timers, now } = {}) {
    super();
    // One FileWatcher listens per browser connection.
    this.setMaxListeners(0);
    this.relayTransport = relayTransport;
    this.log = log || new NullLogger();
    this._timers = timers || { setTimeout, clearTimeout };
    this._now = now || Date.now;

    this._started = false;
    this._ws = null;
    this._open = false;
    this._attempts = 0;
    this._reconnectTimer = null;
    this._watched = new Map(); // projectId -> number of holders
    this._hostStatuses = new Map(); // hostId -> {hostId,name,status,error?}
    this._projectFiles = new Map();
  }

  // ---- /ws/files ----

  start() {
    if (this._started) return;
    this._started = true;
    this._connect();
  }

  close() {
    this._started = false;
    if (this._reconnectTimer) {
      this._timers.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const ws = this._ws;
    this._ws = null;
    this._open = false;
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  _connect() {
    let ws;
    try {
      ws = this.relayTransport.createWebSocket('/ws/files');
    } catch (err) {
      this.log.warn(`/ws/files: cannot open (${err.message})`);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    ws.on('open', () => {
      if (ws !== this._ws) return;
      this._open = true;
      this._attempts = 0;
      // Relay forgets a connection's watches when it drops, so say again what
      // is still wanted. No catch-up for changes missed while away.
      for (const projectId of this._watched.keys()) this._send({ type: 'watch', project_id: projectId });
    });
    ws.on('message', (raw) => {
      if (ws === this._ws) this._onFrame(raw);
    });
    ws.on('error', (err) => {
      if (ws === this._ws) this.log.warn(`/ws/files: ${err && err.message}`);
    });
    ws.on('close', () => {
      if (ws !== this._ws) return;
      this._ws = null;
      this._open = false;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (!this._started || this._reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this._attempts);
    this._attempts += 1;
    const timer = this._timers.setTimeout(() => {
      this._reconnectTimer = null;
      if (this._started) this._connect();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._reconnectTimer = timer;
  }

  _send(frame) {
    if (!this._open || !this._ws) return;
    try { this._ws.send(JSON.stringify(frame)); } catch (err) {
      this.log.warn(`/ws/files: send failed (${err.message})`);
    }
  }

  _onFrame(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'fs_event':
        if (typeof msg.project_id === 'string' && typeof msg.path === 'string') {
          this.emit('fs_event', { projectId: msg.project_id, path: msg.path, kind: msg.kind === 'change' ? 'change' : 'rename' });
        }
        break;
      case 'watch_ok':
        this.emit('watch_ok', { projectId: msg.project_id });
        break;
      case 'watch_error':
        this.emit('watch_error', { projectId: msg.project_id, code: msg.code || 'ERROR', error: msg.error });
        break;
      case 'host_status': {
        const evt = { hostId: msg.host_id, name: msg.name, status: msg.status };
        if (msg.error) evt.error = msg.error;
        this._hostStatuses.set(evt.hostId, evt);
        this.emit('host_status', evt);
        break;
      }
      default: // unknown frame types are ignored
    }
  }

  // Ref-counted across every holder (one per browser connection): relay is
  // told on the first, and again on the last unwatch.
  watch(projectId) {
    const n = this._watched.get(projectId) || 0;
    this._watched.set(projectId, n + 1);
    if (n === 0) this._send({ type: 'watch', project_id: projectId });
  }

  unwatch(projectId) {
    const n = this._watched.get(projectId);
    if (!n) return;
    if (n > 1) {
      this._watched.set(projectId, n - 1);
      return;
    }
    this._watched.delete(projectId);
    this._send({ type: 'unwatch', project_id: projectId });
  }

  hostStatuses() {
    return [...this._hostStatuses.values()].map((s) => ({ ...s }));
  }

  // ---- HTTP ----

  // Resolves the response data; rejects with {code, message, size} (relay's
  // own words) or code RELAY_DOWN when relay cannot be reached at all.
  async _request(method, urlPath, body, { signal } = {}) {
    let res;
    try {
      res = await this.relayTransport.fetch(method, urlPath, body, { signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw coded('RELAY_DOWN', MESSAGES.RELAY_DOWN, { cause: err });
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    throw this._failureFrom(res.status, res.data);
  }

  _failureFrom(status, data) {
    const obj = data && typeof data === 'object' ? data : {};
    const extra = {};
    if (obj.size !== undefined) extra.size = obj.size;
    extra.status = status;
    return coded(typeof obj.code === 'string' ? obj.code : 'ERROR',
      typeof obj.error === 'string' ? obj.error : `Relay answered ${status}`, extra);
  }

  _call(projectId, op, body, opts) {
    return this._request('POST', `/api/projects/${encodeURIComponent(projectId)}/files/${op}`, body, opts);
  }

  async pasteToHost(hostId, name, buffer) {
    const data = await this._request('POST', `/api/hosts/${encodeURIComponent(hostId)}/pastetmp`,
      { name, data_b64: buffer.toString('base64') });
    return data.path;
  }

  forProject(project) {
    const key = `${project.id}\0${project.path}\0${project.hostId || ''}`;
    let pf = this._projectFiles.get(key);
    if (!pf) {
      pf = new ProjectFiles(this, project);
      this._projectFiles.set(key, pf);
    } else {
      pf.project = project; // the host's display name can change under the same key
    }
    return pf;
  }
}

class ProjectFiles {
  constructor(client, project) {
    this.client = client;
    this.project = project;
    this._gitService = null;
  }

  get _console() { return !this.project.hostId; }

  // ---- paths: lexical and string-only; relay does the rest ----

  isPathWithin(base, target) {
    const resolvedBase = path.resolve('/', String(base || '/'));
    return target === resolvedBase || target.startsWith(resolvedBase === '/' ? '/' : resolvedBase + '/');
  }

  // Also the self-write dedupe key: ws/file-messages.js and the watcher both
  // derive it here, so the two agree on what "the same file" looks like.
  validatePath(projectPath, relativePath) {
    const base = path.resolve('/', String(projectPath || '/'));
    const normalized = String(relativePath || '').replace(/^\/+/, '') || '.';
    const resolved = path.resolve(base, normalized);
    if (!this.isPathWithin(base, resolved)) {
      throw coded('TRAVERSAL', MESSAGES.TRAVERSAL);
    }
    return resolved;
  }

  // Root-relative, no leading slash; '' is the root. What goes on the wire.
  _rel(projectPath, relativePath) {
    const base = path.resolve('/', String(projectPath || '/'));
    const rel = path.relative(base, this.validatePath(projectPath, relativePath));
    return rel === '.' ? '' : rel;
  }

  // ---- plumbing ----

  async _do(op, apiOp, body, opts) {
    try {
      return await this.client._call(this.project.id, apiOp, body, opts);
    } catch (err) {
      throw this._friendly(op, err);
    }
  }

  _friendly(op, err) {
    if (isAbort(err)) return err;
    const hostName = (this.project.host && this.project.host.name) || this.project.hostId;
    const out = coded(err.code || 'ERROR', messageFor(op, err.code, err.message, hostName));
    if (err.size !== undefined) out.size = err.size;
    return out;
  }

  // ---- FileService's surface ----

  async listDirectory(projectPath, relativePath, { showHidden = false } = {}) {
    const rel = this._rel(projectPath, relativePath || '/');
    const res = await this._do('list', 'list', { path: rel, show_hidden: !!showHidden });
    const items = (res.entries || []).map((e) => ({
      name: e.name,
      // A link is never followed, so the tree shows it as a plain file; opening
      // it answers "Symbolic links are not opened".
      type: e.type === 'directory' ? 'directory' : 'file',
      size: e.size || 0,
      mtime: e.mtime_ms,
    }));
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  async readFile(projectPath, relativePath) {
    const rel = this._rel(projectPath, relativePath);
    if (this._console && !isAllowedFile(rel)) throw new Error('File type not allowed for editing');
    const res = await this._do('read', 'read', { path: rel, max_bytes: MAX_FILE_BYTES });
    return { content: res.content, size: res.size };
  }

  async writeFile(projectPath, relativePath, content) {
    const rel = this._rel(projectPath, relativePath);
    if (this._console && !isAllowedFile(rel)) throw new Error('File type not allowed for editing');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`Content too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
    }
    await this._do('write', 'write', { path: rel, content, encoding: 'utf8', create_only: false });
  }

  async renameFile(projectPath, relativePath, newName) {
    const rel = this._rel(projectPath, relativePath);
    if (String(newName || '').includes('/') || String(newName || '').includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }
    if (this._console) {
      const st = await this.stat(projectPath, relativePath);
      if (st.type === 'file' && !isAllowedFile(newName)) throw new Error('File type not allowed');
    }
    const res = await this._do('rename', 'rename', { path: rel, new_name: newName });
    return res.path;
  }

  async moveFile(projectPath, sourcePath, destDirectory) {
    const src = this._rel(projectPath, sourcePath);
    const dest = this._rel(projectPath, destDirectory);
    if (src !== '' && (dest === src || dest.startsWith(src + '/'))) {
      throw new Error('Cannot move a directory into itself');
    }
    const res = await this._do('move', 'move', { path: src, dest_dir: dest });
    return res.path;
  }

  async deleteFile(projectPath, relativePath) {
    const rel = this._rel(projectPath, relativePath);
    if (rel === '') throw new Error('Cannot delete project root');
    await this._do('delete', 'delete', { path: rel });
  }

  // Unlike writeFile, no extension allowlist. Every upload is create_only, so
  // an existing file is refused on console and host projects alike.
  async uploadFile(projectPath, destDirectory, fileName, content, encoding) {
    if (String(fileName || '').includes('/') || String(fileName || '').includes('\\')) {
      throw new Error('File name cannot contain path separators');
    }
    if (!fileName || fileName === '.' || fileName === '..') throw new Error('Invalid file name');
    const dir = this._rel(projectPath, destDirectory || '/');
    const rel = this._rel(projectPath, path.join('/', dir, String(fileName || '')));
    // rawSize estimates the decoded size so the cap applies to real bytes.
    const rawSize = encoding === 'base64'
      ? Math.ceil(content.length * 3 / 4)
      : Buffer.byteLength(content, 'utf8');
    if (rawSize > MAX_FILE_BYTES) throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
    await this._do('upload', 'write', {
      path: rel, content, encoding: encoding === 'base64' ? 'base64' : 'utf8', create_only: true,
    });
  }

  async createDirectory(projectPath, parentPath, name) {
    const parent = this._rel(projectPath, parentPath || '/');
    if (String(name || '').includes('/') || String(name || '').includes('\\')) {
      throw new Error('Name cannot contain path separators');
    }
    const res = await this._do('mkdir', 'mkdir', { parent, name });
    return res.path;
  }

  async stat(projectPath, relativePath) {
    const rel = this._rel(projectPath, relativePath || '/');
    const res = await this._do('stat', 'stat', { path: rel });
    return { type: res.type, size: res.size, mtime: res.mtime_ms };
  }

  // Raw bytes, never buffered here. Console: relay answers Range with 206.
  // Host: relay streams the whole file and ignores Range. A 416 is returned
  // as is, so the caller can pass it on.
  async openStream(projectPath, relativePath, { range } = {}) {
    const rel = this._rel(projectPath, relativePath);
    const url = `/api/projects/${encodeURIComponent(this.project.id)}/files/stream?path=${encodeURIComponent(rel)}`;
    let res;
    try {
      res = await this.client.relayTransport.stream('GET', url, { headers: range ? { Range: range } : {} });
    } catch (err) {
      throw this._friendly('stream', coded('RELAY_DOWN', MESSAGES.RELAY_DOWN, { cause: err }));
    }
    if (res.status >= 400 && res.status !== 416) {
      const text = await readLimited(res.body, ERROR_BODY_LIMIT);
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      throw this._friendly('stream', this.client._failureFrom(res.status, data));
    }
    return { status: res.status, headers: res.headers, body: res.body };
  }

  async search(projectPath, query, options = {}, { signal } = {}) {
    if (typeof query !== 'string' || !query.length) throw new Error('Search query is empty');
    if (query.length > MAX_QUERY_LEN) throw new Error(`Query too long (max ${MAX_QUERY_LEN} chars)`);
    const globs = validateGlobs(options.globs);
    const start = this.client._now();
    const res = await this._do('search', 'search', {
      query,
      regex: !!options.regex,
      word: !!options.word,
      case_sensitive: options.caseSensitive === true ? true : null,
      globs,
      max_matches: options.maxMatches,
    }, { signal });
    const matches = (res.matches || []).map((m) => {
      const from = Math.max(0, (m.col || 1) - 1);
      return {
        file: m.path,
        lineNumber: m.line,
        lineText: m.text,
        submatches: [{ start: from, end: from + (m.len || 0) }],
      };
    });
    return { matches, truncated: !!res.truncated, durationMs: this.client._now() - start };
  }

  // ---- Git (Changes panel, docs/design-git-changes.md) ----

  // GitService's `run`, backed by relay's read-only `git` op. Relay adds the
  // fixed `-c` prefix and the scrubbed environment.
  async _gitRun(root, cwdRel, args, { maxBytes } = {}) {
    let cwd;
    try {
      cwd = this._rel(root, cwdRel || '/');
    } catch (err) {
      throw new GitError('NOT_A_REPO', err.message);
    }
    let res;
    try {
      res = await this.client._call(this.project.id, 'git', { cwd, args, max_bytes: maxBytes });
    } catch (err) {
      throw this._gitError(err);
    }
    return {
      code: res.exit_code,
      stdout: Buffer.from(res.stdout_b64 || '', 'base64'),
      stderr: res.stderr || '',
    };
  }

  _gitError(err) {
    const friendly = this._friendly('git', err);
    switch (err.code) {
      case 'ENOENT': case 'ENOTDIR':
        return new GitError('NOT_A_REPO', 'Directory not found');
      case 'TRAVERSAL': case 'SYMLINK':
        return new GitError('NOT_A_REPO', friendly.message);
      case 'GIT_MISSING': case 'TOO_LARGE': case 'TIMEOUT':
        return new GitError(err.code, friendly.message);
      default: // INVALID and everything else
        return new GitError('FAILED', friendly.message);
    }
  }

  // readFile minus the extension allowlist (a diff must be able to see a .png
  // to call it binary) and with the diff pane's 2 MB cap; the error carries
  // the size so the pane can still show it.
  async _readFileForGit(projectPath, relativePath) {
    const rel = this._rel(projectPath, relativePath);
    try {
      const res = await this.client._call(this.project.id, 'read', { path: rel, max_bytes: GitService.FILE_MAX_BYTES });
      return { content: res.content, size: res.size };
    } catch (err) {
      if (err && err.code === 'TOO_LARGE') {
        const tooLarge = new GitError('TOO_LARGE', 'File too large to diff');
        tooLarge.size = err.size;
        if (tooLarge.size === undefined) {
          try { tooLarge.size = (await this.stat(projectPath, relativePath)).size; } catch { /* size stays unknown */ }
        }
        throw tooLarge;
      }
      throw this._friendly('read', err);
    }
  }

  _git() {
    if (!this._gitService) {
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

  // Lexical pre-check with the same GitError codes GitService uses, so an
  // escaping repo/file path fails identically for every project.
  _validateGitPath(projectPath, relativePath, code, message) {
    try {
      this.validatePath(projectPath, relativePath);
    } catch {
      throw new GitError(code, message);
    }
  }

  async gitStatus(projectPath, repoPath, scope) {
    GitService.assertScope(scope);
    this._validateGitPath(projectPath, repoPath, 'NOT_A_REPO', 'Invalid repository path');
    return this._git().status(projectPath, repoPath, scope);
  }

  async gitFileVersions(projectPath, repoPath, filePath, scope) {
    GitService.assertScope(scope);
    this._validateGitPath(projectPath, repoPath, 'NOT_A_REPO', 'Invalid repository path');
    const repoRel = String(repoPath || '').replace(/^\/+/, '');
    this._validateGitPath(projectPath, path.join(repoRel || '.', String(filePath || '')), 'FAILED', 'Invalid file path');
    return this._git().fileVersions(projectPath, repoPath, filePath, scope);
  }
}

function validateGlobs(globs) {
  if (!Array.isArray(globs)) return [];
  const out = [];
  for (const g of globs) {
    if (typeof g !== 'string') continue;
    const trimmed = g.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_GLOB_LEN) throw new Error(`Glob too long (max ${MAX_GLOB_LEN} chars)`);
    if (trimmed.startsWith('/') || trimmed.includes('..')) throw new Error(`Invalid glob: ${trimmed}`);
    if (out.length >= MAX_GLOBS) throw new Error(`Too many globs (max ${MAX_GLOBS})`);
    out.push(trimmed);
  }
  return out;
}

function readLimited(stream, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

module.exports = {
  RelayFileClient,
  ProjectFiles,
  messageFor,
  RECONNECT_MIN_MS,
  RECONNECT_MAX_MS,
};
