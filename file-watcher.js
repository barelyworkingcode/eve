/**
 * One recursive directory watcher per project (not per-file `fs.watch`): a
 * per-file watch is bound to the file's inode and goes silent after an
 * atomic save (write-temp-then-rename), which is how most editors, CLI
 * tools, and git write. Watching the tree survives atomic replaces. Serves
 * both editor live-update (`file_changed`) and sidebar tree sync (`dir_changed`).
 *
 * Backend seam (../relay/docs/ssh-hosts.md): a console project watches with
 * a local recursive `fs.watch`; a host project instead asks its HostAgent
 * (ssh-host-pool.js) to watch, ref-counted across every browser connection
 * that's touched that host, and feeds the agent's `{event:"change"}` frames
 * into the same debounce/dedup path below. The agent doesn't distinguish
 * rename from in-place write, so a remote event is treated as both — an
 * extra, idempotent `dir_changed` is cheap; missing one is a stale tree.
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// Still received from the kernel; dropped here so installs / git ops don't
// spam tree refreshes.
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.DS_Store']);

const FILE_DEBOUNCE_MS = 100; // coalesce rapid writes before reading content
const DIR_DEBOUNCE_MS = 200;  // coalesce rapid structural churn before refresh
const SELF_WRITE_TTL_MS = 1000;

class FileWatcher {
  // fileServiceFor: (project) => FileService|RemoteFileService, mirroring
  // FileHandlers#fileServiceFor — kept as an injected function (rather than a
  // single instance) so this class never has to know which backend a given
  // project uses.
  constructor(ws, fileServiceFor, resolveProject) {
    this.ws = ws;
    this.fileServiceFor = fileServiceFor;
    this.resolveProject = resolveProject;

    this.projectWatchers = new Map();
    this.watchedFiles = new Map();
    this.fileTimers = new Map();
    this.dirTimers = new Map();
    this.selfWrites = new Set();
  }

  // relativePath is echoed back verbatim (not canonicalized) so the client
  // can match its tab.
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

  // The project watcher itself stays up for the tree.
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

  // Idempotent.
  watchProject(projectId) {
    this._ensureProjectWatcher(projectId);
  }

  markSelfWrite(absolutePath) {
    this.selfWrites.add(absolutePath);
    // .unref()'d: a leaked timer must never hang a test worker.
    setTimeout(() => this.selfWrites.delete(absolutePath), SELF_WRITE_TTL_MS).unref();
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

  _ensureProjectWatcher(projectId) {
    if (this.projectWatchers.has(projectId)) return true;

    const project = this.resolveProject(projectId);
    if (!project) return false;

    if (project.hostId) return this._ensureRemoteProjectWatcher(projectId, project);
    return this._ensureLocalProjectWatcher(projectId, project);
  }

  _ensureLocalProjectWatcher(projectId, project) {
    let root;
    try {
      root = this.fileServiceFor(project).validatePath(project.path, '/');
    } catch {
      return false;
    }

    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return; // some platforms omit the name on overflow
        // Checked before canonicalizing: node_modules/.git churn is the
        // highest-volume event source, so this keeps the hot path cheap.
        if (this._isIgnored(filename)) return;
        const canon = this._canonRel(filename);
        if (!canon) return;
        this._onFsEvent(projectId, root, eventType, canon);
      });
    } catch {
      return false; // root missing/inaccessible, or recursive unsupported
    }

    watcher.on('error', () => this._stopProjectWatcher(projectId));
    this.projectWatchers.set(projectId, { remote: false, watcher, root });
    return true;
  }

  // hostAgent.watch()/unwatch() are ref-counted per HostAgent across every
  // browser connection that touches that host, so multiple FileWatcher
  // instances (one per WS connection) sharing the same agent don't fight
  // over a single underlying remote `fs.watch`.
  _ensureRemoteProjectWatcher(projectId, project) {
    const agent = this._hostAgentFor(project);
    if (!agent) return false;

    const root = project.path;
    const onChange = (evt) => {
      if (evt.root !== root) return; // this agent may serve other projects on the same host
      const canon = this._canonRel(evt.path);
      // A remote event carries no rename/change distinction — treat every
      // one as a potential rename so the directory listing refreshes too.
      this._onFsEvent(projectId, root, 'rename', canon);
    };
    agent.on('change', onChange);
    agent.watch(root).catch(() => { /* connectivity surfaces via host_status, not here */ });

    this.projectWatchers.set(projectId, { remote: true, agent, root, onChange });
    return true;
  }

  _hostAgentFor(project) {
    const fs = this.fileServiceFor(project);
    return fs && fs.hostAgent ? fs.hostAgent : null;
  }

  _stopProjectWatcher(projectId) {
    const entry = this.projectWatchers.get(projectId);
    if (!entry) return;
    if (entry.remote) {
      entry.agent.removeListener('change', entry.onChange);
      entry.agent.unwatch(entry.root).catch(() => { /* best-effort teardown */ });
    } else {
      try { entry.watcher.close(); } catch { /* already closed */ }
    }
    this.projectWatchers.delete(projectId);
  }

  _onFsEvent(projectId, root, eventType, canonRel) {
    // Atomic saves arrive as 'rename', in-place writes as 'change' - handle both.
    if (this.watchedFiles.get(projectId)?.has(canonRel)) {
      this._scheduleFilePush(projectId, canonRel);
    }

    // Only 'rename' can change a directory listing; 'change' is content-only.
    if (eventType === 'rename') {
      this._scheduleDirChange(projectId, root, this._parentCanon(canonRel));
    }
  }

  _scheduleFilePush(projectId, canonRel) {
    const key = this._key(projectId, canonRel);
    clearTimeout(this.fileTimers.get(key));
    this.fileTimers.set(key, setTimeout(() => this._pushFile(projectId, canonRel), FILE_DEBOUNCE_MS).unref());
  }

  async _pushFile(projectId, canonRel) {
    this.fileTimers.delete(this._key(projectId, canonRel));

    const entry = this.watchedFiles.get(projectId)?.get(canonRel);
    if (!entry) return;

    const project = this.resolveProject(projectId);
    if (!project) return;
    const fileService = this.fileServiceFor(project);

    // Must match ws/file-messages.js's validatePath derivation exactly, or the
    // self-write key won't match and Eve's own write will echo back.
    let absPath;
    try {
      absPath = fileService.validatePath(project.path, entry.clientPath);
    } catch {
      return; // invalid / traversal - nothing to push
    }
    if (this.selfWrites.has(absPath)) return;

    try {
      if (entry.binary) {
        // Viewer files: notify only; the client re-fetches via its cache-busted URL.
        if (project.hostId) {
          await fileService.readFile(project.path, entry.clientPath); // existence probe
        } else {
          await fsp.access(absPath); // skip if it vanished
        }
        this._send({ type: 'file_changed', projectId, path: entry.clientPath });
        return;
      }
      const { content, size } = await fileService.readFile(project.path, entry.clientPath);
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
      // If the whole directory was removed, its child-removal events would
      // otherwise ask the client to re-list a path that's gone; the parent
      // directory's own event is what actually drops it from the tree.
      const project = this.resolveProject(projectId);
      if (!project) return;
      const fileService = this.fileServiceFor(project);
      try {
        if (project.hostId) {
          // No cheap remote "is it still a directory" probe beyond listing it.
          await fileService.listDirectory(project.path, this._toClientDir(canonDir));
        } else {
          const absDir = canonDir === '' ? root : path.join(root, ...canonDir.split('/'));
          const st = await fsp.stat(absDir);
          if (!st.isDirectory()) return;
        }
      } catch {
        return;
      }
      this._send({ type: 'dir_changed', projectId, path: this._toClientDir(canonDir) });
    }, DIR_DEBOUNCE_MS).unref());
  }

  _key(projectId, canon) {
    return `${projectId}|${canon}`;
  }

  _send(payload) {
    try {
      this.ws.send(JSON.stringify(payload));
    } catch { /* socket closing */ }
  }

  _canonRel(p) {
    return String(p).split(path.sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
  }

  _parentCanon(canonRel) {
    const idx = canonRel.lastIndexOf('/');
    return idx === -1 ? '' : canonRel.slice(0, idx);
  }

  _toClientDir(canonDir) {
    return canonDir === '' ? '/' : `/${canonDir}`;
  }

  _isIgnored(p) {
    // Matches both a raw fs.watch filename (path.sep) and an
    // already-canonical forward-slashed path.
    return String(p).split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
  }
}

module.exports = FileWatcher;
