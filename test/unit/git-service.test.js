/**
 * GitService (git-service.js) — the Changes panel's read-only git view
 * (docs/design-git-changes.md, "Contract"). Real throwaway repos under
 * os.tmpdir() for discovery / status / fileVersions; a fake `run` for the
 * paths real git can't reach cheaply (5000-file truncation, runner error
 * codes, porcelain edge records).
 */
const fs = require('fs');
const path = require('path');
const FileService = require('../../file-service');
const { GitService, GitError, createLocalRunner } = require('../../git-service');
const { git, write, makeTmp, initRepo, commitAll, headSha } = require('../helpers/git-fixture');

const MB2 = 2 * 1024 * 1024;

// A GitService wired exactly like FileService#_git, optionally recording
// every argv handed to `run`.
function localService({ calls } = {}) {
  const fsvc = new FileService();
  const run = createLocalRunner({ validatePath: (root, rel) => fsvc.validatePath(root, rel) });
  return new GitService({
    run: calls
      ? (root, cwdRel, args, opts) => { calls.push({ cwdRel, args, opts }); return run(root, cwdRel, args, opts); }
      : run,
    listDirectory: (root, rel, opts) => fsvc.listDirectory(root, rel, opts),
    readFile: (root, rel) => fsvc._readFileForGit(root, rel),
  });
}

const byPath = (a, b) => a.path.localeCompare(b.path);

// Strip the fixed `-c k=v` prefix GitService prepends so a fake runner can
// dispatch on the real subcommand.
function stripPrefix(args) {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args.slice(i);
}

// Fake `run`: `handler(subArgs, cwdRel)` returns { code, stdout, stderr }
// (stdout may be a string) or throws.
function fakeRun(handler) {
  return async (root, cwdRel, args) => {
    const res = await handler(stripPrefix(args), cwdRel, args);
    return {
      code: res.code || 0,
      stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout || ''),
      stderr: res.stderr || '',
    };
  };
}

// Minimal git that says `cwdRel` is a top-level repo, then delegates.
function fakeRepoRun(onStatus) {
  return fakeRun((a, cwdRel) => {
    if (a[0] === 'rev-parse' && a.includes('--show-toplevel')) return { stdout: `/abs${cwdRel === '/' ? '' : cwdRel}\n\n` };
    return onStatus(a, cwdRel);
  });
}

