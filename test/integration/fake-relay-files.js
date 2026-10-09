/**
 * Fake relay, file plane: the routes under /api/projects/{id}/files/*, POST
 * /api/hosts/{id}/pastetmp and GET /ws/files, served from memory (or from a
 * real directory for git specs). fake-relay.js delegates to this module and
 * exposes `hooks` as `relay.files`.
 *
 * Pinned to relay's source at ../relay (see fake-relay.js for how the pins
 * work). The files this module mirrors, all under ../relay:
 *   internal/projectfs/projectfs.go   codes, CleanRel, ValidateName, ValidateGitArgs
 *   internal/projectfs/local.go       the console backend: messages, symlink refusal
 *   internal/projectfs/search.go      search validation, matcher, scan
 *   cmd/relay/file_routes.go          routes, body limits, error body, status map
 *   cmd/relay/file_ops.go             check order, read-only, gate, audit rows
 *   cmd/relay/audit_file.go           intent / completion / denied rows
 *   cmd/relay/file_ws.go              /ws/files frames
 *
 * One deliberate difference from relay's host backend: rename and move onto
 * an existing destination answer 409 EEXIST on both backends (owner decision
 * on eve#290). Delete still differs: console trashes, host deletes.
 */
const fs = require('fs');
const pathMod = require('path');
const { execFile } = require('child_process');

const MAX_READ = 10 << 20;
const MAX_WRITE = 10 << 20;
const MAX_PASTE = 10 << 20;
const MAX_GIT = 32 << 20;
const DEFAULT_GIT = 8 << 20;
const MAX_SEARCH_MATCHES = 500;
const MAX_PER_FILE = 50;
const MAX_SEARCH_FILE = 5 << 20;
const MAX_SEARCH_SCANNED = 10 << 20;
const BODY_LIMIT = 64 << 10;
const WRITE_BODY_LIMIT = 16 << 20;
const PASTE_BODY_LIMIT = 16 << 20;
const GIT_TIMEOUT_MS = 10000;
const SYMLINK_MSG = 'Symbolic links are not opened';

const STATUS = {
  PROJECT_NOT_FOUND: 404, HOST_NOT_FOUND: 404, ENOENT: 404,
  NOT_AVAILABLE: 403, TRAVERSAL: 403, SYMLINK: 403, READ_ONLY: 403, EACCES: 403,
  INVALID: 400, EISDIR: 400, ENOTDIR: 400, EEXIST: 409, TOO_LARGE: 413,
  HOST_UNREACHABLE: 503, AUDIT_UNAVAILABLE: 503, TIMEOUT: 504,
};
const DENIED = new Set(['TRAVERSAL', 'SYMLINK', 'READ_ONLY']);

// projectfs.Error: code, message, and size on TOO_LARGE.
function ferr(code, msg, size) {
  const e = new Error(msg);
  e.fileCode = code;
  if (size !== undefined) e.fileSize = size;
  return e;
}

// ---- lexical path rules (projectfs.go) ----

function cleanRel(p) {
  if (p.includes('\0')) throw ferr('INVALID', 'path contains NUL');
  const out = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') throw ferr('TRAVERSAL', 'Path traversal not allowed');
    out.push(s);
  }
  return out.join('/');
}

function validateName(n) {
  if (n === '' || n === '.' || n === '..' || /[/\0]/.test(n)) throw ferr('INVALID', 'invalid name');
}

const joinRel = (dir, name) => (dir === '' ? name : `${dir}/${name}`);
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

const GIT_SUBCOMMANDS = new Set(['rev-parse', 'worktree', 'symbolic-ref', 'for-each-ref', 'merge-base', 'status', 'rev-list', 'diff', 'ls-files', 'cat-file']);
const GIT_REFUSED = ['--output', '--ext-diff', '--textconv', '--exec', '--upload-pack', '--receive-pack', '-c', '--config', '--git-dir', '--work-tree', '--namespace', '-C', '-O', '--open-files-in-pager', '--no-index', '--filters'];
const GIT_PREFIX = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

