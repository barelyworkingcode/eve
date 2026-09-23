'use strict';

/**
 * Read-only git view of a project for the Changes panel — discovery of the
 * repos/worktrees under a project root, per-repo file status, and the two
 * sides of a single file's diff. Contract: docs/design-git-changes.md
 * ("Contract"). One implementation serves local and SSH-host projects; only
 * the injected `run` differs (createLocalRunner below vs. the remote agent's
 * `git` op wrapped by RemoteFileService).
 *
 * Every path handed to `run`/`listDirectory`/`readFile` is root-relative and
 * POSIX. Callers' repoPath/filePath are untrusted: a repoPath must be a git
 * top-level inside the root, a filePath must stay inside that repo, and refs
 * are always derived here (HEAD or the merge-base), never taken from input.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path').posix;

const SCOPES = new Set(['uncommitted', 'base']);
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
const FILE_MAX_BYTES = 2 * 1024 * 1024;
const SMALL_MAX_BYTES = 64 * 1024;
const MAX_FILES = 5000;
const BINARY_SNIFF_BYTES = 8000;
const RUN_TIMEOUT_MS = 10000;

// Prepended to every git invocation. quotepath=off keeps non-ASCII paths
// verbatim; fsmonitor=false stops a repo's own config from making a status
// poll spawn an arbitrary fsmonitor hook command.
const GIT_PREFIX = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false'];

class GitError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GitError';
    this.code = code; // NOT_A_REPO | GIT_MISSING | TOO_LARGE | TIMEOUT | FAILED
  }
}

/**
 * Local `run` for GitService: execFile (never a shell) with cwd confined to
 * root by the same lexical + realpath check FileService uses. `validatePath`
 * defaults to a FileService instance's (lazy require — file-service.js
 * requires this module).
 */
function createLocalRunner({ validatePath } = {}) {
  let resolve = validatePath;
  if (!resolve) {
    const FileService = require('./file-service');
    const fsvc = new FileService();
    resolve = (root, rel) => fsvc.validatePath(root, rel);
  }

  // Inherit PATH/HOME etc. but drop any GIT_* that would redirect git at a
  // different repo/index (e.g. eve launched from inside a git hook).
  const baseEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) baseEnv[k] = v;
  }
  const env = { ...baseEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

  return async function run(root, cwdRel, args, { maxBytes = STATUS_MAX_BYTES } = {}) {
    let cwd;
    try {
      cwd = resolve(root, cwdRel || '/');
    } catch (err) {
      throw new GitError('NOT_A_REPO', err.message);
    }
    // execFile reports a missing cwd as ENOENT, indistinguishable from a
    // missing git binary — check it first.
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch (_) {
      throw new GitError('NOT_A_REPO', 'Directory not found');
    }

    return new Promise((resolveRun, reject) => {
      execFile('git', args, {
        cwd,
        env,
        encoding: 'buffer',
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: maxBytes,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const stderrText = stderr ? stderr.toString('utf8') : '';
        if (!err) return resolveRun({ code: 0, stdout, stderr: stderrText });
        if (err.code === 'ENOENT') return reject(new GitError('GIT_MISSING', 'git is not installed'));
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(new GitError('TOO_LARGE', 'git output too large'));
        }
        if (err.killed) return reject(new GitError('TIMEOUT', 'git timed out'));
        if (typeof err.code === 'number') {
          return resolveRun({ code: err.code, stdout: stdout || Buffer.alloc(0), stderr: stderrText });
        }
        reject(new GitError('FAILED', err.message));
      });
    });
  };
}

// '/', '', undefined -> '/'; 'a/b/' -> '/a/b'. A path that climbs above the
// root ('/../x') is rejected rather than clamped, matching the remote side.
function normalizeRepoPath(repoPath) {
  const s = String(repoPath == null ? '/' : repoPath);
  const lexical = path.normalize(s.replace(/^\/+/, '') || '.');
  if (s.includes('\0') || lexical === '..' || lexical.startsWith('../')) {
    throw new GitError('NOT_A_REPO', 'Invalid repository path');
  }
  return path.resolve('/', lexical);
}