describe('GitService', () => {
  let tmp;

  beforeAll(() => {
    tmp = makeTmp('eve-git-svc-');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('repos() discovery', () => {
    let root, outside;

    beforeAll(() => {
      // Deliberately NOT realpath'd: on macOS os.tmpdir() sits under the
      // /var -> /private/var symlink, so git's (realpath) worktree paths must
      // still be mapped back to root-relative ones.
      root = path.join(tmp, 'multi');
      outside = path.join(tmp, 'outside-wt');
      initRepo(path.join(root, 'main'), { 'a.txt': 'one\n' });
      git(path.join(root, 'main'), ['worktree', 'add', '-q', '../feat-login', '-b', 'feat/login']);
      git(path.join(root, 'main'), ['worktree', 'add', '-q', '../group/deep', '-b', 'deep']);
      git(path.join(root, 'main'), ['worktree', 'add', '-q', outside, '-b', 'outside']);
      initRepo(path.join(root, 'clone2'), { 'c.txt': 'c\n' });
      write(root, 'docs/readme.txt', 'not a repo\n');
      write(root, 'notes.txt', 'loose file\n');
    });

    it('finds child clones, child worktrees and in-root worktrees, sorted, each once', async () => {
      const repos = await localService().repos(root);
      expect(repos.map((r) => r.path)).toEqual(['/clone2', '/feat-login', '/group/deep', '/main']);
    });

    it('excludes a worktree registered outside the project root', async () => {
      const repos = await localService().repos(root);
      expect(repos.some((r) => r.name === 'outside-wt')).toBe(false);
      expect(repos.some((r) => r.branch === 'outside')).toBe(false);
    });

    it('reports name, branch, short head and defaultBranch per repo', async () => {
      const repos = await localService().repos(root);
      const feat = repos.find((r) => r.path === '/feat-login');
      expect(feat).toEqual({
        path: '/feat-login',
        name: 'feat-login',
        branch: 'feat/login',
        head: headSha(path.join(root, 'feat-login')).slice(0, 7),
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        defaultBranch: 'main',
      });
      expect(repos.find((r) => r.path === '/group/deep').name).toBe('deep');
    });

    it('returns [] for a project that holds no repo', async () => {
      const plain = path.join(tmp, 'plain');
      write(plain, 'sub/file.txt', 'x');
      await expect(localService().repos(plain)).resolves.toEqual([]);
    });

    it('lists the root repo first, then nested clones and worktrees inside it', async () => {
      const r = initRepo(path.join(tmp, 'rootrepo'), { 'top.txt': 'top\n' });
      initRepo(path.join(r, 'vendor-lib'), { 'v.txt': 'v\n' });
      git(r, ['worktree', 'add', '-q', 'wt', '-b', 'wt']);
      const repos = await localService().repos(r);
      expect(repos.map((x) => x.path)).toEqual(['/', '/vendor-lib', '/wt']);
      expect(repos[0].name).toBe('rootrepo');
    });

    it('de-dupes candidates that resolve to the same top-level', async () => {
      const svc = new GitService({
        run: fakeRun((a, cwdRel) => {
          if (a[0] === 'rev-parse' && a.includes('--show-toplevel')) {
            return cwdRel === '/' ? { code: 128 } : { stdout: '/real/a\n\n' };
          }
          if (a[0] === 'symbolic-ref') return { stdout: 'main\n' };
          if (a[0] === 'rev-parse') return { code: 1 };
          return { stdout: '' };
        }),
        listDirectory: async (root, rel) => (rel === '/'
          ? [{ name: 'a', type: 'directory' }, { name: 'b', type: 'directory' }, { name: '.git', type: 'directory' }]
          : [{ name: '.git', type: 'file' }]),
        readFile: async () => ({ content: '', size: 0 }),
      });
      const repos = await svc.repos('/proj');
      expect(repos.map((r) => r.path)).toEqual(['/a']);
    });
  });

  describe('repo metadata: HEAD states, upstream, defaultBranch', () => {
    it('detached HEAD: branch null, detached true, head is the short SHA', async () => {
      const r = initRepo(path.join(tmp, 'detached'), { 'a.txt': 'a\n' });
      git(r, ['checkout', '-q', '--detach']);
      const [meta] = await localService().repos(r);
      expect(meta).toMatchObject({ path: '/', branch: null, detached: true, head: headSha(r).slice(0, 7) });
    });

    it('unborn HEAD: branch known, head null, not detached, no defaultBranch', async () => {
      const r = initRepo(path.join(tmp, 'unborn'));
      const [meta] = await localService().repos(r);
      expect(meta).toMatchObject({ branch: 'main', head: null, detached: false, defaultBranch: null });
    });

    it('reports upstream with ahead/behind counts', async () => {
      const r = initRepo(path.join(tmp, 'upstream'), { 'a.txt': 'a\n' });
      git(r, ['checkout', '-q', '-b', 'feat']);
      write(r, 'f1.txt', '1'); commitAll(r, 'f1');
      write(r, 'f2.txt', '2'); commitAll(r, 'f2');
      git(r, ['checkout', '-q', 'main']);
      write(r, 'm1.txt', 'm'); commitAll(r, 'm1');
      git(r, ['checkout', '-q', 'feat']);
      git(r, ['branch', '-q', '--set-upstream-to=main']);
      const [meta] = await localService().repos(r);
      expect(meta).toMatchObject({ branch: 'feat', upstream: 'main', ahead: 2, behind: 1 });
    });

    it("defaultBranch prefers origin/HEAD's target", async () => {
      const src = initRepo(path.join(tmp, 'origin-src'), { 'a.txt': 'a\n' }, { branch: 'trunk' });
      const clone = path.join(tmp, 'origin-clone');
      git(tmp, ['clone', '-q', src, clone]);
      const [meta] = await localService().repos(clone);
      expect(meta.defaultBranch).toBe('origin/trunk');
      expect(meta.upstream).toBe('origin/trunk');
    });

    it('defaultBranch falls back to master, and is null with neither main nor master', async () => {
      const m = initRepo(path.join(tmp, 'master-only'), { 'a.txt': 'a\n' }, { branch: 'master' });
      const d = initRepo(path.join(tmp, 'dev-only'), { 'a.txt': 'a\n' }, { branch: 'dev' });
      expect((await localService().repos(m))[0].defaultBranch).toBe('master');
      expect((await localService().repos(d))[0].defaultBranch).toBeNull();
    });
  });

  describe("status(…, 'uncommitted')", () => {
    let r;

    beforeAll(() => {
      r = initRepo(path.join(tmp, 'status'), {
        'mod.txt': 'one\n',
        'stagedmod.txt': 'one\n',
        'del.txt': 'x\n',
        'staged-del.txt': 'x\n',
        'ren-old.txt': 'rename me please\n'.repeat(4),
        'with space.txt': 'a\n',
        'café.txt': 'a\n',
      });
      write(r, 'mod.txt', 'two\n');
      write(r, 'stagedmod.txt', 'two\n'); git(r, ['add', 'stagedmod.txt']);
      fs.rmSync(path.join(r, 'del.txt'));
      git(r, ['rm', '-q', 'staged-del.txt']);
      git(r, ['mv', 'ren-old.txt', 'ren-new.txt']);
      write(r, 'new-staged.txt', 'n\n'); git(r, ['add', 'new-staged.txt']);
      write(r, 'untracked.txt', 'u\n');
      write(r, 'dir/deep.txt', 'u\n');
      write(r, 'with space.txt', 'b\n');
      write(r, 'café.txt', 'b\n');
    });

    it('reports every changed file with its letter and staged flag', async () => {
      const st = await localService().status(r, '/', 'uncommitted');
      expect(st).toMatchObject({ repo: '/', scope: 'uncommitted', base: null, truncated: false });
      expect([...st.files].sort(byPath)).toEqual([
        { path: 'café.txt', status: 'M', staged: false },
        { path: 'del.txt', status: 'D', staged: false },
        { path: 'dir/deep.txt', status: '?', staged: false },
        { path: 'mod.txt', status: 'M', staged: false },
        { path: 'new-staged.txt', status: 'A', staged: true },
        { path: 'ren-new.txt', status: 'R', oldPath: 'ren-old.txt', staged: true },
        { path: 'staged-del.txt', status: 'D', staged: true },
        { path: 'stagedmod.txt', status: 'M', staged: true },
        { path: 'untracked.txt', status: '?', staged: false },
        { path: 'with space.txt', status: 'M', staged: false },
      ].sort(byPath));
    });

    it('a file added to the index then edited again is still A vs HEAD', async () => {
      // Porcelain `AM`: new in the index, modified in the worktree. Against
      // HEAD it did not exist, so the contract letter is A (fileVersions
      // returns original: null for it).
      const a = initRepo(path.join(tmp, 'added-modified'), { 'base.txt': 'b\n' });
      write(a, 'fresh.txt', 'v1\n'); git(a, ['add', 'fresh.txt']);
      write(a, 'fresh.txt', 'v2\n');
      const st = await localService().status(a, '/', 'uncommitted');
      expect(st.files).toEqual([{ path: 'fresh.txt', status: 'A', staged: true }]);
    });

    it('a file added to the index then deleted from the worktree (AD) is dropped', async () => {
      // Porcelain `AD`: absent from HEAD and from the worktree, so vs HEAD
      // there is nothing to show.
      const a = initRepo(path.join(tmp, 'added-deleted'), { 'base.txt': 'b\n' });
      write(a, 'ghost.txt', 'g\n'); git(a, ['add', 'ghost.txt']);
      fs.rmSync(path.join(a, 'ghost.txt'));
      write(a, 'base.txt', 'b2\n');
      const st = await localService().status(a, '/', 'uncommitted');
      expect(st.files).toEqual([{ path: 'base.txt', status: 'M', staged: false }]);
    });

    it('reports a merge conflict as U', async () => {
      const c = initRepo(path.join(tmp, 'conflict'), { 'c.txt': 'base\n' });
      git(c, ['checkout', '-q', '-b', 'other']);
      write(c, 'c.txt', 'other\n'); commitAll(c, 'other');
      git(c, ['checkout', '-q', 'main']);
      write(c, 'c.txt', 'main\n'); commitAll(c, 'main');
      git(c, ['merge', '-q', 'other'], { allowFail: true });
      const st = await localService().status(c, '/', 'uncommitted');
      expect(st.files).toEqual([{ path: 'c.txt', status: 'U', staged: false }]);
    });

    it('drops the trailing-slash entries git prints for nested repos/worktrees', async () => {
      const n = initRepo(path.join(tmp, 'nested'), { 'top.txt': 't\n' });
      initRepo(path.join(n, 'inner'), { 'i.txt': 'i\n' });
      git(n, ['worktree', 'add', '-q', 'wt', '-b', 'wt']);
      write(n, 'loose.txt', 'l\n');
      const st = await localService().status(n, '/', 'uncommitted');
      expect(st.files).toEqual([{ path: 'loose.txt', status: '?', staged: false }]);
    });

    it('a clean repo has no files', async () => {
      const c = initRepo(path.join(tmp, 'clean'), { 'a.txt': 'a\n' });
      const st = await localService().status(c, '/', 'uncommitted');
      expect(st).toEqual({ repo: '/', scope: 'uncommitted', base: null, files: [], truncated: false });
    });

    it('works on a child repo addressed by its root-relative path', async () => {
      const p = path.join(tmp, 'parent-of-child');
      const child = initRepo(path.join(p, 'child'), { 'a.txt': 'a\n' });
      write(child, 'a.txt', 'b\n');
      const st = await localService().status(p, '/child', 'uncommitted');
      expect(st.repo).toBe('/child');
      expect(st.files).toEqual([{ path: 'a.txt', status: 'M', staged: false }]);
    });

    it('rejects an unknown scope', async () => {
      await expect(localService().status(r, '/', 'everything')).rejects.toMatchObject({ code: 'FAILED' });
    });
  });

  describe('porcelain parsing edge records (fake run)', () => {
    function svcWithStatus(records) {
      return new GitService({
        run: fakeRepoRun((a) => (a[0] === 'status' ? { stdout: records.join('\0') + '\0' } : { code: 1 })),
        listDirectory: async () => [],
        readFile: async () => ({ content: '', size: 0 }),
      });
    }

    it('folds copies into A and type changes into M; skips headers and ignored entries', async () => {
      const st = await svcWithStatus([
        '# branch.oid abc',
        '1 .T N... 100644 120000 120000 aaa bbb link',
        '1 M. N... 100644 100644 100644 aaa bbb path with spaces.txt',
        '2 C. N... 100644 100644 100644 aaa bbb C100 copy.txt', 'orig.txt',
        '2 RM N... 100644 100644 100644 aaa bbb R90 new name.txt', 'old name.txt',
        '2 RD N... 100644 100644 000000 aaa bbb R100 gone.txt', 'was.txt',
        '! ignored.log',
      ]).status('/p', '/', 'uncommitted');
      expect(st.files).toEqual([
        { path: 'link', status: 'M', staged: false },
        { path: 'path with spaces.txt', status: 'M', staged: true },
        expect.objectContaining({ path: 'copy.txt', status: 'A', staged: true }),
        { path: 'new name.txt', status: 'R', staged: true, oldPath: 'old name.txt' },
        { path: 'gone.txt', status: 'D', staged: true },
      ]);
    });

    it('truncates at 5000 files and says so', async () => {
      const many = Array.from({ length: 5001 }, (_, i) => `? f${i}.txt`);
      const st = await svcWithStatus(many).status('/p', '/', 'uncommitted');
      expect(st.files).toHaveLength(5000);
      expect(st.truncated).toBe(true);
      expect(st.files[4999].path).toBe('f4999.txt');
    });

    it('exactly 5000 files is not truncated', async () => {
      const many = Array.from({ length: 5000 }, (_, i) => `? f${i}.txt`);
      const st = await svcWithStatus(many).status('/p', '/', 'uncommitted');
      expect(st.files).toHaveLength(5000);
      expect(st.truncated).toBe(false);
    });

    it('a failing git status is a FAILED GitError', async () => {
      const svc = new GitService({
        run: fakeRepoRun((a) => (a[0] === 'status' ? { code: 128, stderr: 'fatal: broken\n' } : { code: 1 })),
        listDirectory: async () => [],
        readFile: async () => ({ content: '', size: 0 }),
      });
      await expect(svc.status('/p', '/', 'uncommitted')).rejects.toMatchObject({ code: 'FAILED', message: 'fatal: broken' });
    });

    it("parses `diff --name-status` for 'base' (R keeps oldPath, C folds to A, T to M)", async () => {
      const diff = ['M', 'm.txt', 'A', 'a.txt', 'D', 'd.txt', 'T', 't.txt', 'R095', 'old.txt', 'new.txt', 'C100', 'src.txt', 'cp.txt'];
      const svc = new GitService({
        run: fakeRepoRun((a) => {
          if (a[0] === 'for-each-ref') return { stdout: 'refs/heads/main\0\n' };
          if (a[0] === 'merge-base') return { stdout: 'abcdef0123456789\n' };
          if (a[0] === 'diff') return { stdout: diff.join('\0') + '\0' };
          if (a[0] === 'ls-files') return { stdout: 'u.txt\0nested/\0' };
          return { code: 1 };
        }),
        listDirectory: async () => [],
        readFile: async () => ({ content: '', size: 0 }),
      });
      const st = await svc.status('/p', '/', 'base');
      expect(st.base).toBe('abcdef0');
      expect(st.files).toEqual([
        { path: 'm.txt', status: 'M', staged: false },
        { path: 'a.txt', status: 'A', staged: false },
        { path: 'd.txt', status: 'D', staged: false },
        { path: 't.txt', status: 'M', staged: false },
        { path: 'new.txt', status: 'R', staged: false, oldPath: 'old.txt' },
        { path: 'cp.txt', status: 'A', staged: false },
        { path: 'u.txt', status: '?', staged: false },
      ]);
    });
  });

  describe("status(…, 'base')", () => {
    let r, mainSha;

    beforeAll(() => {
      r = initRepo(path.join(tmp, 'base'), {
        'a.txt': 'a-main\n',
        'b.txt': 'b\n',
        'gone.txt': 'gone\n',
        'r1.txt': 'rename me please\n'.repeat(5),
      });
      mainSha = headSha(r);
      git(r, ['checkout', '-q', '-b', 'feat']);
      write(r, 'a.txt', 'a-feat\n');
      write(r, 'committed.txt', 'c\n');
      fs.rmSync(path.join(r, 'gone.txt'));
      git(r, ['mv', 'r1.txt', 'r2.txt']);
      commitAll(r, 'feat work');
      // Advance main past the fork point: its new file must not show up.
      git(r, ['checkout', '-q', 'main']);
      write(r, 'main-only.txt', 'm\n'); commitAll(r, 'main moves on');
      git(r, ['checkout', '-q', 'feat']);
      write(r, 'b.txt', 'b-dirty\n');
      write(r, 'u.txt', 'untracked\n');
    });

    it('lists everything since the merge-base, committed and uncommitted, plus untracked', async () => {
      const st = await localService().status(r, '/', 'base');
      expect(st.base).toBe(mainSha.slice(0, 7));
      expect(st.scope).toBe('base');
      expect([...st.files].sort(byPath)).toEqual([
        { path: 'a.txt', status: 'M', staged: false },
        { path: 'b.txt', status: 'M', staged: false },
        { path: 'committed.txt', status: 'A', staged: false },
        { path: 'gone.txt', status: 'D', staged: false },
        { path: 'r2.txt', status: 'R', oldPath: 'r1.txt', staged: false },
        { path: 'u.txt', status: '?', staged: false },
      ]);
    });

    it('uncommitted scope on the same branch shows only the working-tree changes', async () => {
      const st = await localService().status(r, '/', 'uncommitted');
      expect([...st.files].sort(byPath)).toEqual([
        { path: 'b.txt', status: 'M', staged: false },
        { path: 'u.txt', status: '?', staged: false },
      ]);
    });

    it('falls back to the uncommitted list with base: null when there is no default branch', async () => {
      const d = initRepo(path.join(tmp, 'base-fallback'), { 'a.txt': 'a\n' }, { branch: 'dev' });
      write(d, 'a.txt', 'b\n');
      const st = await localService().status(d, '/', 'base');
      expect(st).toEqual({
        repo: '/', scope: 'base', base: null, truncated: false,
        files: [{ path: 'a.txt', status: 'M', staged: false }],
      });
    });

    it('falls back with base: null on an unborn branch', async () => {
      const u = initRepo(path.join(tmp, 'base-unborn'));
      write(u, 'x.txt', 'x\n');
      const st = await localService().status(u, '/', 'base');
      expect(st.base).toBeNull();
      expect(st.files).toEqual([{ path: 'x.txt', status: '?', staged: false }]);
    });

    it('fileVersions in base scope reads the original at the merge-base', async () => {
      const calls = [];
      const v = await localService({ calls }).fileVersions(r, '/', 'a.txt', 'base');
      expect(v).toEqual({
        original: 'a-main\n', modified: 'a-feat\n', binary: false, tooLarge: false,
        originalSize: 7, modifiedSize: 7,
      });
      const specs = calls.filter((c) => stripPrefix(c.args)[0] === 'cat-file').map((c) => c.args[c.args.length - 1]);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) expect(s.startsWith(`${mainSha}:`)).toBe(true);
    });

    it('fileVersions in base scope follows a committed rename back to the old path', async () => {
      const v = await localService().fileVersions(r, '/', 'r2.txt', 'base');
      expect(v.original).toBe('rename me please\n'.repeat(5));
      expect(v.modified).toBe('rename me please\n'.repeat(5));
    });

    it('fileVersions in uncommitted scope reads the original at HEAD', async () => {
      const v = await localService().fileVersions(r, '/', 'a.txt', 'uncommitted');
      expect(v.original).toBe('a-feat\n');
    });
  });

  describe('fileVersions()', () => {
    let r;
    const bigOrig = 'x'.repeat(MB2 + 10);

    beforeAll(() => {
      r = initRepo(path.join(tmp, 'versions'), {
        'mod.txt': 'one\n',
        'del.txt': 'bye\n',
        'old.txt': 'renamed content\n'.repeat(3),
        'bin.dat': Buffer.from([0x50, 0x00, 0x01, 0x02]),
        'big-orig.txt': bigOrig,
        'big-mod.txt': 'small\n',
        'logo.png': 'fakepng',
        'sub/x.txt': 'x\n',
      });
      write(r, 'mod.txt', 'two\n');
      fs.rmSync(path.join(r, 'del.txt'));
      git(r, ['mv', 'old.txt', 'new.txt']);
      write(r, 'new.txt', 'renamed content\n'.repeat(3) + 'edited\n');
      write(r, 'bin.dat', Buffer.from([0x50, 0x00, 0x01, 0x02, 0x03]));
      write(r, 'big-orig.txt', 'small\n');
      write(r, 'big-mod.txt', 'y'.repeat(MB2 + 20));
      write(r, 'add.txt', 'fresh\n');
      write(r, 'logo.png', 'fakepng2');
    });

    it('modified: HEAD text vs working-tree text', async () => {
      const v = await localService().fileVersions(r, '/', 'mod.txt', 'uncommitted');
      expect(v).toEqual({ original: 'one\n', modified: 'two\n', binary: false, tooLarge: false, originalSize: 4, modifiedSize: 4 });
    });

    it('untracked/added: original is null', async () => {
      const v = await localService().fileVersions(r, '/', 'add.txt', 'uncommitted');
      expect(v).toMatchObject({ original: null, modified: 'fresh\n', originalSize: 0, modifiedSize: 6 });
    });

    it('deleted: modified is null', async () => {
      const v = await localService().fileVersions(r, '/', 'del.txt', 'uncommitted');
      expect(v).toMatchObject({ original: 'bye\n', modified: null, originalSize: 4, modifiedSize: 0 });
    });

    it('renamed: original is read from the old path', async () => {
      const v = await localService().fileVersions(r, '/', 'new.txt', 'uncommitted');
      expect(v.original).toBe('renamed content\n'.repeat(3));
      expect(v.modified).toBe('renamed content\n'.repeat(3) + 'edited\n');
    });

    it('binary (NUL byte): both sides null, sizes kept', async () => {
      const v = await localService().fileVersions(r, '/', 'bin.dat', 'uncommitted');
      expect(v).toEqual({ original: null, modified: null, binary: true, tooLarge: false, originalSize: 4, modifiedSize: 5 });
    });

    it('a non-allowlisted extension is still diffable (no editor allowlist)', async () => {
      const v = await localService().fileVersions(r, '/', 'logo.png', 'uncommitted');
      expect(v).toMatchObject({ original: 'fakepng', modified: 'fakepng2', binary: false });
    });

    it('tooLarge when the original side is over 2 MB', async () => {
      const v = await localService().fileVersions(r, '/', 'big-orig.txt', 'uncommitted');
      expect(v).toEqual({
        original: null, modified: null, binary: false, tooLarge: true,
        originalSize: MB2 + 10, modifiedSize: 6,
      });
    });

    it('tooLarge when the working-tree side is over 2 MB', async () => {
      const v = await localService().fileVersions(r, '/', 'big-mod.txt', 'uncommitted');
      expect(v).toEqual({
        original: null, modified: null, binary: false, tooLarge: true,
        originalSize: 6, modifiedSize: MB2 + 20,
      });
    });

    it('accepts a leading slash on the file path', async () => {
      const v = await localService().fileVersions(r, '/', '/mod.txt', 'uncommitted');
      expect(v.original).toBe('one\n');
    });

    it('never takes a ref from the caller: a "ref:path" file path is just a path', async () => {
      const calls = [];
      const v = await localService({ calls }).fileVersions(r, '/', 'HEAD~1:mod.txt', 'uncommitted');
      expect(v.original).toBeNull();
      expect(v.modified).toBeNull();
      const specs = calls.filter((c) => stripPrefix(c.args)[0] === 'cat-file').map((c) => c.args[c.args.length - 1]);
      for (const s of specs) expect(s).toBe('HEAD:HEAD~1:mod.txt');
    });

    it.each([
      ['../outside.txt'],
      ['sub/../../outside.txt'],
      [''],
      ['.'],
      ['a\0b'],
    ])('rejects file path %j with FAILED', async (bad) => {
      await expect(localService().fileVersions(r, '/', bad, 'uncommitted')).rejects.toMatchObject({ code: 'FAILED' });
    });

    it('rejects a file symlink that escapes the project (FAILED)', async () => {
      const outsideDir = path.join(tmp, 'secret-outside');
      write(outsideDir, 'secret.txt', 'TOP SECRET');
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(r, 'escape.txt'));
      try {
        await expect(localService().fileVersions(r, '/', 'escape.txt', 'uncommitted'))
          .rejects.toMatchObject({ code: 'FAILED' });
      } finally {
        fs.rmSync(path.join(r, 'escape.txt'));
      }
    });

    it.each([
      ['a subdirectory that is not the top-level', '/sub'],
      ['a missing directory', '/nope'],
      ['a lexical escape above the root', '/../../etc'],
      ['a lexical escape that would clamp onto the root repo', '/..'],
      ['a lexical escape through a subdirectory', 'sub/../../..'],
      ['a NUL byte', '/a\0b'],
    ])('rejects repoPath as %s with NOT_A_REPO', async (_label, repoPath) => {
      await expect(localService().fileVersions(r, repoPath, 'mod.txt', 'uncommitted')).rejects.toMatchObject({ code: 'NOT_A_REPO' });
      await expect(localService().status(r, repoPath, 'uncommitted')).rejects.toMatchObject({ code: 'NOT_A_REPO' });
    });

    it('rejects a repoPath symlinked to a repo outside the project with NOT_A_REPO', async () => {
      const ext = initRepo(path.join(tmp, 'external-repo'), { 's.txt': 's\n' });
      const link = path.join(r, 'extlink');
      fs.symlinkSync(ext, link);
      try {
        await expect(localService().status(r, '/extlink', 'uncommitted')).rejects.toMatchObject({ code: 'NOT_A_REPO' });
        await expect(localService().fileVersions(r, '/extlink', 's.txt', 'uncommitted')).rejects.toMatchObject({ code: 'NOT_A_REPO' });
      } finally {
        fs.rmSync(link);
      }
    });

    it('a non-repo project is NOT_A_REPO', async () => {
      const plain = path.join(tmp, 'plain-fv');
      write(plain, 'a.txt', 'a');
      await expect(localService().fileVersions(plain, '/', 'a.txt', 'uncommitted')).rejects.toMatchObject({ code: 'NOT_A_REPO' });
    });

    it('readFile errors: TOO_LARGE carries size, other failures become FAILED', async () => {
      const mk = (readFile) => new GitService({
        run: fakeRepoRun(() => ({ code: 1 })),
        listDirectory: async () => [],
        readFile,
      });
      const big = mk(async () => { throw Object.assign(new GitError('TOO_LARGE', 'File too large to diff'), { size: 9e6 }); });
      await expect(big.fileVersions('/p', '/', 'x.txt', 'uncommitted')).resolves.toMatchObject({ tooLarge: true, modifiedSize: 9e6 });
      const denied = mk(async () => { throw new Error('Permission denied'); });
      await expect(denied.fileVersions('/p', '/', 'x.txt', 'uncommitted')).rejects.toMatchObject({ code: 'FAILED', message: 'Permission denied' });
    });
  });

  describe('runner errors propagate as typed GitErrors', () => {
    it.each(['GIT_MISSING', 'TIMEOUT', 'TOO_LARGE'])('%s from run() rejects repos/status/fileVersions with that code', async (code) => {
      const svc = new GitService({
        run: async () => { throw new GitError(code, code); },
        listDirectory: async () => [],
        readFile: async () => ({ content: '', size: 0 }),
      });
      await expect(svc.repos('/p')).rejects.toMatchObject({ code });
      await expect(svc.status('/p', '/', 'uncommitted')).rejects.toMatchObject({ code });
      await expect(svc.fileVersions('/p', '/', 'a.txt', 'uncommitted')).rejects.toMatchObject({ code });
    });

    it('a status output overflow surfaces as TOO_LARGE, not an empty list', async () => {
      const svc = new GitService({
        run: fakeRepoRun((a) => { if (a[0] === 'status') throw new GitError('TOO_LARGE', 'git output too large'); return { code: 1 }; }),
        listDirectory: async () => [],
        readFile: async () => ({ content: '', size: 0 }),
      });
      await expect(svc.status('/p', '/', 'uncommitted')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });
  });

  describe('hardening', () => {
    it('every git call carries -c core.fsmonitor=false', async () => {
      const r = initRepo(path.join(tmp, 'prefix'), { 'a.txt': 'a\n' });
      write(r, 'a.txt', 'b\n');
      const calls = [];
      const svc = localService({ calls });
      await svc.repos(r);
      await svc.status(r, '/', 'base');
      await svc.fileVersions(r, '/', 'a.txt', 'uncommitted');
      expect(calls.length).toBeGreaterThan(5);
      for (const { args } of calls) {
        const i = args.indexOf('core.fsmonitor=false');
        expect(i).toBeGreaterThan(0);
        expect(args[i - 1]).toBe('-c');
        // Before the subcommand, where git honours -c.
        expect(stripPrefix(args).includes('core.fsmonitor=false')).toBe(false);
      }
    });

    it("a repo's own core.fsmonitor hook is never run by a status poll", async () => {
      const r = initRepo(path.join(tmp, 'fsmonitor'), { 'a.txt': 'a\n' });
      const marker = path.join(tmp, 'fsmonitor-fired');
      const hook = write(tmp, 'fsmonitor-hook.sh', `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      fs.chmodSync(hook, 0o755);
      git(r, ['config', 'core.fsmonitor', hook]);
      // Sanity: plain git does run it, so the assertion below means something.
      git(r, ['status', '--porcelain'], { allowFail: true });
      expect(fs.existsSync(marker)).toBe(true);
      fs.rmSync(marker);

      await localService().status(r, '/', 'uncommitted');
      await localService().repos(r);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('the local runner ignores inherited GIT_* env (GIT_DIR / GIT_WORK_TREE)', async () => {
      const r = initRepo(path.join(tmp, 'envscrub'), { 'a.txt': 'a\n' });
      const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
      process.env.GIT_DIR = path.join(tmp, 'no-such-dir', '.git');
      process.env.GIT_WORK_TREE = path.join(tmp, 'no-such-dir');
      let run;
      try {
        run = createLocalRunner();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
      const res = await run(r, '/', ['rev-parse', '--show-toplevel']);
      expect(res.code).toBe(0);
      expect(res.stdout.toString().trim()).toBe(fs.realpathSync(r));
    });
  });
});

describe('createLocalRunner', () => {
  let tmp;

  beforeAll(() => {
    tmp = makeTmp('eve-git-runner-');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const identity = (root, rel) => path.resolve(root, String(rel).replace(/^\/+/, '') || '.');

  it('resolves (never rejects) on a non-zero exit, with code and stderr', async () => {
    const run = createLocalRunner({ validatePath: identity });
    const res = await run(tmp, '/', ['rev-parse', '--show-toplevel']);
    expect(res.code).not.toBe(0);
    expect(Buffer.isBuffer(res.stdout)).toBe(true);
    expect(res.stderr).toMatch(/not a git repository/i);
  });

  it('TOO_LARGE when stdout exceeds maxBytes', async () => {
    const run = createLocalRunner({ validatePath: identity });
    await expect(run(tmp, '/', ['--version'], { maxBytes: 3 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('NOT_A_REPO for a missing cwd (not GIT_MISSING)', async () => {
    const run = createLocalRunner({ validatePath: identity });
    await expect(run(tmp, '/missing', ['status'])).rejects.toMatchObject({ code: 'NOT_A_REPO' });
  });

  it('NOT_A_REPO when path validation throws (traversal)', async () => {
    const run = createLocalRunner({ validatePath: () => { throw new Error('Path traversal not allowed'); } });
    await expect(run(tmp, '/../..', ['status'])).rejects.toMatchObject({ code: 'NOT_A_REPO' });
  });

  it('GIT_MISSING when git is not on PATH', async () => {
    const emptyBin = fs.mkdtempSync(path.join(tmp, 'bin-'));
    const savedPath = process.env.PATH;
    let run;
    process.env.PATH = emptyBin;
    try {
      run = createLocalRunner({ validatePath: identity });
    } finally {
      process.env.PATH = savedPath;
    }
    await expect(run(tmp, '/', ['--version'])).rejects.toMatchObject({ code: 'GIT_MISSING' });
  });

  describe('with a stubbed execFile', () => {
    function loadWithExecFile(impl) {
      let mod;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: impl }));
        mod = require('../../git-service');
      });
      jest.dontMock('child_process');
      return mod;
    }

    it('TIMEOUT when the child is killed by the 10 s timeout', async () => {
      const { createLocalRunner: create } = loadWithExecFile((cmd, args, opts, cb) => {
        cb(Object.assign(new Error('killed'), { killed: true, code: null, signal: 'SIGTERM' }), Buffer.alloc(0), Buffer.alloc(0));
      });
      const run = create({ validatePath: identity });
      await expect(run(tmp, '/', ['status'])).rejects.toMatchObject({ code: 'TIMEOUT' });
    });

    it('FAILED for any other spawn error', async () => {
      const { createLocalRunner: create } = loadWithExecFile((cmd, args, opts, cb) => {
        cb(Object.assign(new Error('EACCES'), { code: 'EACCES' }), Buffer.alloc(0), Buffer.alloc(0));
      });
      const run = create({ validatePath: identity });
      await expect(run(tmp, '/', ['status'])).rejects.toMatchObject({ code: 'FAILED' });
    });

    it('execs git with an argv array, timeout, maxBuffer, and a GIT_*-free env', async () => {
      const seen = [];
      const { createLocalRunner: create } = loadWithExecFile((cmd, args, opts, cb) => {
        seen.push({ cmd, args, opts });
        cb(null, Buffer.from('ok'), Buffer.alloc(0));
      });
      const saved = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = '/elsewhere/index';
      let run;
      try {
        run = create({ validatePath: identity });
      } finally {
        if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved;
      }
      const res = await run(tmp, '/', ['status', '--porcelain'], { maxBytes: 1234 });
      expect(res).toEqual({ code: 0, stdout: Buffer.from('ok'), stderr: '' });
      const [{ cmd, args, opts }] = seen;
      expect(cmd).toBe('git');
      expect(args).toEqual(['status', '--porcelain']);
      expect(opts).toMatchObject({ cwd: tmp, timeout: 10000, maxBuffer: 1234 });
      expect(opts.shell).toBeFalsy();
      expect(opts.env.GIT_INDEX_FILE).toBeUndefined();
      expect(opts.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
    });
  });
});
