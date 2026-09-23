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
const DEFAULT_CONCURRENCY = 6;

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

// `git worktree list --porcelain` (newline form; -z needs git >= 2.36) ->
// [{ path, head, branch, detached, bare, prunable }]. First entry is the main
// worktree (or the bare git dir), so its path identifies the repository.
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, prunable: false };
      out.push(cur);
    } else if (!cur) {
      continue;
    } else if (line === '') {
      cur = null;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  return out;
}

// `# branch.upstream` / `# branch.ab` headers of `git status --porcelain=v2
// --branch -z` -> { upstream, ahead, behind }.
function parseBranchHeaders(buf) {
  const tracking = { upstream: null, ahead: 0, behind: 0 };
  for (const rec of splitNul(buf)) {
    if (rec.startsWith('# branch.upstream ')) {
      tracking.upstream = rec.slice('# branch.upstream '.length) || null;
    } else if (rec.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(rec);
      if (m) {
        tracking.ahead = parseInt(m[1], 10);
        tracking.behind = parseInt(m[2], 10);
      }
    }
  }
  return tracking;
}

// abs -> root-relative ('/x'), trying each form of the root (as given, as git
// reports it); null when outside every form.
function relUnder(abs, bases) {
  for (const base of bases) {
    if (abs === base) return '/';
    if (abs.startsWith(base === '/' ? '/' : base + '/')) return path.resolve('/', path.relative(base, abs));
  }
  return null;
}

const ZERO_SHA = /^0+$/;

class GitService {
  static assertScope(scope) {
    if (!SCOPES.has(scope)) throw new GitError('FAILED', `Invalid scope: ${scope}`);
  }

  constructor({ run, listDirectory, readFile, concurrency = DEFAULT_CONCURRENCY }) {
    this._concurrency = Math.max(1, concurrency | 0);
    this._active = 0;
    this._queue = [];
    // Every runner call goes through the limiter. Each slot covers exactly
    // one runner call and is released before its caller awaits anything
    // else, so no call ever waits for a slot while holding one.
    this._runRaw = (...a) => this._limit(() => run(...a));
    this.listDirectory = (...a) => this._limit(() => listDirectory(...a));
    this.readFile = (...a) => this._limit(() => readFile(...a));
  }