function stripSlash(rel) {
  return rel.replace(/^\/+/, '');
}

function hasNul(buf) {
  if (buf == null) return false;
  if (Buffer.isBuffer(buf)) return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return String(buf).slice(0, BINARY_SNIFF_BYTES).includes('\0');
}

function splitNul(buf) {
  const parts = buf.toString('utf8').split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// Returns the text after the nth space — porcelain v2 records have a fixed
// number of space-separated fields before the path, which may itself contain
// spaces.
function afterFields(record, n) {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = record.indexOf(' ', idx + 1);
    if (idx === -1) return null;
  }
  return record.slice(idx + 1);
}

// One status letter per the contract: copies fold into A, type changes into M.
function letterFor(ch) {
  switch (ch) {
    case 'A': case 'C': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case 'U': return 'U';
    default: return 'M';
  }
}

// `git status --porcelain=v2 -z --untracked-files=all` -> contract file list.
function parseStatusV2(buf) {
  const fields = splitNul(buf);
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    const kind = rec[0];
    if (kind === '1') {
      const xy = rec.slice(2, 4);
      const p = afterFields(rec, 8);
      if (p == null) continue;
      const x = xy[0];
      const y = xy[1];
      // Report the change vs HEAD (what `git diff HEAD` shows), not the last
      // step: new in the index stays A even when edited again, and a
      // worktree delete wins over any index change. Added-then-deleted
      // (`AD`) is absent on both sides vs HEAD, so it isn't a change.
      let status;
      if (y === 'D') {
        if (x === 'A') continue;
        status = 'D';
      } else if (x === 'A') {
        status = 'A';
      } else {
        status = letterFor(y !== '.' ? y : x);
      }
      files.push({ path: p, status, staged: x !== '.' });
    } else if (kind === '2') {
      const xy = rec.slice(2, 4);
      const p = afterFields(rec, 9);
      const orig = fields[++i];
      if (p == null) continue;
      const x = xy[0];
      const y = xy[1];
      // A rename/copy record: surface the rename even if the worktree side
      // also modified it — oldPath is the useful part. A worktree delete wins.
      let status;
      if (y === 'D') status = 'D';
      else if (x === 'R' || y === 'R') status = 'R';
      else status = 'A'; // copy
      const entry = { path: p, status, staged: x !== '.' };
      if (orig != null && status !== 'D') entry.oldPath = orig;
      files.push(entry);
    } else if (kind === 'u') {
      const p = afterFields(rec, 10);
      if (p != null) files.push({ path: p, status: 'U', staged: false });
    } else if (kind === '?') {
      // A trailing slash marks a nested repo/worktree — listed as its own group.
      if (!rec.endsWith('/')) files.push({ path: rec.slice(2), status: '?', staged: false });
    }
    // '!' (ignored) and '#' (headers) are skipped.
  }
  return files;
}

// `git diff --name-status -z -M <base>` -> contract file list.
function parseNameStatus(buf) {
  const fields = splitNul(buf);
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i][0];
    if (code === 'R' || code === 'C') {
      const oldPath = fields[++i];
      const newPath = fields[++i];
      if (newPath == null) break;
      const entry = { path: newPath, status: code === 'R' ? 'R' : 'A', staged: false };
      if (code === 'R') entry.oldPath = oldPath;
      files.push(entry);
    } else {
      const p = fields[++i];
      if (p == null) break;
      files.push({ path: p, status: letterFor(code), staged: false });
    }
  }
  return files;
}

class GitService {
  static assertScope(scope) {
    if (!SCOPES.has(scope)) throw new GitError('FAILED', `Invalid scope: ${scope}`);
  }

  constructor({ run, listDirectory, readFile }) {
    this._runRaw = run;
    this.listDirectory = listDirectory;
    this.readFile = readFile;
  }

