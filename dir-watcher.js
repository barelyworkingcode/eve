/**
 * Directory-tree watcher for platforms whose recursive `fs.watch` cannot skip
 * anything. On Linux, Node emulates `{ recursive: true }` over inotify and
 * registers a watch on every directory, `node_modules` and `.git/objects`
 * included, so a large tree exhausts `fs.inotify.max_user_watches` and the
 * watcher dies. This one is a set of non-recursive `fs.watch` handles that
 * never enter a directory `shouldWatch` refuses, and adds a handle for each
 * directory that appears.
 *
 * Emits the same `(eventType, relPath)` pairs native recursive watch does
 * (forward slashes, relative to root), so file-watcher.js feeds both
 * backends through one path.
 *
 * inotify only starts reporting a new directory once it is watched, so
 * whatever was created inside it in the meantime is invisible. Every new
 * directory is therefore scanned after its watch is attached and each
 * entry found is reported as a `rename`, which is what a create is.
 * Symlinked directories are not followed, as with the native backend.
 */
const fs = require('fs');
const path = require('path');

// Not `fs.promises.readdir` per directory in a loop: the scan is bounded by
// shouldWatch, and one failed directory must not abort its siblings.
function createDirWatcher(root, { shouldWatch = () => true, onEvent, onError = () => {} }) {
  const handles = new Map(); // relDir ('' for root) -> FSWatcher
  let closed = false;
  let failed = false;
  let pending = 0; // outstanding readdir scans
  let signalReady;
  let readySettled = false;
  // initial scan done; read by tests only
  const ready = new Promise((resolve) => { signalReady = resolve; });
  const scanDone = () => {
    pending--;
    if (pending === 0 && !readySettled) { readySettled = true; signalReady(); }
  };

  const fail = (err) => {
    if (closed || failed) return;
    failed = true;
    close();
    onError(err);
  };

  const join = (rel, name) => (rel ? `${rel}/${name}` : name);

  // Throws for the root (caller needs a synchronous start failure); other
  // directories vanishing mid-scan are normal and ignored.
  function attach(rel) {
    if (closed || handles.has(rel)) return;
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    const handle = fs.watch(abs, (eventType, name) => {
      if (closed || !name) return;
      const childRel = join(rel, String(name));
      onEvent(eventType, childRel);
      if (eventType === 'rename') reconcile(childRel);
    });
    handle.on('error', (err) => {
      if (rel === '') return fail(err);
      // A watched subdirectory being removed surfaces here on some kernels.
      if (err && (err.code === 'ENOSPC' || err.code === 'EMFILE')) return fail(err);
      detach(rel);
    });
    handles.set(rel, handle);
  }

  function detach(rel) {
    const prefix = `${rel}/`;
    for (const [key, handle] of [...handles]) {
      if (key === rel || key.startsWith(prefix)) {
        try { handle.close(); } catch { /* already closed */ }
        handles.delete(key);
      }
    }
  }

  // A `rename` at childRel is a create, delete or move: find out which.
  function reconcile(childRel) {
    const abs = path.join(root, ...childRel.split('/'));
    fs.lstat(abs, (err, st) => {
      if (closed) return;
      if (err || !st.isDirectory()) {
        if (handles.has(childRel)) detach(childRel);
        return;
      }
      if (!shouldWatch(childRel) || handles.has(childRel)) return;
      try {
        attach(childRel);
      } catch (e) {
        if (e && (e.code === 'ENOSPC' || e.code === 'EMFILE')) fail(e);
        return;
      }
      scan(childRel, true);
    });
  }

  function scan(rel, report) {
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    pending++;
    fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
      try {
        if (closed || err) return;
        for (const entry of entries) {
          const childRel = join(rel, entry.name);
          if (report) onEvent('rename', childRel);
          if (!entry.isDirectory() || !shouldWatch(childRel) || handles.has(childRel)) continue;
          try {
            attach(childRel);
          } catch (e) {
            if (e && (e.code === 'ENOSPC' || e.code === 'EMFILE')) return fail(e);
            continue;
          }
          scan(childRel, report);
        }
      } finally {
        scanDone();
      }
    });
  }

  function close() {
    closed = true;
    for (const handle of handles.values()) {
      try { handle.close(); } catch { /* already closed */ }
    }
    handles.clear();
  }

  attach('');
  scan('', false);

  return { close, ready, get watchedDirectories() { return handles.size; } };
}

module.exports = { createDirWatcher };
