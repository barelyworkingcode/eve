/**
 * FileService's git wrappers (gitRepos / gitStatus / gitFileVersions) and
 * `_readFileForGit`, the diff pane's read path: no editor extension
 * allowlist, 2 MB cap with the size carried on the error.
 * docs/design-git-changes.md ("Contract").
 */
const fs = require('fs');
const path = require('path');
const FileService = require('../../file-service');
const { GitService } = require('../../git-service');
const { makeTmp, initRepo, write } = require('../helpers/git-fixture');

describe('FileService git wrappers', () => {
  let tmp, repo, svc;

  beforeAll(() => {
    tmp = makeTmp('eve-fs-git-');
    repo = initRepo(path.join(tmp, 'proj'), { 'a.txt': 'one\n' });
    write(repo, 'a.txt', 'two\n');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    svc = new FileService();
  });

  it('builds the GitService lazily, once', () => {
    expect(svc._gitService).toBeUndefined();
    const g = svc._git();
    expect(g).toBeInstanceOf(GitService);
    expect(svc._git()).toBe(g);
  });

  it('gitRepos / gitStatus / gitFileVersions delegate to the GitService', async () => {
    const repos = await svc.gitRepos(repo);
    expect(repos.map((r) => r.path)).toEqual(['/']);
    const st = await svc.gitStatus(repo, '/', 'uncommitted');
    expect(st.files).toEqual([{ path: 'a.txt', status: 'M', staged: false }]);
    const v = await svc.gitFileVersions(repo, '/', 'a.txt', 'uncommitted');
    expect(v).toMatchObject({ original: 'one\n', modified: 'two\n' });
  });

  it.each([['bogus'], [undefined], [''], ['UNCOMMITTED']])(
    'rejects scope %j with a FAILED GitError before running git',
    async (scope) => {
      const g = svc._git();
      const status = jest.spyOn(g, 'status');
      const versions = jest.spyOn(g, 'fileVersions');
      await expect(svc.gitStatus(repo, '/', scope)).rejects.toMatchObject({ name: 'GitError', code: 'FAILED' });
      await expect(svc.gitFileVersions(repo, '/', 'a.txt', scope)).rejects.toMatchObject({ code: 'FAILED' });
      expect(status).not.toHaveBeenCalled();
      expect(versions).not.toHaveBeenCalled();
    },
  );

  describe('_readFileForGit', () => {
    it('reads a file the editor allowlist would refuse', async () => {
      write(tmp, 'bin/logo.png', 'png-ish');
      await expect(svc.readFile(tmp, 'bin/logo.png')).rejects.toThrow('File type not allowed');
      await expect(svc._readFileForGit(tmp, 'bin/logo.png')).resolves.toEqual({ content: 'png-ish', size: 7 });
    });

    it('reads a file exactly at the 2 MB cap', async () => {
      write(tmp, 'cap/exact.txt', 'x'.repeat(GitService.FILE_MAX_BYTES));
      const res = await svc._readFileForGit(tmp, 'cap/exact.txt');
      expect(res.size).toBe(GitService.FILE_MAX_BYTES);
    });

    it('throws TOO_LARGE with the size just over the cap', async () => {
      write(tmp, 'cap/over.txt', 'x'.repeat(GitService.FILE_MAX_BYTES + 1));
      await expect(svc._readFileForGit(tmp, 'cap/over.txt'))
        .rejects.toMatchObject({ code: 'TOO_LARGE', size: GitService.FILE_MAX_BYTES + 1 });
    });

    it('missing file: "File not found"', async () => {
      await expect(svc._readFileForGit(tmp, 'nope.txt')).rejects.toThrow('File not found');
    });

    it('directory: "Path is a directory"', async () => {
      await expect(svc._readFileForGit(tmp, 'cap')).rejects.toThrow('Path is a directory');
    });

    it('refuses traversal', async () => {
      await expect(svc._readFileForGit(repo, '../../etc/passwd')).rejects.toThrow('Path traversal not allowed');
    });
  });
});
