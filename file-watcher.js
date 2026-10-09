/**
 * Turns relay's change stream into the browser's tree and editor updates.
 * Relay owns the watching (one recursive watcher per project, console or SSH
 * host); this class is fed by the RelayFileClient's `fs_event`, `watch_ok` and
 * `watch_error` and does what the old per-backend watchers did after the
 * kernel event: debounce, filter, and push. There is one FileWatcher per
 * browser connection; the client ref-counts the underlying watch across them.
 * It serves both editor live-update (`file_changed`) and sidebar tree sync
 * (`dir_changed`).
 *
 * Relay forwards every event unfiltered with kind `change` (content) or
 * `rename` (created, removed, renamed): only a `rename` can change a
 * directory listing.
 *
 * The same stream drives the Changes panel's `git_changed` push
 * (docs/design-git-changes.md, "Refresh"). Attribution is a cheap path
 * guess, no git exec: a change at `<seg>/...` → repo `/<seg>`, a file
 * directly in the root → `/`. Inside any `.git` dir only index/HEAD-style
 * basenames count (commits, staging, branch switches, merges) and map to
 * `*` (refresh all) — a `.git/worktrees/<name>/index` can't be tied to its
 * worktree folder without git. The client falls back to a full refresh for
 * a repo it doesn't know, so an imprecise guess is fine; a missed one isn't.
 */
const crypto = require('crypto');

// Still received from the kernel; dropped here so installs / git ops don't
// spam tree refreshes.
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.DS_Store']);
// Ignored for git refresh too; `.git` is handled separately below.
const GIT_IGNORED_SEGMENTS = new Set(['node_modules', '.DS_Store']);
// The only `.git/**` basenames that signal a status change worth a refresh.
const GIT_REFRESH_BASENAMES = new Set(['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD']);

const FILE_DEBOUNCE_MS = 100; // coalesce rapid writes before reading content
const DIR_DEBOUNCE_MS = 200;  // coalesce rapid structural churn before refresh
const GIT_DEBOUNCE_MS = 500;  // coalesce a checkout/commit burst into one git status
const SELF_WRITE_TTL_MS = 1000;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