  _run(root, cwdRel, args, maxBytes = SMALL_MAX_BYTES) {
    return this._runRaw(root, cwdRel, [...GIT_PREFIX, ...args], { maxBytes });
  }

  async _text(root, cwdRel, args) {
    const res = await this._run(root, cwdRel, args);
    return { code: res.code, out: res.stdout.toString('utf8').trim() };
  }

  // { toplevel, prefix } when cwdRel is inside a work tree, else null.
  // prefix === '' means cwdRel IS the top-level.
  async _probe(root, cwdRel) {
    let res;
    try {
      res = await this._run(root, cwdRel, ['rev-parse', '--show-toplevel', '--show-prefix']);
    } catch (err) {
      if (err instanceof GitError && err.code === 'NOT_A_REPO') return null;
      throw err;
    }
    if (res.code !== 0) return null;
    const lines = res.stdout.toString('utf8').split('\n');
    return { toplevel: lines[0], prefix: lines[1] || '' };
  }

  // Confirms an untrusted repoPath is a git top-level inside the root.
  async _resolveRepo(projectPath, repoPath) {
    const rel = normalizeRepoPath(repoPath);
    const probe = await this._probe(projectPath, rel);
    if (!probe || probe.prefix !== '') {
      throw new GitError('NOT_A_REPO', `Not a git repository: ${rel}`);
    }
    return rel;
  }

  async repos(projectPath) {
    const candidates = ['/'];
    let entries = [];
    try {
      entries = await this.listDirectory(projectPath, '/', { showHidden: true });
    } catch (_) {}
    const children = entries.filter(e => e.type === 'directory' && e.name !== '.git');
    const childHits = await Promise.all(children.map(async (e) => {
      try {
        const inner = await this.listDirectory(projectPath, '/' + e.name, { showHidden: true });
        return inner.some(x => x.name === '.git') ? '/' + e.name : null;
      } catch (_) {
        return null;
      }
    }));
    for (const hit of childHits) if (hit) candidates.push(hit);

    // rel -> toplevel, only for candidates that are themselves top-levels.
    const found = new Map();
    const probes = await Promise.all(candidates.map(rel => this._probe(projectPath, rel)));
    // git prints the realpath of the top-level; derive the root's realpath
    // from any hit so worktree paths (also realpaths) can be mapped back.
    let realRoot = null;
    probes.forEach((p, i) => {
      if (!p || p.prefix !== '') return;
      const rel = candidates[i];
      found.set(rel, p.toplevel);
      if (!realRoot) {
        if (rel === '/') realRoot = p.toplevel;
        else if (p.toplevel.endsWith(rel)) realRoot = p.toplevel.slice(0, -rel.length) || '/';
      }
    });

    // Worktrees registered with any found repo, kept only when inside root.
    const lexicalRoot = path.resolve(projectPath);
    const worktreeRels = new Set();
    await Promise.all([...found.keys()].map(async (rel) => {
      // Newline-separated (not -z, which needs git >= 2.36).
      const res = await this._run(projectPath, rel, ['worktree', 'list', '--porcelain'], STATUS_MAX_BYTES)
        .catch(() => null);
      if (!res || res.code !== 0) return;
      for (const field of res.stdout.toString('utf8').split('\n')) {
        if (!field.startsWith('worktree ')) continue;
        const abs = field.slice('worktree '.length);
        for (const base of [realRoot, lexicalRoot]) {
          if (!base) continue;
          if (abs === base || abs.startsWith(base === '/' ? '/' : base + '/')) {
            worktreeRels.add(path.resolve('/', path.relative(base, abs)));
            break;
          }
        }
      }
    }));
    const extra = [...worktreeRels].filter(r => !found.has(r));
    const extraProbes = await Promise.all(extra.map(rel => this._probe(projectPath, rel).catch(() => null)));
    extraProbes.forEach((p, i) => {
      if (p && p.prefix === '') found.set(extra[i], p.toplevel);
    });

    // De-dupe by top-level (a symlinked child could alias another repo).
    const seen = new Set();
    const rels = [];
    for (const [rel, top] of found) {
      if (seen.has(top)) continue;
      seen.add(top);
      rels.push(rel);
    }
    rels.sort((a, b) => {
      if (a === '/') return -1;
      if (b === '/') return 1;
      return a.localeCompare(b);
    });

    return Promise.all(rels.map(rel => this._repoMeta(projectPath, rel)));
  }