function validateGitArgs(args) {
  if (!args.length || !GIT_SUBCOMMANDS.has(args[0])) throw ferr('INVALID', 'git subcommand not allowed');
  for (const a of args) {
    if (a.includes('\0')) throw ferr('INVALID', 'git argument contains NUL');
    if (GIT_REFUSED.some((p) => a.startsWith(p))) throw ferr('INVALID', `git argument not allowed: ${a}`);
  }
  if (args[0] === 'worktree' && (args.length < 2 || args[1] !== 'list')) throw ferr('INVALID', 'only git worktree list is allowed');
  if (args[0] === 'symbolic-ref' && args.slice(1).filter((a) => !a.startsWith('-')).length > 1) throw ferr('INVALID', 'git symbolic-ref may not set a ref');
}

// ---- stores: the primitives both modes share ----
// Every store answers the same few questions about a root-relative path;
// the op logic below never knows which one it has.

function memStore() {
  const nodes = new Map(); // rel -> { t: 'file'|'directory'|'symlink', data?, target?, mtime }
  const stamp = () => Date.now();
  const under = (rel) => [...nodes.keys()].filter((k) => k === rel || k.startsWith(`${rel}/`));
  return {
    lstat(rel) {
      if (rel === '') return { type: 'directory', size: 0, mtime_ms: 0 };
      const n = nodes.get(rel);
      return n ? { type: n.t, size: n.t === 'file' ? n.data.length : 0, mtime_ms: n.mtime } : null;
    },
    names(rel) {
      const prefix = rel === '' ? '' : `${rel}/`;
      return [...nodes.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
    },
    read: (rel) => nodes.get(rel).data,
    put: (rel, data) => { nodes.set(rel, { t: 'file', data, mtime: stamp() }); },
    mkdir: (rel) => { nodes.set(rel, { t: 'directory', mtime: stamp() }); },
    link: (rel, target) => { nodes.set(rel, { t: 'symlink', target, mtime: stamp() }); },
    target: (rel) => nodes.get(rel).target,
    mv(from, to) {
      for (const k of under(from)) {
        const n = nodes.get(k);
        nodes.delete(k);
        nodes.set(to + k.slice(from.length), n);
      }
    },
    rm(rel) { for (const k of under(rel)) nodes.delete(k); },
    same: () => false,
  };
}

function diskStore(root) {
  const abs = (rel) => pathMod.join(root, rel);
  return {
    root,
    lstat(rel) {
      try {
        const st = fs.lstatSync(abs(rel));
        const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file';
        return { type, size: st.size, mtime_ms: Math.floor(st.mtimeMs) };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        if (e.code === 'ENOTDIR') return null;
        throw e;
      }
    },
    names: (rel) => fs.readdirSync(abs(rel)),
    read: (rel) => fs.readFileSync(abs(rel)),
    put: (rel, data) => { fs.writeFileSync(abs(rel), data); },
    mkdir: (rel) => { fs.mkdirSync(abs(rel)); },
    link: (rel, target) => { fs.symlinkSync(target, abs(rel)); },
    target: (rel) => fs.readlinkSync(abs(rel)),
    mv: (from, to) => { fs.renameSync(abs(from), abs(to)); },
    rm: (rel) => { fs.rmSync(abs(rel), { recursive: true, force: true }); },
    // A case-only rename on a case-insensitive volume finds itself at the destination.
    same(a, b) {
      try {
        const x = fs.lstatSync(abs(a));
        const y = fs.lstatSync(abs(b));
        return x.ino === y.ino && x.dev === y.dev;
      } catch { return false; }
    },
  };
}

// lstat of rel with no link allowed in any component. A missing final entry is
// null; a missing or non-directory ancestor is an error. allowFinalLink is for
// checks that ask whether a destination name is taken.
function lstatPath(store, rel, { allowFinalLink = false } = {}) {
  const parts = rel === '' ? [] : rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const info = store.lstat(parts.slice(0, i).join('/'));
    const last = i === parts.length;
    if (!info) {
      if (last) return null;
      throw ferr('ENOENT', 'Not found');
    }
    if (info.type === 'symlink' && !(last && allowFinalLink)) throw ferr('SYMLINK', SYMLINK_MSG);
    if (last) return info;
    if (info.type !== 'directory') throw ferr('ENOTDIR', 'Not a directory');
  }
  return store.lstat('');
}

function openDir(store, rel) {
  const info = lstatPath(store, rel);
  if (!info) throw ferr('ENOENT', 'Not found');
  if (info.type !== 'directory') throw ferr('ENOTDIR', 'Not a directory');
}

