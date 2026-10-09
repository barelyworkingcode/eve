// The local surface, end-to-end through a real spawned eve, with NO real
// relay: the fake relay supplies the projects and an in-memory file plane.
// Waits: a watch is live when relay.files.watched(projectId) resolves; a
// change outside eve arrives as the browser frame (ws.waitFor).
const { startEve } = require('./harness');

describe('eve local surface (spawned server, fake relay)', () => {
  const projectDir = '/work/acme';
  let eve;

  beforeAll(async () => {
    eve = await startEve({
      projects: [{ id: 'p1', name: 'Test Project', path: projectDir }],
      files: { p1: { 'README.md': '# Hello', 'src/index.js': 'console.log(1);' } },
    });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
  });

  describe('HTTP', () => {
    it('reports authenticated+trusted over loopback (no passkey)', async () => {
      const res = await eve.get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ authenticated: true, trusted: true });
    });

    it('serves the project list (proxied through the fake relay, normalized)', async () => {
      const res = await eve.get('/api/projects');
      expect(res.status).toBe(200);
      const projects = await res.json();
      expect(projects).toEqual([expect.objectContaining({ id: 'p1', name: 'Test Project', path: projectDir })]);
    });
  });

  describe('file ops over WebSocket', () => {
    let ws;
    beforeAll(async () => { ws = await eve.connectWs(); });
    afterAll(async () => { if (ws) await ws.close(); });

    it('lists a project directory', async () => {
      ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
      const frame = await ws.waitFor((f) => f.type === 'directory_listing');
      expect(frame.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['src', 'README.md']));
    });

    it('reads a file', async () => {
      ws.send({ type: 'read_file', projectId: 'p1', path: 'src/index.js' });
      const frame = await ws.waitFor((f) => f.type === 'file_content' && f.path === 'src/index.js');
      expect(frame.content).toBe('console.log(1);');
    });

    it('writes a file (and relay holds it)', async () => {
      ws.send({ type: 'write_file', projectId: 'p1', path: 'notes.md', content: '# notes' });
      await ws.waitFor((f) => f.type === 'file_saved' && f.path === 'notes.md');
      expect(eve.relay.files.get('p1', 'notes.md').toString()).toBe('# notes');
    });

    it('rejects a path that escapes the project', async () => {
      ws.send({ type: 'read_file', projectId: 'p1', path: '../../etc/passwd' });
      const frame = await ws.waitFor((f) => f.type === 'file_error');
      expect(frame.error).toMatch(/traversal/i);
    });
  });

  describe('watcher events (driven by the fake relay)', () => {
    it('emits dir_changed when a file appears in a watched project', async () => {
      const ws = await eve.connectWs();
      try {
        // list_directory starts the project watch.
        ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
        await ws.waitFor((f) => f.type === 'directory_listing');
        await eve.relay.files.watched('p1');

        // A write outside eve, so it's not a suppressed self-write.
        eve.relay.files.write('p1', 'appeared.md', 'new');

        const frame = await ws.waitFor((f) => f.type === 'dir_changed');
        expect(frame).toMatchObject({ projectId: 'p1', path: '/' });
      } finally {
        await ws.close();
      }
    });

    it('does not report churn inside node_modules, but still reports the real change beside it', async () => {
      eve.relay.files.mkdir('p1', 'node_modules/pkg', { emit: false });
      const ws = await eve.connectWs();
      try {
        ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
        await ws.waitFor((f) => f.type === 'directory_listing');
        await eve.relay.files.watched('p1');
        const from = ws.mark();

        eve.relay.files.write('p1', 'node_modules/pkg/index.js', 'x');
        eve.relay.files.write('p1', 'visible.md', 'y');

        await ws.waitFor((f) => f.type === 'dir_changed' && f.path === '/', 5000, from);
        expect(ws.frames.slice(from).some((f) => JSON.stringify(f).includes('node_modules'))).toBe(false);
      } finally {
        await ws.close();
      }
    });
  });
});
