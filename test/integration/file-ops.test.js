/**
 * File operations over WS that weren't in local-surface: rename/move/upload,
 * and watch_file → file_changed (real fs.watch with content). All real disk;
 * the fake relay only supplies the project→path mapping.
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
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# hi', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'const a = 1;', 'utf8');

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
});
