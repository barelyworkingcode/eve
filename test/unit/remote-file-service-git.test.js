/**
 * RemoteFileService's git surface (docs/design-git-changes.md, "Remote agent
 * op"): `_gitRun` (base64 decode + error-code mapping), `_readFileForGit`
 * (agent-side 2 MB cap, size recovered by `stat`), and the lexical path
 * checks. The real-agent parity suite is test/integration/remote-git-parity.test.js.
 */
const RemoteFileService = require('../../remote-file-service');
const { GitService, GitError } = require('../../git-service');

// Scripted HostAgent: `handlers[op](params)` returns the reply or throws.
function fakeAgent(handlers = {}) {
  return {
    calls: [],
    async request(op, params) {
      this.calls.push({ op, params });
      const h = handlers[op];
      if (!h) throw Object.assign(new Error(`unexpected op ${op}`), { code: 'ERROR' });
      return h(params);
    },
  };
}

const agentError = (message, code) => Object.assign(new Error(message), { code });

describe('RemoteFileService git (fake agent)', () => {
  describe('_gitRun', () => {
    it('forwards root/cwd/args/maxBytes and base64-decodes stdout to a Buffer', async () => {
      const bytes = Buffer.from([0x61, 0x00, 0xff, 0x0a]);
      const agent = fakeAgent({ git: () => ({ ok: true, code: 0, stdout: bytes.toString('base64'), stderr: '' }) });
      const svc = new RemoteFileService(agent);
      const res = await svc._gitRun('/srv/app', '/sub', ['status'], { maxBytes: 99 });
      expect(res).toEqual({ code: 0, stdout: bytes, stderr: '' });
      expect(agent.calls[0]).toEqual({ op: 'git', params: { root: '/srv/app', cwd: '/sub', args: ['status'], maxBytes: 99 } });
    });

    it('passes a non-zero exit through as a resolved result', async () => {
      const agent = fakeAgent({ git: () => ({ ok: true, code: 128, stdout: '', stderr: 'fatal: nope' }) });
      const res = await new RemoteFileService(agent)._gitRun('/srv/app', '/', ['status']);
      expect(res.code).toBe(128);
      expect(res.stdout).toEqual(Buffer.alloc(0));
      expect(res.stderr).toBe('fatal: nope');
    });

    it.each([
      ['NO_DIR', 'NOT_A_REPO'],
      ['GIT_MISSING', 'GIT_MISSING'],
      ['TIMEOUT', 'TIMEOUT'],
      ['TOO_LARGE', 'TOO_LARGE'],
      ['ERROR', 'FAILED'],
      ['EACCES', 'FAILED'],
      [undefined, 'FAILED'], // e.g. HostAgent's "host unreachable" / request timeout
    ])('maps agent error code %s to GitError %s', async (agentCode, expected) => {
      const agent = fakeAgent({ git: () => { throw agentError('boom', agentCode); } });
      const err = await new RemoteFileService(agent)._gitRun('/srv/app', '/', ['status']).catch((e) => e);
      expect(err).toBeInstanceOf(GitError);
      expect(err.code).toBe(expected);
      expect(err.message).toBe('boom');
    });

    it('rejects FAILED "Host is not connected" with no agent', async () => {
      const err = await new RemoteFileService(null)._gitRun('/srv/app', '/', ['status']).catch((e) => e);
      expect(err).toBeInstanceOf(GitError);
      expect(err).toMatchObject({ code: 'FAILED', message: 'Host is not connected' });
    });
  });

  describe('_readFileForGit', () => {
    it('reads with the 2 MB cap sent to the agent', async () => {
      const agent = fakeAgent({ read: () => ({ ok: true, content: 'hi', size: 2 }) });
      const res = await new RemoteFileService(agent)._readFileForGit('/srv/app', 'a.png');
      expect(res).toEqual({ content: 'hi', size: 2 });
      expect(agent.calls[0].params).toEqual({ root: '/srv/app', path: 'a.png', maxBytes: GitService.FILE_MAX_BYTES });
    });

    it('TOO_LARGE from the agent becomes a GitError carrying the stat size', async () => {
      const agent = fakeAgent({
        read: () => { throw agentError('File too large', 'TOO_LARGE'); },
        stat: () => ({ ok: true, type: 'file', size: 5_000_000 }),
      });
      const err = await new RemoteFileService(agent)._readFileForGit('/srv/app', 'big.txt').catch((e) => e);
      expect(err).toBeInstanceOf(GitError);
      expect(err).toMatchObject({ code: 'TOO_LARGE', size: 5_000_000 });
      expect(agent.calls.map((c) => c.op)).toEqual(['read', 'stat']);
    });

    it('TOO_LARGE still surfaces when the follow-up stat fails (size unknown)', async () => {
      const agent = fakeAgent({
        read: () => { throw agentError('File too large', 'TOO_LARGE'); },
        stat: () => { throw agentError('gone', 'ENOENT'); },
      });
      const err = await new RemoteFileService(agent)._readFileForGit('/srv/app', 'big.txt').catch((e) => e);
      expect(err.code).toBe('TOO_LARGE');
      expect(err.size).toBeUndefined();
    });

    it('other agent errors pass through untouched (ENOENT = deleted side)', async () => {
      const agent = fakeAgent({ read: () => { throw agentError('ENOENT: no such file', 'ENOENT'); } });
      await expect(new RemoteFileService(agent)._readFileForGit('/srv/app', 'gone.txt'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(agent.calls).toHaveLength(1);
    });

    it('refuses a lexical traversal before calling the agent', async () => {
      const agent = fakeAgent({});
      await expect(new RemoteFileService(agent)._readFileForGit('/srv/app', '../../etc/passwd'))
        .rejects.toThrow('Path traversal not allowed');
      expect(agent.calls).toHaveLength(0);
    });
  });

  describe('lexical path checks on the public wrappers', () => {
    it.each([['../../etc'], ['/../..'], ['/..']])(
      'gitStatus refuses repoPath %j as GitError NOT_A_REPO without calling the agent', async (repoPath) => {
        const agent = fakeAgent({});
        const err = await new RemoteFileService(agent).gitStatus('/srv/app', repoPath, 'uncommitted').catch((e) => e);
        expect(err).toBeInstanceOf(GitError);
        expect(err.code).toBe('NOT_A_REPO');
        expect(agent.calls).toHaveLength(0);
      });

    it('gitFileVersions refuses an escaping repoPath (NOT_A_REPO) or filePath (FAILED) without calling the agent', async () => {
      const agent = fakeAgent({});
      const svc = new RemoteFileService(agent);
      const badFile = await svc.gitFileVersions('/srv/app', '/child', '../../../etc/passwd', 'uncommitted').catch((e) => e);
      expect(badFile).toBeInstanceOf(GitError);
      expect(badFile.code).toBe('FAILED');
      const badRepo = await svc.gitFileVersions('/srv/app', '../x', 'a.txt', 'uncommitted').catch((e) => e);
      expect(badRepo).toBeInstanceOf(GitError);
      expect(badRepo.code).toBe('NOT_A_REPO');
      expect(agent.calls).toHaveLength(0);
    });

    it('builds its GitService lazily, once, wired to the agent', async () => {
      const agent = fakeAgent({
        list: () => ({ ok: true, entries: [] }),
        git: () => ({ ok: true, code: 128, stdout: '', stderr: 'not a repo' }),
      });
      const svc = new RemoteFileService(agent);
      expect(svc._gitService).toBeUndefined();
      await expect(svc.gitRepos('/srv/app')).resolves.toEqual([]);
      expect(svc._git()).toBe(svc._gitService);
      expect(agent.calls.every((c) => c.params.root === '/srv/app')).toBe(true);
      expect(agent.calls.some((c) => c.op === 'git')).toBe(true);
    });

    it('with no agent, gitStatus rejects FAILED', async () => {
      const svc = new RemoteFileService(null);
      await expect(svc.gitStatus('/srv/app', '/', 'uncommitted')).rejects.toMatchObject({ code: 'FAILED' });
    });
  });
});