  // FIFO limiter: at most `_concurrency` runner calls in flight.
  _limit(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._active < this._concurrency && this._queue.length) {
      const { fn, resolve, reject } = this._queue.shift();
      this._active++;
      let p;
      try {
        p = Promise.resolve(fn());
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(resolve, reject).finally(() => {
        this._active--;
        this._drain();
      });
    }
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

  // Parsed worktree list run at cwdRel, or null when cwdRel isn't a git context.
  async _worktreeList(root, cwdRel) {
    let res;
    try {
      res = await this._run(root, cwdRel, ['worktree', 'list', '--porcelain'], STATUS_MAX_BYTES);
    } catch (err) {
      if (err instanceof GitError && err.code === 'NOT_A_REPO') return null;
      throw err;
    }
    if (res.code !== 0) return null;
    return parseWorktreeList(res.stdout.toString('utf8'));
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

  /**
   * Discovery (docs/design-git-changes.md, "Discovery"): one listDirectory of
   * the root plus one `git worktree list` at the root cover every worktree of
   * the root's repo in two calls. Only child folders that list doesn't cover
   * are probed for a `.git` entry; each independent repo found that way costs
   * a probe plus its own worktree list. defaultBranch runs once per repository
   * (common git dir), not per worktree.
   */
  async repos(projectPath) {
    const lexicalRoot = path.resolve(projectPath);
    const [entries, rootList] = await Promise.all([
      this.listDirectory(projectPath, '/', { showHidden: true }).catch(() => []),
      this._worktreeList(projectPath, '/'),
    ]);
    const children = entries.filter(e => e.type === 'directory' && e.name !== '.git').map(e => '/' + e.name);
    const rootGit = entries.find(e => e.name === '.git');

    // git prints realpaths; the root may have been given through a symlink.
    const bases = [lexicalRoot];
    let realRootKnown = false;
    const learnRealRoot = (real) => {
      if (realRootKnown || !real) return;
      realRootKnown = true;
      if (!bases.includes(real)) bases.push(real);
    };

    const found = new Map();   // rel -> { abs, branch, head, detached, key, fromList }
    const absSeen = new Set();
    const covered = new Set(); // rels that need no probe (bare git dir)
    const groups = new Map();  // repository key -> cwdRel to resolve defaultBranch at

    const addListEntries = (list, cwdRel) => {
      if (!list || !list.length) return;
      const key = list[0].path;
      if (!groups.has(key)) groups.set(key, cwdRel);
      for (const wt of list) {
        const rel = relUnder(wt.path, bases);
        if (wt.bare) {
          if (rel) covered.add(rel);
          continue;
        }
        if (wt.prunable || !rel || found.has(rel) || absSeen.has(wt.path)) continue;
        found.set(rel, { ...wt, abs: wt.path, key, fromList: true });
        absSeen.add(wt.path);
      }
    };

    if (rootList) {
      const bare = rootList.find(wt => wt.bare);
      if (bare && rootGit && rootGit.type === 'file' && children.includes('/' + path.basename(bare.path))) {
        // Bare-repo layout: `.bare/` (or similar) sits directly in the root.
        learnRealRoot(path.dirname(bare.path));
      } else if (rootGit && rootGit.type === 'directory' && rootList[0] && !rootList[0].bare) {
        // Root is the main worktree, always listed first.
        learnRealRoot(rootList[0].path);
      }
      if (!realRootKnown && rootList.some(wt => !relUnder(wt.path, bases))) {
        // Root is a linked worktree or a subfolder of a repo: ask git once.
        const probe = await this._probe(projectPath, '/');
        if (probe) learnRealRoot(path.join(probe.toplevel, probe.prefix));
      }
      addListEntries(rootList, '/');
    }

    // Children the root's worktree list doesn't cover: independent clones, or
    // every child when the root isn't a git context.
    const uncovered = children.filter(rel => !found.has(rel) && !covered.has(rel));
    const hasGit = await Promise.all(uncovered.map(async (rel) => {
      try {
        const inner = await this.listDirectory(projectPath, rel, { showHidden: true });
        return inner.some(x => x.name === '.git');
      } catch (_) {
        return false;
      }
    }));
    const pending = uncovered.filter((_, i) => hasGit[i]);

    // In waves, so worktrees of one repo found as separate children (no git
    // context at the root) are covered by the first list rather than each
    // paying for their own.
    while (pending.length) {
      const wave = pending.splice(0, this._concurrency);
      const results = await Promise.all(wave.map(rel => Promise.all([
        this._probe(projectPath, rel),
        this._worktreeList(projectPath, rel),
      ])));
      results.forEach(([probe], i) => {
        const rel = wave[i];
        if (probe && probe.prefix === '' && probe.toplevel.endsWith(rel)) {
          learnRealRoot(probe.toplevel.slice(0, -rel.length) || '/');
        }
      });
      results.forEach(([probe, list], i) => {
        const rel = wave[i];
        if (!probe || probe.prefix !== '' || found.has(rel) || absSeen.has(probe.toplevel)) return;
        const own = list && list.find(wt => wt.path === probe.toplevel && !wt.bare);
        const key = list && list.length ? list[0].path : `toplevel:${probe.toplevel}`;
        if (!groups.has(key)) groups.set(key, rel);
        found.set(rel, own
          ? { ...own, abs: probe.toplevel, key, fromList: true }
          : { abs: probe.toplevel, key, fromList: false });
        absSeen.add(probe.toplevel);
        addListEntries(list, rel);
      });
      for (let i = pending.length - 1; i >= 0; i--) {
        if (found.has(pending[i])) pending.splice(i, 1);
      }
    }

    const defaults = new Map();
    for (const { key } of found.values()) {
      if (!defaults.has(key)) defaults.set(key, this._defaultBranch(projectPath, groups.get(key)));
    }

    const rels = [...found.keys()].sort((a, b) => {
      if (a === '/') return -1;
      if (b === '/') return 1;
      return a.localeCompare(b);
    });
    return Promise.all(rels.map(async (rel) => {
      const wt = found.get(rel);
      const [head, def] = await Promise.all([
        wt.fromList ? wt : this._headMeta(projectPath, rel),
        defaults.get(wt.key),
      ]);
      const sha = head.head && !ZERO_SHA.test(head.head) ? head.head : null;
      return {
        path: rel,
        name: rel === '/' ? path.basename(lexicalRoot) : path.basename(rel),
        branch: head.branch || null,
        head: sha ? sha.slice(0, 7) : null,
        detached: !head.branch,
        upstream: null,
        ahead: 0,
        behind: 0,
        defaultBranch: def ? def.name : null,
      };
    }));
  }

  // branch/head for a repo its own worktree list didn't describe.
  async _headMeta(root, rel) {
    const [sym, head] = await Promise.all([
      this._text(root, rel, ['symbolic-ref', '-q', '--short', 'HEAD']),
      this._text(root, rel, ['rev-parse', '-q', '--verify', 'HEAD']),
    ]);
    return {
      branch: sym.code === 0 && sym.out ? sym.out : null,
      head: head.code === 0 && head.out ? head.out : null,
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
    // Uncommitted: upstream/ahead/behind come free with `status --branch`.
    // Base: the file list comes from diff, so ask for tracking alongside it.
    const [{ files, tracking }, baseTracking] = await Promise.all([
      base ? this._listFiles(projectPath, rel, base).then(f => ({ files: f, tracking: null }))
        : this._uncommitted(projectPath, rel),
      base ? this._tracking(projectPath, rel) : null,
    ]);
    const { upstream, ahead, behind } = tracking || baseTracking;
    const truncated = files.length > MAX_FILES;
    return {
      repo: rel,
      scope,
      base: base ? base.slice(0, 7) : null,
      upstream,
      ahead,
      behind,
      files: truncated ? files.slice(0, MAX_FILES) : files,
      truncated,
    };
  }

  // Working-tree status vs HEAD plus the branch's tracking info.
  async _uncommitted(root, rel) {
    const res = await this._run(root, rel,
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], STATUS_MAX_BYTES);
    if (res.code !== 0) throw new GitError('FAILED', res.stderr.trim() || 'git status failed');
    return { files: parseStatusV2(res.stdout), tracking: parseBranchHeaders(res.stdout) };
  }

  // Upstream name and ahead/behind vs it: one exec without an upstream, two with.
  async _tracking(root, rel) {
    const none = { upstream: null, ahead: 0, behind: 0 };
    const up = await this._text(root, rel, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (up.code !== 0 || !up.out || up.out === '@{upstream}') return none;
    const counts = await this._text(root, rel, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (counts.code !== 0) return { ...none, upstream: up.out };
    const [b, a] = counts.out.split(/\s+/).map(n => parseInt(n, 10));
    return { upstream: up.out, ahead: Number.isFinite(a) ? a : 0, behind: Number.isFinite(b) ? b : 0 };
  }

  // Uncommitted status when base is null, else everything vs the merge-base
  // (committed + uncommitted) plus untracked files.
  async _listFiles(root, rel, base) {
    if (!base) return (await this._uncommitted(root, rel)).files;
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
