/**
 * FileWatcher - per-connection watcher for external filesystem changes.
 * One instance per WebSocket connection, same lifecycle as RelayClient.
 *
 * Design: one *recursive* directory watcher per project the connection is
 * interested in (rooted at the project directory). A single recursive watch
 * serves both concerns:
 *
 *   1. Editor live-update - when a file the editor has open changes on disk,
 *      its content is read and pushed as `file_changed`.
 *   2. Sidebar tree sync - when anything is created/deleted/renamed/moved, a
 *      `dir_changed` is pushed for the affected directory so the client can
 *      re-list it (new folders appear, removed ones vanish).
 *
 * Why recursive-per-project instead of per-file `fs.watch`: a per-file watch
 * is bound to the file's inode and goes silent after an *atomic* save
 * (write-temp-then-rename), which is how most editors and CLI tools - including
 * the LLM's own file-edit tools and git - write. Watching the directory tree
 * survives atomic replaces because the tree itself persists. It is event-driven
 * (FSEvents on macOS); there is no polling.
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// Churny, never-shown subtrees. We still receive their events from the kernel
// but drop them here so installs / git ops don't spam tree refreshes.
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.DS_Store']);

const FILE_DEBOUNCE_MS = 100; // coalesce rapid writes before reading content
const DIR_DEBOUNCE_MS = 200;  // coalesce rapid structural churn before refresh
const SELF_WRITE_TTL_MS = 1000;

class FileWatcher {
  constructor(ws, fileService, resolveProject) {
    this.ws = ws;
    this.fileService = fileService;
    this.resolveProject = resolveProject;

    // projectId -> { watcher: fs.FSWatcher, root: absPath }
    this.projectWatchers = new Map();
    // projectId -> Map<canonRel, { binary, clientPath }>  (files the editor has open)
    this.watchedFiles = new Map();
    // debounce timers, keyed by `${projectId}|${canonRel|canonDir}`
    this.fileTimers = new Map();
    this.dirTimers = new Map();
    // absolute paths Eve itself just wrote - suppress the echo back to the client
    this.selfWrites = new Set();
  }

  /**
   * Register interest in an open file. Ensures the project's recursive watcher
   * is running and records the file so its content is pushed on change.
   * `relativePath` is echoed back verbatim so the client can match its tab.
   */
  watch(projectId, relativePath, opts = {}) {
    if (!this._ensureProjectWatcher(projectId)) return;
    const canon = this._canonRel(relativePath);
    if (!canon) return; // never watch the project root as a "file"
    if (!this.watchedFiles.has(projectId)) this.watchedFiles.set(projectId, new Map());
    this.watchedFiles.get(projectId).set(canon, {
      binary: !!opts.binary,
      clientPath: relativePath,
    });
  }

  /** Drop interest in an open file. The project watcher stays up for the tree. */
  unwatch(projectId, relativePath) {
    const canon = this._canonRel(relativePath);
    const files = this.watchedFiles.get(projectId);
    if (files) {
      files.delete(canon);
      if (files.size === 0) this.watchedFiles.delete(projectId);
    }
    const key = this._key(projectId, canon);
    clearTimeout(this.fileTimers.get(key));
    this.fileTimers.delete(key);
  }

  /**
   * Register interest in a project's directory tree (sidebar). Called whenever
   * the client lists a directory so external structural changes are surfaced
   * even when no file is open. Idempotent.
   */
  watchProject(projectId) {
    this._ensureProjectWatcher(projectId);
  }

  /** Suppress the change echo for a file Eve itself just wrote. */
  markSelfWrite(absolutePath) {
    this.selfWrites.add(absolutePath);
    setTimeout(() => this.selfWrites.delete(absolutePath), SELF_WRITE_TTL_MS);
  }

  closeAll() {
    for (const projectId of [...this.projectWatchers.keys()]) {
      this._stopProjectWatcher(projectId);
    }
    this.watchedFiles.clear();
    this.selfWrites.clear();
    for (const t of this.fileTimers.values()) clearTimeout(t);
    for (const t of this.dirTimers.values()) clearTimeout(t);
    this.fileTimers.clear();
    this.dirTimers.clear();
  }

  // --- Project watcher lifecycle ---

  _ensureProjectWatcher(projectId) {
    if (this.projectWatchers.has(projectId)) return true;

    const project = this.resolveProject(projectId);
    if (!project) return false;

    let root;
    try {
      root = this.fileService.validatePath(project.path, '/');
    } catch {
      return false;
    }

    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return; // some platforms omit the name on overflow
        // Drop ignored subtrees BEFORE canonicalizing: node_modules/.git churn
        // is the highest-volume event source and is exactly what we discard, so
        // skipping the canonicalization work for it keeps the hot path cheap.
        if (this._isIgnored(filename)) return;
        const canon = this._canonRel(filename);
        if (!canon) return;
        this._onFsEvent(projectId, root, eventType, canon);
      });
    } catch {
      return false; // root missing/inaccessible, or recursive unsupported
    }

    watcher.on('error', () => this._stopProjectWatcher(projectId));
    this.projectWatchers.set(projectId, { watcher, root });
    return true;
  }

  _stopProjectWatcher(projectId) {
    const entry = this.projectWatchers.get(projectId);
    if (entry) {
      try { entry.watcher.close(); } catch { /* already closed */ }
      this.projectWatchers.delete(projectId);
    }
  }

  // --- Event handling ---

  _onFsEvent(projectId, root, eventType, canonRel) {
    // Content push for an open file. Atomic saves arrive as 'rename', in-place
    // writes as 'change' - handle both; existence is re-checked before sending.
    if (this.watchedFiles.get(projectId)?.has(canonRel)) {
      this._scheduleFilePush(projectId, canonRel);
    }

    // Structural change (create/delete/rename/move) -> refresh the parent dir.
    // Content-only 'change' events never alter a listing, so we skip them.
    if (eventType === 'rename') {
      this._scheduleDirChange(projectId, root, this._parentCanon(canonRel));
    }
  }

  _scheduleFilePush(projectId, canonRel) {
    const key = this._key(projectId, canonRel);
    clearTimeout(this.fileTimers.get(key));
    this.fileTimers.set(key, setTimeout(() => this._pushFile(projectId, canonRel), FILE_DEBOUNCE_MS));
  }

  async _pushFile(projectId, canonRel) {
    this.fileTimers.delete(this._key(projectId, canonRel));

    const entry = this.watchedFiles.get(projectId)?.get(canonRel);
    if (!entry) return;

    const project = this.resolveProject(projectId);
    if (!project) return;

    // Derive the absolute path via validatePath - the same way markSelfWrite's
    // producer (ws-handler) does - so the self-write key matches exactly.
    let absPath;
    try {
      absPath = this.fileService.validatePath(project.path, entry.clientPath);
    } catch {
      return; // invalid / traversal - nothing to push
    }
    if (this.selfWrites.has(absPath)) return; // our own write - don't echo

    try {
      if (entry.binary) {
        // Viewer files: notify only; the client re-fetches via its cache-busted URL.
        await fsp.access(absPath); // skip if it vanished
        this._send({ type: 'file_changed', projectId, path: entry.clientPath });
        return;
      }
      const { content, size } = await this.fileService.readFile(project.path, entry.clientPath);
      this._send({ type: 'file_changed', projectId, path: entry.clientPath, content, size });
    } catch {
      // Deleted or unreadable mid-flight - the dir refresh covers the tree side.
    }
  }

  _scheduleDirChange(projectId, root, canonDir) {
    const key = this._key(projectId, canonDir);
    clearTimeout(this.dirTimers.get(key));
    this.dirTimers.set(key, setTimeout(async () => {
      this.dirTimers.delete(key);
      // Only refresh a directory that still exists. When a whole directory is
      // removed, its child-removal events would otherwise ask the client to
      // re-list a path that's gone (a benign but noisy "not found"). The dir's
      // own removal fires a separate event for the *parent*, which is what
      // actually drops it from the tree.
      const absDir = canonDir === '' ? root : path.join(root, ...canonDir.split('/'));
      try {
        const st = await fsp.stat(absDir);
        if (!st.isDirectory()) return;
      } catch {
        return; // gone - the parent's refresh removes it from the tree
      }
      this._send({ type: 'dir_changed', projectId, path: this._toClientDir(canonDir) });
    }, DIR_DEBOUNCE_MS));
  }

  // --- Helpers ---

  _key(projectId, canon) {
    return `${projectId}|${canon}`;
  }

  _send(payload) {
    try {
      this.ws.send(JSON.stringify(payload));
    } catch { /* socket closing */ }
  }

  /** Normalize any path to a root-relative, forward-slashed, no-leading-slash key. */
  _canonRel(p) {
    return String(p).split(path.sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
  }

  _parentCanon(canonRel) {
    const idx = canonRel.lastIndexOf('/');
    return idx === -1 ? '' : canonRel.slice(0, idx);
  }

  /** Convert a canonical dir ('' = root, 'a/b') to the client's path form. */
  _toClientDir(canonDir) {
    return canonDir === '' ? '/' : `/${canonDir}`;
  }

  _isIgnored(p) {
    // Split on either separator so this works on a raw fs.watch filename
    // (path.sep) or an already-canonical forward-slashed path.
    return String(p).split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
  }
}

module.exports = FileWatcher;
