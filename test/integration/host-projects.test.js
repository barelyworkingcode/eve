/**
 * Boots the real eve server.js against a host project whose "ssh" is a fake
 * spawner: the fake relay's hostView carries `ssh_argv: [node, remote-fs-agent.js]`,
 * so HostAgent's `child_process.spawn(argv[0], argv.slice(1))` runs the real
 * agent script directly on this machine — no ssh, no second host, exactly
 * ../relay/docs/ssh-hosts.md's "fake ssh" test plan. remote-fs-agent.js
 * ignores argv entirely (it only reads stdin), so the extra `-T -- <node
 * launcher>` HostAgent appends is harmless noise.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

const AGENT_PATH = path.join(__dirname, '..', '..', 'remote-fs-agent.js');

describe('host projects (../relay/docs/ssh-hosts.md)', () => {
  let eve, hostRoot, ws;

  beforeEach(async () => {
    hostRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-host-')));
    fs.writeFileSync(path.join(hostRoot, 'a.txt'), 'hello from the host', 'utf8');
    fs.mkdirSync(path.join(hostRoot, 'sub'));
    fs.writeFileSync(path.join(hostRoot, 'sub', 'b.txt'), 'needle inside\n', 'utf8');

    eve = await startEve({
      hosts: [{
        id: 'h1', name: 'devbox', target: 'admin@devbox.local', port: 0, identity_file: '',
        status: 'connected',
        ssh_argv: [process.execPath, AGENT_PATH],
      }],
      projects: [{ id: 'hp1', name: 'Host Project', path: hostRoot, host_id: 'h1' }],
    });
    ws = await eve.connectWs();
  });

  afterEach(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(hostRoot, { recursive: true, force: true });
  });

  it('GET /api/projects reports the host with no ssh_argv anywhere in the payload', async () => {
    const res = await eve.get('/api/projects');
    const projects = await res.json();
    const hp = projects.find((p) => p.id === 'hp1');
    expect(hp.hostId).toBe('h1');
    expect(hp.host).toEqual({ id: 'h1', name: 'devbox', status: 'connected' });
    expect(JSON.stringify(projects)).not.toContain('ssh_argv');
  });

  it('GET /api/hosts reports the host with no ssh_argv in the payload', async () => {
    const res = await eve.get('/api/hosts');
    const hosts = await res.json();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: 'h1', name: 'devbox' });
    expect(JSON.stringify(hosts)).not.toContain('ssh_argv');
  });

  it('lists the host directory over WS through the agent', async () => {
    ws.send({ type: 'list_directory', projectId: 'hp1', path: '/' });
    const frame = await ws.waitFor((f) => f.type === 'directory_listing');
    const names = frame.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'sub']);
  });

  it('reads a file from the host', async () => {
    ws.send({ type: 'read_file', projectId: 'hp1', path: 'a.txt' });
    const frame = await ws.waitFor((f) => f.type === 'file_content');
    expect(frame.content).toBe('hello from the host');
  });

  it('writes a file on the host and confirms with file_saved', async () => {
    ws.send({ type: 'write_file', projectId: 'hp1', path: 'a.txt', content: 'edited on the host' });
    await ws.waitFor((f) => f.type === 'file_saved');
    expect(fs.readFileSync(path.join(hostRoot, 'a.txt'), 'utf8')).toBe('edited on the host');
  });

  it('emits file_changed after an external edit on the watched host root', async () => {
    ws.send({ type: 'watch_file', projectId: 'hp1', path: 'a.txt' });
    // watch_file itself doesn't reply; give the agent a moment to arm fs.watch
    // before the external edit, mirroring file-ops.test.js's local equivalent.
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(hostRoot, 'a.txt'), 'changed externally', 'utf8');
    const frame = await ws.waitFor((f) => f.type === 'file_changed' && f.path === 'a.txt', 10000);
    expect(frame.content).toBe('changed externally');
  });

  it('searches the host project through the agent, mapped into search-service.js\'s shape', async () => {
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

  it('broadcasts host_status connecting -> connected as the pool spawns the agent', async () => {
    const mark = ws.frames.length;
    ws.send({ type: 'list_directory', projectId: 'hp1', path: '/' });
    await ws.waitFor((f) => f.type === 'host_status' && f.status === 'connected', 5000, mark);
    const statuses = ws.frames.slice(mark).filter((f) => f.type === 'host_status').map((f) => f.status);
    expect(statuses).toContain('connecting');
    expect(statuses[statuses.length - 1]).toBe('connected');
  });

  it('a newly-authenticated connection is caught up on a host status the pool already observed', async () => {
    ws.send({ type: 'list_directory', projectId: 'hp1', path: '/' });
    await ws.waitFor((f) => f.type === 'host_status' && f.status === 'connected');

    const ws2 = await eve.connectWs();
    try {
      const frame = await ws2.waitFor((f) => f.type === 'host_status' && f.hostId === 'h1');
      expect(frame.status).toBe('connected');
    } finally {
      await ws2.close();
    }
  });

  it('a module list on a host project is empty rather than an error', async () => {
    const res = await eve.get('/api/modules?projectId=hp1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modules: [] });
  });
});
