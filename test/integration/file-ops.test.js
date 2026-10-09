/**
 * File operations over WS that weren't in local-surface: rename/move/upload,
 * and watch_file → file_changed. Eve reaches the files through the fake
 * relay's in-memory file plane; the test changes them with `relay.files` and
 * never waits on a real file system.
 *
 * Waits: eve is booted when /api/auth/status answers (startEve); a watch is
 * live when relay.files.watched(projectId) resolves; an outside change
 * arrives as the browser frame (ws.waitFor); a save is the file_saved frame,
 * then relay.files.get.
 */
const { startEve } = require('./harness');

describe('file ops over WebSocket', () => {
  let eve;
  let files;
  let ws;

  beforeEach(async () => {
    eve = await startEve({
      projects: [{ id: 'p1', name: 'T', path: '/work/acme' }],
      files: { p1: { 'README.md': '# hi', 'src/index.js': 'const a = 1;' } },
    });
    files = eve.relay.files;
    ws = await eve.connectWs();
  });

  afterEach(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  it('renames a file', async () => {
    ws.send({ type: 'rename_file', projectId: 'p1', path: 'README.md', newName: 'DOCS.md' });
    await ws.waitFor((f) => f.type === 'file_renamed');
    expect(files.get('p1', 'DOCS.md').toString()).toBe('# hi');
    expect(files.get('p1', 'README.md')).toBeNull();
  });

  it('moves a file into a subdirectory', async () => {
    ws.send({ type: 'move_file', projectId: 'p1', sourcePath: 'README.md', destDirectory: 'src' });
    await ws.waitFor((f) => f.type === 'file_moved');
    expect(files.get('p1', 'src/README.md').toString()).toBe('# hi');
  });

  it('refuses a rename onto an existing name and leaves both files', async () => {
    ws.send({ type: 'rename_file', projectId: 'p1', path: 'README.md', newName: 'src' });
    const frame = await ws.waitFor((f) => f.type === 'file_error');
    expect(frame.error).toBe('A file or directory with that name already exists');
    expect(files.get('p1', 'README.md').toString()).toBe('# hi');
  });

  it('uploads a file', async () => {
    ws.send({ type: 'upload_file', projectId: 'p1', destDirectory: '', fileName: 'note.txt', content: 'hello', encoding: 'utf8' });
    await ws.waitFor((f) => f.type === 'file_uploaded');
    expect(files.get('p1', 'note.txt').toString()).toBe('hello');
    expect(files.requests.filter((r) => r.op === 'write').pop().body.create_only).toBe(true);
  });

  it('refuses an upload over an existing file and keeps the original', async () => {
    ws.send({ type: 'upload_file', projectId: 'p1', destDirectory: '', fileName: 'README.md', content: 'clobber', encoding: 'utf8' });
    const frame = await ws.waitFor((f) => f.type === 'file_error');
    expect(frame.error).toBe('A file with that name already exists');
    expect(files.get('p1', 'README.md').toString()).toBe('# hi');
  });

  it('emits file_changed when a watched file is edited externally', async () => {
    ws.send({ type: 'watch_file', projectId: 'p1', path: 'src/index.js' });
    await files.watched('p1');
    files.write('p1', 'src/index.js', 'const a = 2; // edited');
    const frame = await ws.waitFor((f) => f.type === 'file_changed' && f.path === 'src/index.js');
    expect(frame).toMatchObject({ projectId: 'p1', content: 'const a = 2; // edited' });
  });

  it('shows an outside write made the moment a save is acknowledged', async () => {
    ws.send({ type: 'watch_file', projectId: 'p1', path: 'src/index.js' });
    await files.watched('p1');
    ws.send({ type: 'write_file', projectId: 'p1', path: 'src/index.js', content: 'saved by eve' });
    await ws.waitFor((f) => f.type === 'file_saved');
    expect(files.get('p1', 'src/index.js').toString()).toBe('saved by eve');
    const mark = ws.mark();
    files.write('p1', 'src/index.js', 'written by someone else');
    const frame = await ws.waitFor((f) => f.type === 'file_changed' && f.path === 'src/index.js' && f.content === 'written by someone else', 5000, mark);
    expect(frame.content).toBe('written by someone else');
  });
});