function openFile(store, rel) {
  if (rel === '') throw ferr('EISDIR', 'Path is a directory');
  const info = lstatPath(store, rel);
  if (!info) throw ferr('ENOENT', 'Not found');
  if (info.type === 'directory') throw ferr('EISDIR', 'Path is a directory');
  return info;
}

function ensureParents(store, rel) {
  const parts = rel.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (!store.lstat(p)) store.mkdir(p);
  }
}

// ---- search (search.go) ----

function validateSearch(o) {
  if (!o.query) throw ferr('INVALID', 'Search query is empty');
  if ([...o.query].length > 1000) throw ferr('INVALID', 'Search query is too long');
  if (o.globs.length > 5) throw ferr('INVALID', 'Too many globs');
  for (const g of o.globs) {
    if (g.length > 200 || g.startsWith('/') || g.startsWith('!/') || g.includes('\0')) throw ferr('INVALID', 'Invalid glob');
    if (g.replace(/^!/, '').split('/').includes('..')) throw ferr('INVALID', 'Invalid glob');
  }
}

function searchMatcher(o) {
  validateSearch(o);
  let pat = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.word) pat = `\\b(?:${pat})\\b`;
  const sensitive = o.case_sensitive === null || o.case_sensitive === undefined ? /\p{Lu}/u.test(o.query) : o.case_sensitive;
  let re;
  try { re = new RegExp(pat, sensitive ? 'g' : 'gi'); } catch (e) { throw ferr('INVALID', `Invalid regex: ${e.message}`); }
  const globRe = (g) => new RegExp(`^${[...g].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 's');
  const include = o.globs.filter((g) => !g.startsWith('!')).map(globRe);
  const exclude = o.globs.filter((g) => g.startsWith('!')).map((g) => globRe(g.slice(1)));
  const max = o.max_matches > 0 && o.max_matches <= MAX_SEARCH_MATCHES ? o.max_matches : MAX_SEARCH_MATCHES;
  const wants = (rel) => !exclude.some((g) => g.test(rel)) && (!include.length || include.some((g) => g.test(rel)));
  return { re, max, wants };
}

// JS strings are UTF-16, so a match's index and length are already the
// UTF-16 code-unit counts the wire promises. col and line are 1-based.
function scanContent(m, rel, content, out, room) {
  let perFile = 0;
  let line = 1;
  const lines = content.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let text of lines) {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    for (const hit of text.matchAll(m.re)) {
      if (hit[0] === '') continue;
      if (perFile >= MAX_PER_FILE) return false;
      if (room <= 0) return true;
      out.push({ path: rel, line, col: hit.index + 1, len: hit[0].length, text });
      perFile++;
      room--;
    }
    line++;
  }
  return false;
}

function runSearch(store, m) {
  const out = [];
  let truncated = false;
  let scanned = 0;
  const done = () => {
    if (truncated) return true;
    if (out.length >= m.max || scanned > MAX_SEARCH_SCANNED) { truncated = true; return true; }
    return false;
  };
  const walk = (dir) => {
    for (const n of store.names(dir).sort()) {
      if (done()) return;
      if (n.startsWith('.') || n === 'node_modules') continue;
      const rel = joinRel(dir, n);
      const info = store.lstat(rel);
      if (!info) continue;
      if (info.type === 'directory') walk(rel);
      else if (info.type === 'file') {
        if (!m.wants(rel) || info.size > MAX_SEARCH_FILE) continue;
        scanned += info.size;
        const data = store.read(rel);
        if (data.subarray(0, 8000).includes(0)) continue;
        if (scanContent(m, rel, data, out, m.max - out.length)) truncated = true;
      }
    }
  };
  walk('');
  return { matches: out, truncated };
}

// ---- git ----

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

function runGit(dir, args, maxBytes) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_PREFIX, ...args], { cwd: dir, env: gitEnv(), encoding: 'buffer', maxBuffer: maxBytes, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve({ exit_code: 0, stdout, stderr: stderr.toString('utf8') });
      if (err.code === 'ENOENT') return reject(ferr('GIT_MISSING', 'git is not installed'));
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(ferr('TOO_LARGE', 'git output too large', maxBytes));
      if (err.killed) return reject(ferr('TIMEOUT', 'git timed out'));
      if (typeof err.code === 'number') return resolve({ exit_code: err.code, stdout, stderr: stderr.toString('utf8') });
      return reject(ferr('ERROR', err.message));
    });
  });
}

const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git\n';

// ---- the module ----

function createFakeFiles({ projects, hosts }) {
  const stores = new Map(); // projectId -> store
  const requests = [];
  const audit = [];
  const conns = new Set(); // { ws, watching: Set, ok: Set }
  const okWaiters = []; // { projectId, resolve }
  const hostStatuses = new Map(); // hostId -> { host_id, name, status, error }
  const failures = new Map(); // op -> [{ status, code, error }]
  const holds = new Map(); // op -> [{ arrive, gate }]
  let autoEmit = true;
  let auditSeq = 0;

  const storeFor = (id) => {
    if (!stores.has(id)) stores.set(id, memStore());
    return stores.get(id);
  };

  // ---- watch ----

  const sendFrame = (c, frame, cb) => {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(frame), cb);
  };

  function emit(projectId, p, kind = 'rename') {
    for (const c of conns) {
      if (c.watching.has(projectId)) sendFrame(c, { type: 'fs_event', project_id: projectId, path: p, kind });
    }
  }

  function hostFrame(s) {
    const f = { type: 'host_status', host_id: s.host_id, name: s.name, status: s.status };
    if (s.error) f.error = s.error;
    return f;
  }

  // The first two checks of relay's order, shared by routes and watch.
  function openProject(projectId) {
    const proj = projects.get(projectId);
    if (!proj) throw ferr('PROJECT_NOT_FOUND', 'project not found');
    if (proj.kind === 'remote' || !proj.path) throw ferr('NOT_AVAILABLE', 'files are not available for this project');
    return proj;
  }

  // A hosted project whose host is gone or down is unreachable, never a console path.
  function checkHost(proj) {
    if (!proj.host_id) return;
    const host = hosts.get(proj.host_id);
    if (!host) throw ferr('HOST_UNREACHABLE', 'host is not connected');
    const st = hostStatuses.get(proj.host_id);
    if (st && st.status === 'unreachable') throw ferr('HOST_UNREACHABLE', st.error || `host "${st.name || host.name}" unreachable`);
  }

  function onWsMessage(c, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.project_id !== 'string' || !msg.project_id) return;
    const id = msg.project_id;
    if (msg.type === 'unwatch') { c.watching.delete(id); c.ok.delete(id); return; }
    if (msg.type !== 'watch') return;
    try {
      checkHost(openProject(id));
    } catch (e) {
      return sendFrame(c, { type: 'watch_error', project_id: id, code: e.fileCode, error: e.message });
    }
    c.watching.add(id);
    sendFrame(c, { type: 'watch_ok', project_id: id }, () => {
      c.ok.add(id);
      for (let i = okWaiters.length - 1; i >= 0; i--) {
        if (okWaiters[i].projectId === id) okWaiters.splice(i, 1)[0].resolve();
      }
    });
  }

  function serveWs(ws) {
    const c = { ws, watching: new Set(), ok: new Set() };
    conns.add(c);
    ws.on('message', (raw) => onWsMessage(c, raw));
    ws.on('close', () => conns.delete(c));
    ws.on('error', () => {});
    for (const s of hostStatuses.values()) sendFrame(c, hostFrame(s));
  }

  // ---- audit (audit_file.go) ----

  function record(row) {
    const clean = {};
    for (const [k, v] of Object.entries(row)) if (v !== undefined) clean[k] = v;
    audit.push(clean);
  }

  // refuse records one denied row for a boundary refusal and returns the error.
  function refuse(proj, tool, args, err) {
    if (DENIED.has(err.fileCode)) {
      record({ id: `a${++auditSeq}`, tool, project_id: proj && proj.id, path: args.path, outcome: 'denied', error: err.fileCode });
    }
    return err;
  }

  // Intent row, the op, then the completion row with the same id.
  async function audited(row, fn) {
    const id = `a${++auditSeq}`;
    record({ id, phase: 'intent', ...row, outcome: 'pending' });
    try {
      const out = await fn();
      record({ id, phase: 'completion', ...row, outcome: 'ok' });
      return out;
    } catch (e) {
      record({ id, phase: 'completion', ...row, outcome: 'error', error: e.fileCode || 'ERROR' });
      throw e;
    }
  }

  // gate: read-only, then a symlink probe of every path the mutation touches,
  // then the intent row (file_ops.go gate).
  async function gate(ctx, tool, args, probes, fn) {
    if (ctx.proj.files_read_only) throw refuse(ctx.proj, tool, args, ferr('READ_ONLY', 'This project is read-only'));
    checkHost(ctx.proj);
    for (const p of probes) {
      try { lstatPath(ctx.store, p); } catch (e) { if (e.fileCode === 'SYMLINK') throw refuse(ctx.proj, tool, args, e); }
    }
    return audited({ tool, project_id: ctx.proj.id, path: args.path }, fn);
  }

  const reader = (ctx, rawPath) => {
    const rel = cleanRel(rawPath || '');
    checkHost(ctx.proj);
    return rel;
  };

  // ---- ops: each returns { out, events? } ----

  const OPS = {
    list(ctx, body) {
      const rel = reader(ctx, body.path);
      openDir(ctx.store, rel);
      const entries = [];
      for (const name of ctx.store.names(rel).sort()) {
        if (!body.show_hidden && name.startsWith('.')) continue;
        const info = ctx.store.lstat(joinRel(rel, name));
        if (info) entries.push({ name, type: info.type, size: info.size, mtime_ms: info.mtime_ms });
      }
      return { out: { entries } };
    },

    stat(ctx, body) {
      const rel = reader(ctx, body.path);
      const info = lstatPath(ctx.store, rel);
      if (!info) throw ferr('ENOENT', 'Not found');
      return { out: info };
    },

    read(ctx, body) {
      const rel = reader(ctx, body.path);
      const max = body.max_bytes > 0 && body.max_bytes <= MAX_READ ? body.max_bytes : MAX_READ;
      const info = openFile(ctx.store, rel);
      if (info.size > max) throw ferr('TOO_LARGE', 'File too large', info.size);
      const data = ctx.store.read(rel);
      return { out: { content: data.toString('utf8'), size: data.length } };
    },

    async write(ctx, body) {
      const isB64 = body.encoding === 'base64';
      const data = isB64 ? Buffer.from(body.content || '', 'base64') : Buffer.from(body.content || '', 'utf8');
      const args = { path: body.path || '' };
      let rel;
      try { rel = cleanRel(args.path); } catch (e) { throw refuse(ctx.proj, 'write', args, e); }
      if (rel === '') throw ferr('EISDIR', 'Path is a directory');
      if (data.length > MAX_WRITE) throw ferr('TOO_LARGE', 'File too large', data.length);
      args.path = rel;
      const existed = await gate(ctx, 'write', args, [rel], () => {
        openDir(ctx.store, parentOf(rel));
        const info = lstatPath(ctx.store, rel);
        if (info && body.create_only) throw ferr('EEXIST', 'Already exists');
        if (info && info.type === 'directory') throw ferr('EISDIR', 'Path is a directory');
        ctx.store.put(rel, data);
        return !!info;
      });
      return { out: { path: rel }, events: [[rel, existed ? 'change' : 'rename']] };
    },

    async mkdir(ctx, body) {
      const name = body.name || '';
      const args = { path: joinRel(body.parent || '', name) };
      let parent;
      try { parent = cleanRel(body.parent || ''); } catch (e) { throw refuse(ctx.proj, 'mkdir', args, e); }
      validateName(name);
      args.path = joinRel(parent, name);
      await gate(ctx, 'mkdir', args, [parent], () => {
        openDir(ctx.store, parent);
        if (lstatPath(ctx.store, args.path, { allowFinalLink: true })) throw ferr('EEXIST', 'Already exists');
        ctx.store.mkdir(args.path);
      });
      return { out: { path: args.path }, events: [[args.path, 'rename']] };
    },

    async rename(ctx, body) {
      const args = { path: body.path || '' };
      let rel;
      try { rel = cleanRel(args.path); } catch (e) { throw refuse(ctx.proj, 'rename', args, e); }
      validateName(body.new_name || '');
      if (rel === '') throw ferr('INVALID', 'cannot rename the project root');
      args.path = rel;
      const to = joinRel(parentOf(rel), body.new_name);
      await gate(ctx, 'rename', args, [rel], () => {
        moveNoReplace(ctx.store, rel, to);
      });
      return { out: { path: to }, events: [[rel, 'rename'], [to, 'rename']] };
    },

    async move(ctx, body) {
      const args = { path: body.path || '' };
      let rel;
      let dest;
      try {
        rel = cleanRel(args.path);
        dest = cleanRel(body.dest_dir || '');
      } catch (e) { throw refuse(ctx.proj, 'move', args, e); }
      if (rel === '') throw ferr('INVALID', 'cannot move the project root');
      args.path = rel;
      const to = joinRel(dest, baseOf(rel));
      await gate(ctx, 'move', args, [rel, dest], () => {
        openDir(ctx.store, parentOf(rel));
        openDir(ctx.store, dest);
        if (dest === rel || dest.startsWith(`${rel}/`)) throw ferr('INVALID', 'Invalid operation');
        moveNoReplace(ctx.store, rel, to);
      });
      return { out: { path: to }, events: [[rel, 'rename'], [to, 'rename']] };
    },

    async delete(ctx, body) {
      const args = { path: body.path || '' };
      let rel;
      try { rel = cleanRel(args.path); } catch (e) { throw refuse(ctx.proj, 'delete', args, e); }
      if (rel === '') throw ferr('INVALID', 'cannot delete the project root');
      args.path = rel;
      const trashed = !ctx.proj.host_id;
      await gate(ctx, 'delete', args, [rel], () => {
        if (!lstatPath(ctx.store, rel)) throw ferr('ENOENT', 'Not found');
        ctx.store.rm(rel);
      });
      return { out: { trashed }, events: [[rel, 'rename']] };
    },

    search(ctx, body) {
      const m = searchMatcher({
        query: body.query || '', regex: !!body.regex, word: !!body.word, case_sensitive: body.case_sensitive,
        globs: body.globs || [], max_matches: body.max_matches || 0,
      });
      checkHost(ctx.proj);
      return { out: runSearch(ctx.store, m) };
    },

    async git(ctx, body) {
      const rel = cleanRel(body.cwd || '');
      validateGitArgs(body.args || []);
      checkHost(ctx.proj);
      openDir(ctx.store, rel);
      const max = body.max_bytes > 0 ? Math.min(body.max_bytes, MAX_GIT) : DEFAULT_GIT;
      const res = ctx.store.root
        ? await runGit(pathMod.join(ctx.store.root, rel), body.args, max)
        : { exit_code: 128, stdout: Buffer.alloc(0), stderr: NOT_A_REPO };
      return { out: { exit_code: res.exit_code, stdout_b64: res.stdout.toString('base64'), stderr: res.stderr } };
    },
  };

  // Rename and move share one rule: an existing destination is EEXIST, a link
  // as source is SYMLINK (local.go moveNoReplace).
  function moveNoReplace(store, from, to) {
    const src = lstatPath(store, from);
    if (!src) throw ferr('ENOENT', 'Not found');
    const dst = lstatPath(store, to, { allowFinalLink: true });
    const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase() && store.same(from, to);
    if (dst && !caseOnly) throw ferr('EEXIST', 'Already exists');
    store.mv(from, to);
  }

  const b64Ok = (s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

  async function pastetmp(hostId, body) {
    if (!hosts.has(hostId)) throw ferr('HOST_NOT_FOUND', 'host not found');
    const name = body.name || '';
    if (!/^eve-paste-[0-9]+-[0-9a-f]+\.(png|jpg|gif|webp)$/.test(name)) throw ferr('INVALID', 'invalid paste file name');
    const b64 = body.data_b64 || '';
    if (!b64Ok(b64)) throw ferr('INVALID', 'data_b64 is not base64');
    const data = Buffer.from(b64, 'base64');
    if (data.length > MAX_PASTE) throw ferr('TOO_LARGE', 'File too large', data.length);
    await audited({ tool: 'pastetmp', host_id: hostId }, () => {
      const st = hostStatuses.get(hostId);
      if (st && st.status === 'unreachable') throw ferr('HOST_UNREACHABLE', st.error || `host "${st.name}" unreachable`);
    });
    return { out: { path: `/tmp/${name}` } };
  }

  // ---- HTTP ----

  const FIELDS = {
    list: { path: 'string', show_hidden: 'boolean' },
    stat: { path: 'string' },
    read: { path: 'string', max_bytes: 'number' },
    write: { path: 'string', content: 'string', encoding: 'string', create_only: 'boolean' },
    mkdir: { parent: 'string', name: 'string' },
    rename: { path: 'string', new_name: 'string' },
    move: { path: 'string', dest_dir: 'string' },
    delete: { path: 'string' },
    search: { query: 'string', regex: 'boolean', word: 'boolean', globs: 'array', max_matches: 'number' },
    git: { cwd: 'string', args: 'array', max_bytes: 'number' },
    pastetmp: { name: 'string', data_b64: 'string' },
  };
  const LIMIT = { write: WRITE_BODY_LIMIT, pastetmp: PASTE_BODY_LIMIT };

  // decodeFileBody: size cap, JSON object, field types.
  function decodeBody(op, raw, req) {
    if (Buffer.byteLength(raw) > (LIMIT[op] || BODY_LIMIT)) {
      const len = Number(req.headers['content-length']);
      throw ferr('TOO_LARGE', 'request body too large', len > 0 ? len : undefined);
    }
    let body;
    try { body = JSON.parse(raw); } catch { throw ferr('INVALID', 'invalid JSON body'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw ferr('INVALID', 'invalid JSON body');
    for (const [k, type] of Object.entries(FIELDS[op])) {
      const v = body[k];
      if (v === undefined || v === null) { delete body[k]; continue; }
      const ok = type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === type;
      if (!ok) throw ferr('INVALID', 'invalid JSON body');
    }
    if (op === 'write') {
      if (body.encoding !== undefined && body.encoding !== 'utf8' && body.encoding !== 'base64') throw ferr('INVALID', 'encoding must be utf8 or base64');
      if (body.encoding === 'base64' && !b64Ok(body.content || '')) throw ferr('INVALID', 'content is not base64');
    }
    return body;
  }

  const sendJson = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(`${JSON.stringify(obj)}\n`);
  };

  function sendError(res, e) {
    const code = e.fileCode || 'ERROR';
    const out = { error: e.fileCode ? e.message : 'file operation failed', code };
    if (code === 'TOO_LARGE' && e.fileSize > 0) out.size = e.fileSize;
    sendJson(res, STATUS[code] || 500, out);
  }

  // Console: Go's ServeContent (Range, Content-Length, Accept-Ranges).
  // Host: a forward-only chunked 200 that ignores Range.
  function serveStream(req, res, ctx, rel) {
    openFile(ctx.store, rel);
    const data = ctx.store.read(rel);
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ctx.proj.host_id) {
      res.writeHead(200, headers);
      res.flushHeaders();
      for (let i = 0; i < data.length; i += 64 << 10) res.write(data.subarray(i, i + (64 << 10)));
      return res.end();
    }
    headers['Accept-Ranges'] = 'bytes';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      return res.end(data);
    }
    let start;
    let end;
    if (m[1] === '') { // suffix: the last n bytes
      start = Math.max(0, data.length - Number(m[2]));
      end = data.length - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
    }
    if (start >= data.length || start > end) {
      res.writeHead(416, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Range': `bytes */${data.length}`, 'X-Content-Type-Options': 'nosniff' });
      return res.end('invalid range: failed to overlap\n');
    }
    const chunk = data.subarray(start, end + 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': chunk.length });
    return res.end(chunk);
  }

  const FILE_ROUTE = /^\/api\/projects\/([^/]+)\/files\/(list|stat|read|stream|write|mkdir|rename|move|delete|search|git)$/;
  const PASTE_ROUTE = /^\/api\/hosts\/([^/]+)\/pastetmp$/;

  function match(method, p) {
    let m = FILE_ROUTE.exec(p);
    if (m && (m[2] === 'stream' ? method === 'GET' : method === 'POST')) return { op: m[2], id: decodeURIComponent(m[1]) };
    m = PASTE_ROUTE.exec(p);
    if (m && method === 'POST') return { op: 'pastetmp', id: decodeURIComponent(m[1]) };
    return null;
  }

  async function handle(req, res, route, raw, url) {
    const { op, id } = route;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    requests.push({ op, projectId: id, body: op === 'stream' ? { path: url.searchParams.get('path') } : parsed });
    try {
      const hold = (holds.get(op) || []).shift();
      if (hold) { hold.arrive(); await hold.gate; }
      const fail = (failures.get(op) || []).shift();
      if (fail) {
        return sendJson(res, fail.status, { error: fail.error, code: fail.code });
      }
      if (op === 'pastetmp') {
        const r = await pastetmp(id, decodeBody(op, raw, req));
        return sendJson(res, 200, r.out);
      }
      const proj = openProject(id);
      const ctx = { proj, store: storeFor(id) };
      if (op === 'stream') {
        const rel = cleanRel(url.searchParams.get('path') || '');
        checkHost(proj);
        return serveStream(req, res, ctx, rel);
      }
      const r = await OPS[op](ctx, decodeBody(op, raw, req));
      sendJson(res, 200, r.out);
      if (autoEmit && r.events) res.once('finish', () => r.events.forEach(([p, kind]) => emit(id, p, kind)));
    } catch (e) {
      if (res.headersSent) return res.destroy();
      sendError(res, e);
    }
  }

  // ---- hooks (relay.files) ----

  const need = (projectId) => {
    const proj = projects.get(projectId);
    if (!proj) throw new Error(`relay.files: unknown project ${projectId}`);
    return storeFor(projectId);
  };

  const hooks = {
    seed(projectId, tree) {
      const store = need(projectId);
      for (const [key, value] of Object.entries(tree)) {
        const rel = cleanRel(key);
        if (rel === '') continue;
        ensureParents(store, rel);
        if (key.endsWith('/') || value === null) { if (!store.lstat(rel)) store.mkdir(rel); } else store.put(rel, Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
      }
    },
    useDisk(projectId, dir) { need(projectId); stores.set(projectId, diskStore(dir)); },
    get(projectId, p) {
      const store = storeFor(projectId);
      const rel = cleanRel(p);
      const info = store.lstat(rel);
      if (!info) return null;
      if (info.type === 'directory') return 'dir';
      if (info.type === 'symlink') return { symlink: store.target(rel) };
      return Buffer.from(store.read(rel));
    },
    write(projectId, p, content, { emit: doEmit = true } = {}) {
      const store = need(projectId);
      const rel = cleanRel(p);
      const existed = !!store.lstat(rel);
      ensureParents(store, rel);
      store.put(rel, Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
      if (doEmit) emit(projectId, rel, existed ? 'change' : 'rename');
    },
    remove(projectId, p, { emit: doEmit = true } = {}) {
      const rel = cleanRel(p);
      need(projectId).rm(rel);
      if (doEmit) emit(projectId, rel, 'rename');
    },
    mkdir(projectId, p, { emit: doEmit = true } = {}) {
      const store = need(projectId);
      const rel = cleanRel(p);
      ensureParents(store, rel);
      if (!store.lstat(rel)) store.mkdir(rel);
      if (doEmit) emit(projectId, rel, 'rename');
    },
    symlink(projectId, p, target) {
      const store = need(projectId);
      const rel = cleanRel(p);
      ensureParents(store, rel);
      store.link(rel, target);
    },
    emit,
    // Resolves once a watch_ok has gone out for the project.
    watched: (projectId) => (([...conns].some((c) => c.ok.has(projectId))) ? Promise.resolve() : new Promise((resolve) => okWaiters.push({ projectId, resolve }))),
    watchers: (projectId) => [...conns].filter((c) => c.watching.has(projectId)).length,
    autoEmit: (on) => { autoEmit = !!on; },
    setReadOnly(projectId, on) {
      const proj = projects.get(projectId);
      if (!proj) throw new Error(`relay.files: unknown project ${projectId}`);
      proj.files_read_only = !!on;
    },
    setHostStatus(hostId, { name, status, error }) {
      const s = { host_id: hostId, name, status, error };
      hostStatuses.set(hostId, s);
      for (const c of conns) sendFrame(c, hostFrame(s));
    },
    // The next request for op answers { status, code, error } before anything else.
    failNext(op, { status = 500, code = 'ERROR', error = 'file operation failed' } = {}) {
      if (!failures.has(op)) failures.set(op, []);
      failures.get(op).push({ status, code, error });
    },
    // The next request for op parks on arrival; release() lets it run.
    holdNext(op) {
      let arrive;
      let release;
      const arrived = new Promise((r) => { arrive = r; });
      const gate = new Promise((r) => { release = r; });
      if (!holds.has(op)) holds.set(op, []);
      holds.get(op).push({ arrive, gate });
      return { arrived, release };
    },
    requests,
    audit,
  };

  return {
    match,
    handle,
    serveWs,
    hooks,
    closeAll: () => { for (const c of conns) { try { c.ws.terminate(); } catch {} } },
  };
}

module.exports = { createFakeFiles };
