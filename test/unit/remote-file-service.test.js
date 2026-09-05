const RemoteFileService = require('../../remote-file-service');

function fakeAgent() {
  return {
    calls: [],
    request(op, params) {
      this.calls.push({ op, params });
      return Promise.resolve(this._next || { ok: true });
    },
    stream(op, params, onChunk) {
      this.calls.push({ op, params, onChunk });
      onChunk?.(Buffer.from('chunk-1'));
      return Promise.resolve({ ok: true, size: 7 });
    },
  };
}

describe('RemoteFileService', () => {
  let agent, svc;

  beforeEach(() => {
    agent = fakeAgent();
    svc = new RemoteFileService(agent);
  });

  describe('isPathWithin / validatePath (lexical only)', () => {
    it('accepts a path inside root and returns the posix-resolved form', () => {
      expect(svc.validatePath('/srv/app', 'src/index.js')).toBe('/srv/app/src/index.js');
    });

    it('accepts the root itself', () => {
      expect(svc.validatePath('/srv/app', '/')).toBe('/srv/app');
    });

    it('rejects a lexical traversal without ever calling the agent', () => {
      expect(() => svc.validatePath('/srv/app', '../../etc/passwd')).toThrow('Path traversal not allowed');
      expect(agent.calls).toHaveLength(0);
    });

    it('does not resolve symlinks — that half is the agent-side realpath check', () => {
      // No filesystem access at all: a path that is lexically fine (no ../
      // escaping root) passes here even if "link" is actually a symlink that
      // would resolve outside root on the host — the agent's realpath check
      // is what refuses that, not this one.
      expect(() => svc.validatePath('/srv/app', 'link/inside.txt')).not.toThrow();
      expect(agent.calls).toHaveLength(0);
    });
  });

  describe('data ops forward root + relative path to the agent', () => {
    it('listDirectory', async () => {
      agent._next = { ok: true, entries: [{ name: 'a', type: 'file' }] };
      const entries = await svc.listDirectory('/srv/app', '/sub');
      expect(entries).toEqual([{ name: 'a', type: 'file' }]);
      expect(agent.calls[0]).toMatchObject({ op: 'list', params: { root: '/srv/app', path: '/sub', showHidden: false } });
    });

    it('readFile', async () => {
      agent._next = { ok: true, content: 'hi', size: 2 };
      const res = await svc.readFile('/srv/app', 'a.txt');
      expect(res).toEqual({ content: 'hi', size: 2 });
      expect(agent.calls[0]).toMatchObject({ op: 'read', params: { root: '/srv/app', path: 'a.txt' } });
    });

    it('writeFile', async () => {
      await svc.writeFile('/srv/app', 'a.txt', 'hello');
      expect(agent.calls[0]).toMatchObject({ op: 'write', params: { root: '/srv/app', path: 'a.txt', content: 'hello' } });
    });

    it('renameFile rejects a name containing a path separator before hitting the agent', async () => {
      await expect(svc.renameFile('/srv/app', 'a.txt', 'sub/b.txt')).rejects.toThrow('path separators');
      expect(agent.calls).toHaveLength(0);
    });

    it('renameFile forwards newName and returns the agent-reported path', async () => {
      agent._next = { ok: true, path: 'b.txt' };
      const out = await svc.renameFile('/srv/app', 'a.txt', 'b.txt');
      expect(out).toBe('b.txt');
      expect(agent.calls[0]).toMatchObject({ op: 'rename', params: { root: '/srv/app', path: 'a.txt', newName: 'b.txt' } });
    });

    it('moveFile validates both source and destination lexically', async () => {
      agent._next = { ok: true, path: 'sub/a.txt' };
      const out = await svc.moveFile('/srv/app', 'a.txt', 'sub');
      expect(out).toBe('sub/a.txt');
      expect(agent.calls[0]).toMatchObject({ op: 'move', params: { root: '/srv/app', path: 'a.txt', destDir: 'sub' } });
    });

    it('deleteFile', async () => {
      await svc.deleteFile('/srv/app', 'a.txt');
      expect(agent.calls[0]).toMatchObject({ op: 'delete', params: { root: '/srv/app', path: 'a.txt' } });
    });

    it('createDirectory', async () => {
      agent._next = { ok: true, path: 'newdir' };
      const out = await svc.createDirectory('/srv/app', '/', 'newdir');
      expect(out).toBe('newdir');
      expect(agent.calls[0]).toMatchObject({ op: 'mkdir', params: { root: '/srv/app', parent: '/', name: 'newdir' } });
    });

    it('uploadFile (text) joins destDirectory + fileName and calls write', async () => {
      await svc.uploadFile('/srv/app', '/uploads', 'a.txt', 'hi', 'utf8');
      expect(agent.calls[0]).toMatchObject({ op: 'write', params: { root: '/srv/app', path: 'uploads/a.txt', content: 'hi' } });
    });

    it('uploadFile (base64) calls writeb64', async () => {
      await svc.uploadFile('/srv/app', '/uploads', 'a.bin', 'aGk=', 'base64');
      expect(agent.calls[0]).toMatchObject({ op: 'writeb64', params: { root: '/srv/app', path: 'uploads/a.bin', data: 'aGk=' } });
    });

    it('uploadFile rejects a fileName containing a path separator', async () => {
      await expect(svc.uploadFile('/srv/app', '/uploads', 'sub/a.txt', 'x', 'utf8')).rejects.toThrow('path separators');
      expect(agent.calls).toHaveLength(0);
    });
  });

  describe('stream', () => {
    it('delegates to hostAgent.stream and returns the reported size', async () => {
      const chunks = [];
      const res = await svc.stream('/srv/app', 'big.bin', (c) => chunks.push(c));
      expect(res).toEqual({ size: 7 });
      expect(chunks.map((c) => c.toString())).toEqual(['chunk-1']);
      expect(agent.calls[0]).toMatchObject({ op: 'stream', params: { root: '/srv/app', path: 'big.bin' } });
    });

    it('rejects up front for a traversal path without touching the agent', async () => {
      await expect(svc.stream('/srv/app', '../../etc/passwd', () => {})).rejects.toThrow('Path traversal not allowed');
      expect(agent.calls).toHaveLength(0);
    });
  });

  it('every op rejects with "Host is not connected" when there is no agent', async () => {
    const disconnected = new RemoteFileService(null);
    await expect(disconnected.readFile('/srv/app', 'a.txt')).rejects.toThrow('Host is not connected');
    await expect(disconnected.stream('/srv/app', 'a.txt', () => {})).rejects.toThrow('Host is not connected');
  });
});
