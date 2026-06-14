/**
 * Increment 1 — the local surface, end-to-end through a real spawned eve, with
 * NO real relay (the fake relay only supplies the project→path mapping). Proves
 * the harness works and exercises file ops + watcher events against real disk.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('eve local surface (spawned server, fake relay)', () => {
  let eve;
  let projectDir;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-proj-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'console.log(1);', 'utf8');

    eve = await startEve({
      projects: [{ id: 'p1', name: 'Test Project', path: projectDir }],
    });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
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

  describe('file ops over WebSocket (real disk)', () => {
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

    it('writes a file (and it lands on disk)', async () => {
      ws.send({ type: 'write_file', projectId: 'p1', path: 'notes.md', content: '# notes' });
      await ws.waitFor((f) => f.type === 'file_saved' && f.path === 'notes.md');
      expect(fs.readFileSync(path.join(projectDir, 'notes.md'), 'utf8')).toBe('# notes');
    });

    it('rejects a path that escapes the project', async () => {
      ws.send({ type: 'read_file', projectId: 'p1', path: '../../etc/passwd' });
      const frame = await ws.waitFor((f) => f.type === 'file_error');
      expect(frame.error).toMatch(/traversal/i);
    });
  });

  describe('watcher events (real fs.watch)', () => {
    it('emits dir_changed when a file appears in a watched project', async () => {
      const ws = await eve.connectWs();
      try {
        // list_directory starts the recursive project watcher.
        ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
        await ws.waitFor((f) => f.type === 'directory_listing');
        // Give fs.watch a moment to attach before mutating the tree.
        await new Promise((r) => setTimeout(r, 300));

        // External write (NOT through eve, so it's not a suppressed self-write).
        fs.writeFileSync(path.join(projectDir, 'appeared.md'), 'new', 'utf8');

        const frame = await ws.waitFor((f) => f.type === 'dir_changed', 8000);
        expect(frame.projectId).toBe('p1');
      } finally {
        await ws.close();
      }
    });
  });
});
