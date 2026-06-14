/**
 * File operations over WS that weren't in local-surface: rename/move/upload,
 * watch_file → file_changed (real fs.watch with content), and the module
 * server-side permissions.files gate. All real disk; the fake relay only
 * supplies the project→path mapping.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('file ops over WebSocket', () => {
  let eve;
  let projectDir;
  let ws;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-fileops-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.mkdirSync(path.join(projectDir, 'data'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# hi', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'const a = 1;', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'data', 'notes.txt'), 'secret notes', 'utf8');
    // A module declaring access to data/notes.txt only.
    const modDir = path.join(projectDir, 'modules', 'demo');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'module.json'), JSON.stringify({
      displayName: 'Demo', entry: 'index.html', permissions: { files: ['data/notes.txt'] },
    }), 'utf8');

    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterEach(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('renames a file', async () => {
    ws.send({ type: 'rename_file', projectId: 'p1', path: 'README.md', newName: 'DOCS.md' });
    await ws.waitFor((f) => f.type === 'file_renamed');
    expect(fs.existsSync(path.join(projectDir, 'DOCS.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'README.md'))).toBe(false);
  });

  it('moves a file into a subdirectory', async () => {
    ws.send({ type: 'move_file', projectId: 'p1', sourcePath: 'README.md', destDirectory: 'src' });
    await ws.waitFor((f) => f.type === 'file_moved');
    expect(fs.existsSync(path.join(projectDir, 'src', 'README.md'))).toBe(true);
  });

  it('uploads a file', async () => {
    ws.send({ type: 'upload_file', projectId: 'p1', destDirectory: '', fileName: 'note.txt', content: 'hello', encoding: 'utf8' });
    await ws.waitFor((f) => f.type === 'file_uploaded');
    expect(fs.readFileSync(path.join(projectDir, 'note.txt'), 'utf8')).toBe('hello');
  });

  it('emits file_changed when a watched file is edited externally', async () => {
    ws.send({ type: 'watch_file', projectId: 'p1', path: 'src/index.js' });
    await new Promise((r) => setTimeout(r, 300)); // let fs.watch attach
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'const a = 2; // edited', 'utf8');
    const frame = await ws.waitFor((f) => f.type === 'file_changed' && f.path === 'src/index.js', 8000);
    expect(frame.projectId).toBe('p1');
  });

  describe('module file permission gate', () => {
    it('reads a file listed in permissions.files', async () => {
      ws.send({ type: 'module_read_file', requestId: 'r1', projectId: 'p1', moduleName: 'demo', path: 'data/notes.txt' });
      const res = await ws.waitFor((f) => f.type === 'module_file_response' && f.requestId === 'r1');
      expect(res).toMatchObject({ ok: true, content: 'secret notes' });
    });

    it('denies a file NOT in permissions.files', async () => {
      ws.send({ type: 'module_read_file', requestId: 'r2', projectId: 'p1', moduleName: 'demo', path: 'README.md' });
      const res = await ws.waitFor((f) => f.type === 'module_file_response' && f.requestId === 'r2');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/permission denied/i);
    });
  });
});