class FileWatcher {
  // files: the RelayFileClient. resolveProject: id -> project (or null).
  constructor(ws, files, resolveProject) {
    this.ws = ws;
    this.files = files;
    this.resolveProject = resolveProject;

    // Projects this connection holds a watch on (one ref each in the client).
    this.heldProjects = new Set();
    this.watchedFiles = new Map();
    this.fileTimers = new Map();
    this.dirTimers = new Map();
    this.gitTimers = new Map();
    // absPath -> Map<sha256 hex of saved content, expiry timer>
    this.selfWrites = new Map();
    this.reportedFailures = new Set(); // projectIds already told; cleared on watch_ok

    this._onFsEventFrame = (evt) => this._onRelayEvent(evt);
    this._onWatchOk = (evt) => this.reportedFailures.delete(evt.projectId);
    this._onWatchError = (evt) => this._onRelayWatchError(evt);
    files.on('fs_event', this._onFsEventFrame);
    files.on('watch_ok', this._onWatchOk);
    files.on('watch_error', this._onWatchError);
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

  markSelfWrite(absolutePath, content) {
    if (typeof content !== 'string') return;
    const hash = sha256(content);
    let hashes = this.selfWrites.get(absolutePath);
    if (!hashes) {
      hashes = new Map();
      this.selfWrites.set(absolutePath, hashes);
    }
    clearTimeout(hashes.get(hash));
    // .unref()'d: a leaked timer must never hang a test worker.
    const timer = setTimeout(() => {
      const cur = this.selfWrites.get(absolutePath);
      if (!cur) return;
      cur.delete(hash);
      if (cur.size === 0) this.selfWrites.delete(absolutePath);
    }, SELF_WRITE_TTL_MS);
    timer.unref();
    hashes.set(hash, timer);
  }

  // True when `content` is exactly what Eve just saved to this path.
  _isEcho(absPath, content) {
    const hashes = this.selfWrites.get(absPath);
    return !!hashes && hashes.has(sha256(content));
  }

  _forgetSelfWrites(absPath) {
    const hashes = this.selfWrites.get(absPath);
    if (!hashes) return;
    for (const t of hashes.values()) clearTimeout(t);
    this.selfWrites.delete(absPath);
  }

  closeAll() {
    this.files.removeListener('fs_event', this._onFsEventFrame);
    this.files.removeListener('watch_ok', this._onWatchOk);
    this.files.removeListener('watch_error', this._onWatchError);
    for (const projectId of this.heldProjects) this.files.unwatch(projectId);
    this.heldProjects.clear();
    this.watchedFiles.clear();
    for (const hashes of this.selfWrites.values()) {
      for (const t of hashes.values()) clearTimeout(t);
    }
    this.selfWrites.clear();
    for (const t of this.fileTimers.values()) clearTimeout(t);
    for (const t of this.dirTimers.values()) clearTimeout(t);
    for (const t of this.gitTimers.values()) clearTimeout(t);
    this.fileTimers.clear();
    this.dirTimers.clear();
    this.gitTimers.clear();
  }

  _ensureProjectWatcher(projectId) {
    if (this.heldProjects.has(projectId)) return true;
    if (!this.resolveProject(projectId)) return false;
    this.heldProjects.add(projectId);
    this.files.watch(projectId);
    return true;
  }

  _onRelayEvent({ projectId, path: eventPath, kind }) {
    if (!this.heldProjects.has(projectId)) return;
    // Before the ignore check: a `.git/index` / `.git/HEAD` write is
    // dropped for the tree but still means git status changed.
    this._maybeScheduleGitChange(projectId, eventPath);
    // Checked before canonicalizing: node_modules/.git churn is the
    // highest-volume event source, so this keeps the hot path cheap.
    if (this._isIgnored(eventPath)) return;
    const canon = this._canonRel(eventPath);
    if (!canon) return;
    this._onFsEvent(projectId, kind, canon);
  }

  // Relay holds no watch for the project after this. Let go of ours, so the
  // next list_directory asks again, and tell the browser once.
  _onRelayWatchError({ projectId, code }) {
    if (!this.heldProjects.has(projectId)) return;
    this.heldProjects.delete(projectId);
    this.files.unwatch(projectId);
    this._reportFailure(projectId, code);
  }

  // Once per project until the next watch_ok: list_directory retries the
  // watch on every call and would otherwise repeat the frame.
  _reportFailure(projectId, code) {
    if (this.reportedFailures.has(projectId)) return;
    this.reportedFailures.add(projectId);
    this._send({ type: 'watch_error', projectId, reason: code || 'UNKNOWN' });
  }

  _onFsEvent(projectId, eventType, canonRel) {
    // Atomic saves arrive as 'rename', in-place writes as 'change' - handle both.
    if (this.watchedFiles.get(projectId)?.has(canonRel)) {
      this._scheduleFilePush(projectId, canonRel);
    }

    // Only 'rename' can change a directory listing; 'change' is content-only.
    if (eventType === 'rename') {
      this._scheduleDirChange(projectId, this._parentCanon(canonRel));
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
    const fileService = this.files.forProject(project);

    // Must match ws/file-messages.js's validatePath derivation exactly, or the
    // self-write key won't match and Eve's own write will echo back.
    let absPath;
    try {
      absPath = fileService.validatePath(project.path, entry.clientPath);
    } catch {
      return; // invalid / traversal - nothing to push
    }
    try {
      if (entry.binary) {
        // Viewer files: notify only; the client re-fetches via its cache-busted URL.
        await fileService.stat(project.path, entry.clientPath); // skip if it vanished
        this._send({ type: 'file_changed', projectId, path: entry.clientPath });
        return;
      }
      const { content, size } = await fileService.readFile(project.path, entry.clientPath);
      // Drop only the read that matches a pending save; any other content is an
      // outside write and must reach the client.
      if (this.selfWrites.has(absPath)) {
        if (this._isEcho(absPath, content)) return;
        this._forgetSelfWrites(absPath);
      }
      this._send({ type: 'file_changed', projectId, path: entry.clientPath, content, size });
    } catch {
      // Deleted or unreadable mid-flight - the dir refresh covers the tree side.
    }
  }

  _scheduleDirChange(projectId, canonDir) {
    const key = this._key(projectId, canonDir);
    clearTimeout(this.dirTimers.get(key));
    this.dirTimers.set(key, setTimeout(async () => {
      this.dirTimers.delete(key);
      // If the whole directory was removed, its child-removal events would
      // otherwise ask the client to re-list a path that's gone; the parent
      // directory's own event is what actually drops it from the tree.
      const project = this.resolveProject(projectId);
      if (!project) return;
      try {
        const st = await this.files.forProject(project).stat(project.path, this._toClientDir(canonDir));
        if (st.type !== 'directory') return;
      } catch {
        return;
      }
      this._send({ type: 'dir_changed', projectId, path: this._toClientDir(canonDir) });
    }, DIR_DEBOUNCE_MS).unref());
  }

  _maybeScheduleGitChange(projectId, p) {
    const repo = this._gitRepoFor(p);
    if (repo) this._scheduleGitChange(projectId, repo);
  }

  // Self-writes are deliberately NOT filtered: an editor save changes git
  // status just like an external write does.
  _scheduleGitChange(projectId, repo) {
    const key = this._key(projectId, repo);
    clearTimeout(this.gitTimers.get(key));
    this.gitTimers.set(key, setTimeout(() => {
      this.gitTimers.delete(key);
      this._send({ type: 'git_changed', projectId, repo });
    }, GIT_DEBOUNCE_MS).unref());
  }

  // Returns the repo guess for a changed path ('/<seg>', '/', or '*'), or
  // null when the event can't affect git status.
  _gitRepoFor(p) {
    const segs = String(p).split(/[\\/]/).filter(Boolean);
    if (segs.length === 0) return null;
    if (segs.some((seg) => GIT_IGNORED_SEGMENTS.has(seg))) return null;
    const gitIdx = segs.indexOf('.git');
    if (gitIdx !== -1) {
      // `.git` as the final segment is a worktree's gitlink file or the dir
      // itself — neither is a status change.
      if (gitIdx === segs.length - 1) return null;
      return GIT_REFRESH_BASENAMES.has(segs[segs.length - 1]) ? '*' : null;
    }
    return segs.length === 1 ? '/' : `/${segs[0]}`;
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
    return String(p).replace(/^\/+/, '').replace(/\/+$/, '');
  }

  _parentCanon(canonRel) {
    const idx = canonRel.lastIndexOf('/');
    return idx === -1 ? '' : canonRel.slice(0, idx);
  }

  _toClientDir(canonDir) {
    return canonDir === '' ? '/' : `/${canonDir}`;
  }

  _isIgnored(p) {
    return String(p).split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
  }
}

module.exports = FileWatcher;
