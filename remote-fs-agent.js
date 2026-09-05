'use strict';

/**
 * Eve's file-plane agent for an SSH host (../relay/docs/ssh-hosts.md,
 * decision 7 and the Agent protocol section). Launched on the HOST via
 * `node -e "eval(Buffer.from('<b64>','base64').toString())"` (ssh-command.js
 * nodeLauncher) — it runs as the raw source string, not as a required
 * module, so it must be a single self-contained file: no `require` outside
 * Node core, no reference to any other eve module, Node 18+ only. It speaks
 * newline-delimited JSON on stdin/stdout; stderr is not part of the
 * protocol and is only for last-resort diagnostics.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');

const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;
const SEARCH_MAX_MATCHES = 500;
const SEARCH_MAX_BYTES = 10 * 1024 * 1024;
const SEARCH_TIME_LIMIT_MS = 5000;
const STREAM_CHUNK_BYTES = 64 * 1024;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

// Errors thrown with one of these codes cross the wire verbatim; anything
// else (a validation slip, an unexpected fs code) collapses to ERROR rather
// than leaking a code the client protocol doesn't know about.
const KNOWN_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'TOO_LARGE', 'TRAVERSAL', 'UNSUPPORTED']);

class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function isWithin(base, target) {
  const b = path.resolve(base);
  return target === b || target.startsWith(b + path.sep);
}

// Mirrors file-service.js#_realpathExistingPrefix exactly: resolves symlinks
// on the longest existing prefix and re-appends the not-yet-existing tail, so
// a not-yet-created file/dir is still handled correctly.
function realpathExistingPrefix(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// Two-stage containment identical to file-service.js#validatePath: lexical
// first (cheap, catches the common case), then realpath (defeats a symlink
// inside root pointing outside it).
function resolveInRoot(root, relPath) {
  const normalizedRel = String(relPath || '').replace(/^\/+/, '') || '.';
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizedRel);
  if (!isWithin(resolvedRoot, resolved)) {
    throw new AgentError('Path traversal not allowed', 'TRAVERSAL');
  }
  const realRoot = realpathExistingPrefix(resolvedRoot);
  const realResolved = realpathExistingPrefix(resolved);
  if (!isWithin(realRoot, realResolved)) {
    throw new AgentError('Path traversal not allowed', 'TRAVERSAL');
  }
  return resolved;
}

function relFrom(root, full) {
  return path.relative(path.resolve(root), full).split(path.sep).join('/');
}

function mapError(err) {
  const code = KNOWN_CODES.has(err && err.code) ? err.code : 'ERROR';
  return { error: (err && err.message) || String(err), code };
}

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function searchWalk(rootFull, query, opts) {
  const maxMatches = Math.min(Number(opts.maxMatches) || SEARCH_MAX_MATCHES, SEARCH_MAX_MATCHES);
  const start = Date.now();
  const caseSensitive = !!opts.caseSensitive;

  let matchIn;
  if (opts.regex) {
    let re;
    try {
      re = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (err) {
      throw new AgentError(`Invalid regex: ${err.message}`, 'ERROR');
    }
    matchIn = (line) => {
      const m = re.exec(line);
      return m ? { index: m.index, len: m[0].length } : null;
    };
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matchIn = (line) => {
      const hay = caseSensitive ? line : line.toLowerCase();
      const idx = hay.indexOf(needle);
      return idx === -1 ? null : { index: idx, len: needle.length };
    };
  }

  const includeGlobs = (opts.globs || []).map(globToRegExp);
  const matches = [];
  let truncated = false;
  let bytesScanned = 0;

  function overBudget() {
    return truncated || Date.now() - start > SEARCH_TIME_LIMIT_MS || bytesScanned > SEARCH_MAX_BYTES || matches.length >= maxMatches;
  }

  async function walk(dir) {
    if (overBudget()) { truncated = true; return; }
    let dh;
    try {
      dh = await fsp.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const dirent of dh) {
        if (overBudget()) { truncated = true; break; }
        if (dirent.isDirectory()) {
          if (SKIP_DIR_NAMES.has(dirent.name)) continue;
          await walk(path.join(dir, dirent.name));
          continue;
        }
        if (!dirent.isFile()) continue;

        const full = path.join(dir, dirent.name);
        const rel = relFrom(rootFull, full);
        if (includeGlobs.length && !includeGlobs.some((re) => re.test(rel))) continue;

        let content;
        try {
          const st = await fsp.stat(full);
          if (st.size > SEARCH_MAX_BYTES) continue;
          bytesScanned += st.size;
          content = await fsp.readFile(full, 'utf8');
        } catch {
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const m = matchIn(lines[i]);
          if (m) {
            // `len` is additive beyond the doc's {path,line,col,text} shape —
            // eve uses it to build a highlight range without a second pass.
            matches.push({ path: rel, line: i + 1, col: m.index + 1, text: lines[i], len: m.len });
            if (matches.length >= maxMatches) { truncated = true; break; }
          }
        }
        if (overBudget()) { truncated = true; break; }
      }
    } finally {
      try { await dh.close(); } catch { /* already closed */ }
    }
  }

  await walk(rootFull);
  return { matches, truncated };
}

