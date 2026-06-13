const os = require('os');
const fs = require('fs');
const path = require('path');
const FileHandlers = require('../../file-handlers');

// Fake browser socket: records parsed JSON frames.
function makeWs() {
  const ws = { sent: [], send: jest.fn((data) => ws.sent.push(JSON.parse(data))) };
  return ws;
}

describe('FileHandlers (WS file-op adapter)', () => {
  let tmpDir;
  let handlers;
  let searchService;
  let ws;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-fh-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log(1);', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# hi', 'utf8');

    searchService = {
      run: jest.fn().mockResolvedValue({ matches: [{ file: 'a' }], truncated: false, durationMs: 7 }),
      cancel: jest.fn(),
    };
    const resolveProject = (id) => (id === 'p1' ? { path: tmpDir } : null);
    handlers = new FileHandlers({ resolveProject, searchService });
    ws = makeWs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const lastFrame = () => ws.sent[ws.sent.length - 1];

  describe('happy paths', () => {
    it('listDirectory returns a directory_listing', async () => {
      await handlers.listDirectory(ws, { projectId: 'p1', path: '/' });
      const f = lastFrame();
      expect(f.type).toBe('directory_listing');
      expect(f.entries.map(e => e.name)).toEqual(expect.arrayContaining(['src', 'README.md']));
    });

    it('readFile returns file_content', async () => {
      await handlers.readFile(ws, { projectId: 'p1', path: 'src/index.js' });
      expect(lastFrame()).toMatchObject({ type: 'file_content', path: 'src/index.js', content: 'console.log(1);' });
    });

    it('writeFile writes and returns file_saved', async () => {
      await handlers.writeFile(ws, { projectId: 'p1', path: 'src/new.js', content: 'x=1' });
      expect(lastFrame()).toMatchObject({ type: 'file_saved', path: 'src/new.js' });
      expect(fs.readFileSync(path.join(tmpDir, 'src', 'new.js'), 'utf8')).toBe('x=1');
    });

    it('uploadFile returns file_uploaded', async () => {
      await handlers.uploadFile(ws, { projectId: 'p1', destDirectory: '', fileName: 'note.txt', content: 'hi', encoding: 'utf8' });
      expect(lastFrame()).toMatchObject({ type: 'file_uploaded', fileName: 'note.txt' });
    });

    it('createDirectory returns directory_created', async () => {
      await handlers.createDirectory(ws, { projectId: 'p1', path: '', name: 'newdir' });
      expect(lastFrame()).toMatchObject({ type: 'directory_created', name: 'newdir' });
    });
  });

  describe('error mapping', () => {
    it('emits file_error when the project is unknown', async () => {
      await handlers.readFile(ws, { projectId: 'nope', path: 'a.txt' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'Project not found' });
    });

    it('emits file_error with the underlying message for a missing file', async () => {
      await handlers.readFile(ws, { projectId: 'p1', path: 'ghost.js' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'File not found' });
    });

    it('emits file_error for a disallowed extension', async () => {
      fs.writeFileSync(path.join(tmpDir, 'pic.png'), 'x', 'utf8');
      await handlers.readFile(ws, { projectId: 'p1', path: 'pic.png' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'File type not allowed for editing' });
    });
  });

  describe('searchProject', () => {
    it('anchors the search to the validated project root and returns search_results', async () => {
      await handlers.searchProject(ws, { requestId: 'r1', projectId: 'p1', query: 'foo', options: {} });
      const safeRoot = handlers.fileService.validatePath(tmpDir, '/');
      expect(searchService.run).toHaveBeenCalledWith(safeRoot, 'foo', expect.objectContaining({ requestId: 'r1' }));
      expect(lastFrame()).toMatchObject({ type: 'search_results', requestId: 'r1', truncated: false });
    });

    it('emits search_error when the project is unknown', async () => {
      await handlers.searchProject(ws, { requestId: 'r1', projectId: 'nope', query: 'foo' });
      expect(lastFrame()).toMatchObject({ type: 'search_error', error: 'Project not found' });
    });

    it('emits search_error when no search service is wired', async () => {
      const noSearch = new FileHandlers({ resolveProject: () => ({ path: tmpDir }), searchService: null });
      await noSearch.searchProject(ws, { requestId: 'r1', projectId: 'p1', query: 'foo' });
      expect(lastFrame()).toMatchObject({ type: 'search_error', error: 'Search not available' });
    });
  });

  // End-to-end: the symlink-escape defense added to FileService must hold when
  // reached through the WS adapter, not just when FileService is called directly.
  describe('symlink escape defense (integration)', () => {
    it('rejects a read through a symlink that escapes the project', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-fh-outside-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
      let supported = true;
      try {
        fs.symlinkSync(outside, path.join(tmpDir, 'escape'), 'dir');
      } catch { supported = false; }
      if (!supported) return;

      await handlers.readFile(ws, { projectId: 'p1', path: 'escape/secret.txt' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'Path traversal not allowed' });

      fs.rmSync(outside, { recursive: true, force: true });
    });
  });
});
