/**
 * Boots the real eve server.js against a host project served by the fake
 * relay's in-memory file plane (relay owns the SSH agent; ../relay/docs/
 * ssh-hosts.md). The host's status comes from the fake on /ws/files, set with
 * relay.files.setHostStatus.
 * Waits: a watch is live when relay.files.watched(projectId) resolves; a host
 * status change arrives as the browser's host_status frame (ws.waitFor).
 */
const { startEve } = require('./harness');

const SSH_SENTINEL = 'acme-ssh-argv-sentinel';
const HOST = {
  id: 'h1', name: 'devbox', target: 'acme@devbox.local', port: 0, identity_file: '',
  status: 'connected', ssh_argv: ['ssh', SSH_SENTINEL],
};

describe('host projects (../relay/docs/ssh-hosts.md)', () => {
  let eve, files, ws;

  beforeEach(async () => {
    eve = await startEve({
      hosts: [HOST],
      projects: [{ id: 'hp1', name: 'Host Project', path: '/srv/acme', host_id: 'h1' }],
      files: { hp1: { 'a.txt': 'hello from the host', 'sub/b.txt': 'needle inside\n' } },
    });
    files = eve.relay.files;
    ws = await eve.connectWs();
  });

  afterEach(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  it('GET /api/projects reports the host with no ssh_argv anywhere in the payload', async () => {
    const res = await eve.get('/api/projects');
    const projects = await res.json();
    const hp = projects.find((p) => p.id === 'hp1');
    expect(hp.hostId).toBe('h1');
    expect(hp.host).toEqual({ id: 'h1', name: 'devbox', status: 'connected' });
    expect(JSON.stringify(projects)).not.toContain(SSH_SENTINEL);
  });

  it('GET /api/hosts reports the host with no ssh_argv in the payload', async () => {
    const res = await eve.get('/api/hosts');
    const hosts = await res.json();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: 'h1', name: 'devbox' });
    expect(JSON.stringify(hosts)).not.toContain(SSH_SENTINEL);
  });

  it('lists the host directory over WS', async () => {
    ws.send({ type: 'list_directory', projectId: 'hp1', path: '/' });
    const frame = await ws.waitFor((f) => f.type === 'directory_listing');
    expect(frame.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
  });

  it('reads a file from the host', async () => {
    ws.send({ type: 'read_file', projectId: 'hp1', path: 'a.txt' });
    const frame = await ws.waitFor((f) => f.type === 'file_content');
    expect(frame.content).toBe('hello from the host');
  });

  it('writes a file on the host and confirms with file_saved', async () => {
    ws.send({ type: 'write_file', projectId: 'hp1', path: 'a.txt', content: 'edited on the host' });
    await ws.waitFor((f) => f.type === 'file_saved');
    expect(files.get('hp1', 'a.txt').toString()).toBe('edited on the host');
  });

  it('refuses an upload over an existing host file, as on a console project', async () => {
    ws.send({ type: 'upload_file', projectId: 'hp1', destDirectory: '', fileName: 'a.txt', content: 'clobber', encoding: 'utf8' });
    const frame = await ws.waitFor((f) => f.type === 'file_error');
    expect(frame.error).toBe('A file with that name already exists');
    expect(files.get('hp1', 'a.txt').toString()).toBe('hello from the host');
    expect(files.requests.filter((r) => r.op === 'write').pop().body.create_only).toBe(true);
  });

  it('refuses a rename over an existing host file', async () => {
    files.write('hp1', 'c.txt', 'c', { emit: false });
    ws.send({ type: 'rename_file', projectId: 'hp1', path: 'a.txt', newName: 'c.txt' });
    const frame = await ws.waitFor((f) => f.type === 'file_error');
    expect(frame.error).toBe('A file or directory with that name already exists');
    expect(files.get('hp1', 'a.txt').toString()).toBe('hello from the host');
  });

  it('pastes a terminal image onto the host through relay and returns the host path', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const res = await fetch(`${eve.baseUrl}/api/terminal/paste-image?host=h1`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    expect(res.status).toBe(200);
    const { path: pasted } = await res.json();
    expect(pasted).toMatch(/^\/tmp\/eve-paste-\d+-[0-9a-f]+\.png$/);
    expect(files.audit.some((r) => r.tool === 'pastetmp' && r.host_id === 'h1')).toBe(true);
  });

  it('emits file_changed after an external edit on the watched host root', async () => {
    ws.send({ type: 'watch_file', projectId: 'hp1', path: 'a.txt' });
    await files.watched('hp1');
    files.write('hp1', 'a.txt', 'changed externally');
    const frame = await ws.waitFor((f) => f.type === 'file_changed' && f.path === 'a.txt');
    expect(frame.content).toBe('changed externally');
  });

  it('searches the host project, mapped into the browser\'s match shape', async () => {
    ws.send({ type: 'search_project', requestId: 'r1', projectId: 'hp1', query: 'needle' });
    const frame = await ws.waitFor((f) => f.type === 'search_results' && f.requestId === 'r1');
    expect(frame.matches).toHaveLength(1);
    expect(frame.matches[0]).toMatchObject({ file: 'sub/b.txt', lineNumber: 1, lineText: 'needle inside' });
    expect(frame.matches[0].submatches[0]).toMatchObject({ start: 0, end: 6 });
  });

  it('streams a host file through GET /api/files', async () => {
    const res = await eve.get('/api/files/hp1/sub/b.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('needle inside\n');
  });

  it('404s GET /api/files for a missing file on the host', async () => {
    const res = await eve.get('/api/files/hp1/nope.txt');
    expect(res.status).toBe(404);
  });

  it('403s a traversal attempt against a host project over GET /api/files', async () => {
    const res = await eve.get('/api/files/hp1/..%2f..%2fetc%2fpasswd');
    expect(res.status).toBe(403);
  });

  it('shows an outside write made the moment a save is acknowledged', async () => {
    ws.send({ type: 'watch_file', projectId: 'hp1', path: 'a.txt' });
    await files.watched('hp1');
    ws.send({ type: 'write_file', projectId: 'hp1', path: 'a.txt', content: 'saved by eve' });
    await ws.waitFor((f) => f.type === 'file_saved');
    const mark = ws.mark();
    files.write('hp1', 'a.txt', 'written by someone else');
    const frame = await ws.waitFor((f) => f.type === 'file_changed' && f.path === 'a.txt' && f.content === 'written by someone else', 5000, mark);
    expect(frame.content).toBe('written by someone else');
  });

  describe('host_status fan-out from relay', () => {
    // list_directory starts the project watch, so relay.files.watched proves eve's /ws/files leg is up.
    async function legUp() {
      ws.send({ type: 'list_directory', projectId: 'hp1', path: '/' });
      await files.watched('hp1');
    }

    it('reaches the browser in the frame shape it always had, with the error text', async () => {
      await legUp();
      const mark = ws.mark();
      files.setHostStatus('h1', { name: 'devbox', status: 'connecting' });
      files.setHostStatus('h1', { name: 'devbox', status: 'unreachable', error: 'timed out' });
      const frame = await ws.waitFor((f) => f.type === 'host_status' && f.status === 'unreachable', 5000, mark);
      expect(frame).toEqual({ type: 'host_status', hostId: 'h1', name: 'devbox', status: 'unreachable', error: 'timed out' });
      const seen = ws.frames.slice(mark).filter((f) => f.type === 'host_status').map((f) => f.status);
      expect(seen).toEqual(['connecting', 'unreachable']);
    });

    it('reaches every connected browser', async () => {
      const ws2 = await eve.connectWs();
      try {
        await legUp();
        files.setHostStatus('h1', { name: 'devbox', status: 'connected' });
        await ws.waitFor((f) => f.type === 'host_status' && f.status === 'connected');
        await ws2.waitFor((f) => f.type === 'host_status' && f.status === 'connected');
      } finally {
        await ws2.close();
      }
    });

    it('catches up a newly-connected browser on a status relay already reported', async () => {
      await legUp();
      files.setHostStatus('h1', { name: 'devbox', status: 'connected' });
      await ws.waitFor((f) => f.type === 'host_status' && f.status === 'connected');

      const ws2 = await eve.connectWs();
      try {
        const frame = await ws2.waitFor((f) => f.type === 'host_status' && f.hostId === 'h1');
        expect(frame).toMatchObject({ status: 'connected', name: 'devbox' });
      } finally {
        await ws2.close();
      }
    });

    it('an unreachable host fails file ops with the host named, and a watch with watch_error', async () => {
      files.setHostStatus('h1', { name: 'devbox', status: 'unreachable', error: 'down' });
      ws.send({ type: 'read_file', projectId: 'hp1', path: 'a.txt' });
      const err = await ws.waitFor((f) => f.type === 'file_error');
      expect(err.error).toBe('Host "devbox" is not connected');

      ws.send({ type: 'list_directory', projectId: 'hp1', path: '/' });
      const watchErr = await ws.waitFor((f) => f.type === 'watch_error');
      expect(watchErr).toEqual({ type: 'watch_error', projectId: 'hp1', reason: 'HOST_UNREACHABLE' });
    });
  });
});

describe('a host added in relay after eve started', () => {
  let eve, ws;

  beforeEach(async () => {
    eve = await startEve({});
    ws = await eve.connectWs();
  });

  afterEach(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  it('is found on first use: the project carries its host and the file plane reaches it', async () => {
    eve.relay.addHost({ ...HOST, id: 'h2', name: 'latebox' });
    eve.relay.addProject({ id: 'hp2', name: 'Late Project', path: '/srv/late', host_id: 'h2' });
    eve.relay.files.seed('hp2', { 'late.txt': 'added later' });

    const projects = await (await eve.get('/api/projects')).json();
    const hp = projects.find((p) => p.id === 'hp2');
    expect(hp.host).toEqual({ id: 'h2', name: 'latebox', status: 'connected' });

    ws.send({ type: 'list_directory', projectId: 'hp2', path: '/' });
    const frame = await ws.waitFor((f) => f.type === 'directory_listing');
    expect(frame.entries.map((e) => e.name)).toEqual(['late.txt']);
  });

  it('reaches the host over WS when only the startup project cache knew the project', async () => {
    // Own eve: relay already holds the project at startup (so the startup
    // refresh caches it), but not its host. No HTTP call follows, so only the
    // WS path can bring the host in.
    await ws.close();
    await eve.stop();
    ws = null;
    eve = await startEve({
      projects: [{ id: 'hp3', name: 'Late Project', path: '/srv/late', host_id: 'h3' }],
      files: { hp3: { 'late.txt': 'added later' } },
    });
    ws = await eve.connectWs();
    eve.relay.addHost({ ...HOST, id: 'h3', name: 'latebox' });

    ws.send({ type: 'list_directory', projectId: 'hp3', path: '/' });
    const frame = await ws.waitFor((f) => f.type === 'directory_listing');
    expect(frame.entries.map((e) => e.name)).toEqual(['late.txt']);
  });
});