  async _repoMeta(root, rel) {
    const [sym, head, upstream, defaultBranch] = await Promise.all([
      this._text(root, rel, ['symbolic-ref', '-q', '--short', 'HEAD']),
      this._text(root, rel, ['rev-parse', '-q', '--verify', 'HEAD']),
      this._text(root, rel, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      this._defaultBranch(root, rel),
    ]);
    let ahead = 0;
    let behind = 0;
    const hasUpstream = upstream.code === 0 && upstream.out && upstream.out !== '@{upstream}';
    if (hasUpstream) {
      const counts = await this._text(root, rel, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      if (counts.code === 0) {
        const [b, a] = counts.out.split(/\s+/).map(n => parseInt(n, 10));
        behind = Number.isFinite(b) ? b : 0;
        ahead = Number.isFinite(a) ? a : 0;
      }
    }
    return {
      path: rel,
      name: rel === '/' ? path.basename(path.resolve(root)) : path.basename(rel),
      branch: sym.code === 0 && sym.out ? sym.out : null,
      head: head.code === 0 && head.out ? head.out.slice(0, 7) : null,
      detached: sym.code !== 0,
      upstream: hasUpstream ? upstream.out : null,
      ahead,
      behind,
      defaultBranch: defaultBranch ? defaultBranch.name : null,
    };
  }

  // origin/HEAD's target, else local main, else master. `ref` is the fully
  // qualified form used for merge-base so a same-named tag can't shadow it.
  async _defaultBranch(root, rel) {
    const res = await this._run(root, rel, [
      'for-each-ref', '--format=%(refname)%00%(symref)',
      'refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master',
    ]);
    if (res.code !== 0) return null;
    const refs = new Map();
    for (const line of res.stdout.toString('utf8').split('\n')) {
      if (!line) continue;
      const [refname, symref] = line.split('\0');
      refs.set(refname, symref || '');
    }
    const originHead = refs.get('refs/remotes/origin/HEAD');
    if (originHead && originHead.startsWith('refs/remotes/')) {
      return { name: originHead.slice('refs/remotes/'.length), ref: originHead };
    }
    if (refs.has('refs/heads/main')) return { name: 'main', ref: 'refs/heads/main' };
    if (refs.has('refs/heads/master')) return { name: 'master', ref: 'refs/heads/master' };
    return null;
  }

  // Full merge-base SHA of HEAD and the default branch, or null.
  async _mergeBase(root, rel) {
    const def = await this._defaultBranch(root, rel);
    if (!def) return null;
    const res = await this._text(root, rel, ['merge-base', 'HEAD', def.ref]);
    return res.code === 0 && res.out ? res.out : null;
  }

  async status(projectPath, repoPath, scope) {
    GitService.assertScope(scope);
    const rel = await this._resolveRepo(projectPath, repoPath);
    const base = scope === 'base' ? await this._mergeBase(projectPath, rel) : null;
    const files = await this._listFiles(projectPath, rel, base);
    const truncated = files.length > MAX_FILES;
    return {
      repo: rel,
      scope,
      base: base ? base.slice(0, 7) : null,
      files: truncated ? files.slice(0, MAX_FILES) : files,
      truncated,
    };
  }

  // Uncommitted status when base is null, else everything vs the merge-base
  // (committed + uncommitted) plus untracked files.
  async _listFiles(root, rel, base) {
    if (!base) {
      const res = await this._run(root, rel,
        ['status', '--porcelain=v2', '-z', '--untracked-files=all'], STATUS_MAX_BYTES);
      if (res.code !== 0) throw new GitError('FAILED', res.stderr.trim() || 'git status failed');
      return parseStatusV2(res.stdout);
    }
    const [diff, others] = await Promise.all([
      this._run(root, rel, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', base, '--'], STATUS_MAX_BYTES),
      this._run(root, rel, ['ls-files', '--others', '--exclude-standard', '-z'], STATUS_MAX_BYTES),
    ]);
    if (diff.code !== 0) throw new GitError('FAILED', diff.stderr.trim() || 'git diff failed');
    const files = parseNameStatus(diff.stdout);
    if (others.code === 0) {
      for (const p of splitNul(others.stdout)) {
        if (!p.endsWith('/')) files.push({ path: p, status: '?', staged: false });
      }
    }
    return files;
  }

  // Blob at `<ref>:<p>` -> { buf, size } | { size, tooLarge } | null (absent).
  async _blob(root, rel, ref, p) {
    const spec = `${ref}:${p}`;
    const sizeRes = await this._text(root, rel, ['cat-file', '-s', spec]);
    if (sizeRes.code !== 0) return null;
    const size = parseInt(sizeRes.out, 10) || 0;
    if (size > FILE_MAX_BYTES) return { size, tooLarge: true };
    // cat-file blob: raw object bytes, no textconv/filters.
    const res = await this._run(root, rel, ['cat-file', 'blob', spec], FILE_MAX_BYTES + 1);
    if (res.code !== 0) return null;
    return { buf: res.stdout, size };
  }

  async fileVersions(projectPath, repoPath, filePath, scope) {
    GitService.assertScope(scope);
    const rel = await this._resolveRepo(projectPath, repoPath);

    const raw = String(filePath == null ? '' : filePath);
    const fileRel = path.normalize(stripSlash(raw));
    if (!fileRel || fileRel === '.' || raw.includes('\0') || fileRel === '..' || fileRel.startsWith('../')) {
      throw new GitError('FAILED', 'Invalid file path');
    }

    const base = scope === 'base' ? await this._mergeBase(projectPath, rel) : null;
    const ref = base || 'HEAD';

    let orig = await this._blob(projectPath, rel, ref, fileRel);
    if (!orig) {
      // Absent at ref: maybe the new side of a rename. Only then pay for the
      // repo's status to find the old path.
      const files = await this._listFiles(projectPath, rel, base).catch(() => []);
      const hit = files.find(f => f.path === fileRel && f.oldPath);
      if (hit) orig = await this._blob(projectPath, rel, ref, hit.oldPath);
    }

    let mod = null;
    try {
      const r = await this.readFile(projectPath, path.join(rel, fileRel));
      mod = { content: r.content, size: r.size };
    } catch (err) {
      const msg = String((err && err.message) || '');
      const code = err && err.code;
      if (code === 'TOO_LARGE' || /too large/i.test(msg)) {
        mod = { size: (err && err.size) || 0, tooLarge: true };
      } else if (code === 'ENOENT' || code === 'EISDIR' || /not found|is a directory/i.test(msg)) {
        mod = null;
      } else {
        throw new GitError('FAILED', msg || 'Failed to read file');
      }
    }

    const originalSize = orig ? orig.size : 0;
    const modifiedSize = mod ? mod.size : 0;
    const tooLarge = Boolean((orig && orig.tooLarge) || (mod && mod.tooLarge)
      || originalSize > FILE_MAX_BYTES || modifiedSize > FILE_MAX_BYTES);
    const binary = !tooLarge && (hasNul(orig && orig.buf) || hasNul(mod && mod.content));

    if (tooLarge || binary) {
      return { original: null, modified: null, binary, tooLarge, originalSize, modifiedSize };
    }
    return {
      original: orig ? orig.buf.toString('utf8') : null,
      modified: mod ? mod.content : null,
      binary: false,
      tooLarge: false,
      originalSize,
      modifiedSize,
    };
  }
}

GitService.FILE_MAX_BYTES = FILE_MAX_BYTES;

module.exports = { GitService, GitError, createLocalRunner };