const watchers = new Map(); // root -> fs.FSWatcher

async function handleMessage(msg) {
  const { id, op } = msg;

  switch (op) {
    case 'hello': {
      send({ id, ok: true, home: os.homedir(), os: process.platform, node: process.version });
      return;
    }

    case 'list': {
      const full = resolveInRoot(msg.root, msg.path);
      const entries = await fsp.readdir(full, { withFileTypes: true });
      const showHidden = !!msg.showHidden;
      const out = [];
      for (const e of entries) {
        if (!showHidden && e.name.startsWith('.')) continue;
        const type = e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file';
        let size = 0;
        let mtime = 0;
        try {
          const st = await fsp.stat(path.join(full, e.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* broken symlink or vanished mid-listing */ }
        out.push({ name: e.name, type, size, mtime });
      }
      send({ id, ok: true, entries: out });
      return;
    }

    case 'read': {
      const full = resolveInRoot(msg.root, msg.path);
      const st = await fsp.stat(full);
      if (st.isDirectory()) throw new AgentError('Path is a directory', 'EISDIR');
      const maxBytes = msg.maxBytes || DEFAULT_MAX_READ_BYTES;
      if (st.size > maxBytes) throw new AgentError('File too large', 'TOO_LARGE');
      const content = await fsp.readFile(full, 'utf8');
      send({ id, ok: true, content, size: st.size });
      return;
    }

    case 'write': {
      const full = resolveInRoot(msg.root, msg.path);
      await fsp.writeFile(full, msg.content ?? '', 'utf8');
      send({ id, ok: true });
      return;
    }

    case 'writeb64': {
      const full = resolveInRoot(msg.root, msg.path);
      await fsp.writeFile(full, Buffer.from(msg.data || '', 'base64'));
      send({ id, ok: true });
      return;
    }

    case 'rename': {
      const full = resolveInRoot(msg.root, msg.path);
      const newName = String(msg.newName || '');
      if (!newName || newName.includes('/') || newName.includes('\\')) {
        throw new AgentError('Name cannot contain path separators', 'ERROR');
      }
      const dest = path.join(path.dirname(full), newName);
      if (!isWithin(path.resolve(msg.root), dest)) throw new AgentError('Path traversal not allowed', 'TRAVERSAL');
      await fsp.rename(full, dest);
      send({ id, ok: true, path: relFrom(msg.root, dest) });
      return;
    }

    case 'move': {
      const full = resolveInRoot(msg.root, msg.path);
      const destDirFull = resolveInRoot(msg.root, msg.destDir);
      const dest = path.join(destDirFull, path.basename(full));
      if (!isWithin(path.resolve(msg.root), dest)) throw new AgentError('Path traversal not allowed', 'TRAVERSAL');
      await fsp.rename(full, dest);
      send({ id, ok: true, path: relFrom(msg.root, dest) });
      return;
    }

    case 'delete': {
      const full = resolveInRoot(msg.root, msg.path);
      if (full === path.resolve(msg.root)) throw new AgentError('Cannot delete project root', 'ERROR');
      // No trash on a host (decision in the doc): recursive hard delete.
      await fsp.rm(full, { recursive: true });
      send({ id, ok: true });
      return;
    }

    case 'mkdir': {
      const parentFull = resolveInRoot(msg.root, msg.parent);
      const name = String(msg.name || '');
      if (!name || name.includes('/') || name.includes('\\')) {
        throw new AgentError('Name cannot contain path separators', 'ERROR');
      }
      const dest = path.join(parentFull, name);
      if (!isWithin(path.resolve(msg.root), dest)) throw new AgentError('Path traversal not allowed', 'TRAVERSAL');
      await fsp.mkdir(dest);
      send({ id, ok: true, path: relFrom(msg.root, dest) });
      return;
    }

    case 'stat': {
      const full = resolveInRoot(msg.root, msg.path);
      const st = await fsp.lstat(full);
      const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file';
      send({ id, ok: true, type, size: st.size, mtime: st.mtimeMs });
      return;
    }

    case 'stream': {
      const full = resolveInRoot(msg.root, msg.path);
      const handle = await fsp.open(full, 'r');
      try {
        const st = await handle.stat();
        if (st.isDirectory()) throw new AgentError('Path is a directory', 'EISDIR');
        const size = st.size;
        const buf = Buffer.alloc(STREAM_CHUNK_BYTES);
        let pos = 0;
        while (pos < size) {
          const { bytesRead } = await handle.read(buf, 0, STREAM_CHUNK_BYTES, pos);
          if (bytesRead <= 0) break;
          send({ id, chunk: buf.slice(0, bytesRead).toString('base64') });
          pos += bytesRead;
        }
        send({ id, ok: true, size });
      } finally {
        await handle.close();
      }
      return;
    }

    case 'search': {
      const full = resolveInRoot(msg.root, msg.path || '.');
      if (typeof msg.query !== 'string' || !msg.query.length) {
        throw new AgentError('Search query is empty', 'ERROR');
      }
      const { matches, truncated } = await searchWalk(full, msg.query, {
        regex: !!msg.regex,
        caseSensitive: !!msg.caseSensitive,
        globs: msg.globs,
        maxMatches: msg.maxMatches,
      });
      send({ id, ok: true, matches, truncated });
      return;
    }

    case 'watch': {
      const full = resolveInRoot(msg.root, '.');
      const key = msg.root;
      if (watchers.has(key)) { send({ id, ok: true }); return; }
      let watcher;
      try {
        watcher = fs.watch(full, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          send({ event: 'change', root: msg.root, path: String(filename).split(path.sep).join('/') });
        });
      } catch (err) {
        send({ id, ok: false, error: err.message, code: 'UNSUPPORTED' });
        return;
      }
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already closed */ }
        watchers.delete(key);
      });
      watchers.set(key, watcher);
      send({ id, ok: true });
      return;
    }

    case 'unwatch': {
      const key = msg.root;
      const watcher = watchers.get(key);
      if (watcher) {
        try { watcher.close(); } catch { /* already closed */ }
        watchers.delete(key);
      }
      send({ id, ok: true });
      return;
    }

    default:
      send({ id, ok: false, error: `Unknown op: ${op}`, code: 'ERROR' });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // malformed line: no id to reply to, drop silently
  }
  Promise.resolve()
    .then(() => handleMessage(msg))
    .catch((err) => send({ id: msg.id, ok: false, ...mapError(err) }));
});

// The pipe closing (ssh exiting, the ControlMaster dropping) ends stdin; let
// the process exit naturally rather than hanging on an open readline.
rl.on('close', () => process.exit(0));
