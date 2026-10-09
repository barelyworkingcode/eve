const { NullLogger } = require('../../logger');
const mod = require('../../relay-file-client');
const FileHandlers = require('../../file-handlers');

const RelayFileClient = mod.RelayFileClient || mod;

function makeWs() {
  const ws = { sent: [], send: jest.fn((data) => ws.sent.push(JSON.parse(data))) };
  return ws;
}

const PROJECT = { id: 'p1', path: '/work/acme' };
const HOST_PROJECT = { id: 'p2', path: '/srv/acme', hostId: 'h1' };

// FileHandlers over `pf`, the project's file surface, as `files.forProject` hands it out.
function handlersWith(pf, projects = [PROJECT, HOST_PROJECT]) {
  const files = { forProject: jest.fn(() => pf) };
  const h = new FileHandlers({ resolveProject: (id) => projects.find((p) => p.id === id) || null, files });
  return { h, files };
}

describe('FileHandlers (WS file-op adapter)', () => {
  let ws;
  beforeEach(() => { ws = makeWs(); });
  const lastFrame = () => ws.sent[ws.sent.length - 1];

  describe('happy paths', () => {
    it('listDirectory returns a directory_listing', async () => {
      const entries = [{ name: 'src', type: 'directory', size: 0 }, { name: 'README.md', type: 'file', size: 4 }];
      const { h } = handlersWith({ listDirectory: jest.fn().mockResolvedValue(entries) });
      await h.listDirectory(ws, { projectId: 'p1', path: '/' });
      expect(lastFrame()).toEqual({ type: 'directory_listing', projectId: 'p1', path: '/', entries });
    });

    it('readFile returns file_content', async () => {
      const pf = { readFile: jest.fn().mockResolvedValue({ content: 'console.log(1);', size: 15 }) };
      const { h } = handlersWith(pf);
      await h.readFile(ws, { projectId: 'p1', path: 'src/index.js' });
      expect(pf.readFile).toHaveBeenCalledWith('/work/acme', 'src/index.js');
      expect(lastFrame()).toEqual({ type: 'file_content', projectId: 'p1', path: 'src/index.js', content: 'console.log(1);', size: 15 });
    });

    it('writeFile writes and returns file_saved', async () => {
      const pf = { writeFile: jest.fn().mockResolvedValue(undefined) };
      const { h } = handlersWith(pf);
      await h.writeFile(ws, { projectId: 'p1', path: 'src/new.js', content: 'x=1' });
      expect(pf.writeFile).toHaveBeenCalledWith('/work/acme', 'src/new.js', 'x=1');
      expect(lastFrame()).toEqual({ type: 'file_saved', projectId: 'p1', path: 'src/new.js' });
    });

    it('uploadFile returns file_uploaded', async () => {
      const pf = { uploadFile: jest.fn().mockResolvedValue(undefined) };
      const { h } = handlersWith(pf);
      await h.uploadFile(ws, { projectId: 'p1', destDirectory: '', fileName: 'note.txt', content: 'hi', encoding: 'utf8' });
      expect(pf.uploadFile).toHaveBeenCalledWith('/work/acme', '', 'note.txt', 'hi', 'utf8');
      expect(lastFrame()).toMatchObject({ type: 'file_uploaded', fileName: 'note.txt' });
    });

    it('createDirectory returns directory_created with a leading slash', async () => {
      const pf = { createDirectory: jest.fn().mockResolvedValue('newdir') };
      const { h } = handlersWith(pf);
      await h.createDirectory(ws, { projectId: 'p1', path: '', name: 'newdir' });
      expect(lastFrame()).toEqual({ type: 'directory_created', projectId: 'p1', path: '/newdir', name: 'newdir' });
    });

    it('renameFile, moveFile and deleteFile answer with their frames', async () => {
      const pf = {
        renameFile: jest.fn().mockResolvedValue('src/b.js'),
        moveFile: jest.fn().mockResolvedValue('lib/b.js'),
        deleteFile: jest.fn().mockResolvedValue(undefined),
      };
      const { h } = handlersWith(pf);
      await h.renameFile(ws, { projectId: 'p1', path: 'src/a.js', newName: 'b.js' });
      expect(lastFrame()).toEqual({ type: 'file_renamed', projectId: 'p1', oldPath: 'src/a.js', newPath: '/src/b.js' });
      await h.moveFile(ws, { projectId: 'p1', sourcePath: 'src/b.js', destDirectory: 'lib' });
      expect(lastFrame()).toEqual({ type: 'file_moved', projectId: 'p1', oldPath: 'src/b.js', newPath: '/lib/b.js' });
      await h.deleteFile(ws, { projectId: 'p1', path: 'lib/b.js' });
      expect(lastFrame()).toEqual({ type: 'file_deleted', projectId: 'p1', path: 'lib/b.js' });
    });

    it('asks the file client for the project it was given, console or host', async () => {
      const { h, files } = handlersWith({ readFile: jest.fn().mockResolvedValue({ content: '', size: 0 }) });
      await h.readFile(ws, { projectId: 'p2', path: 'a.txt' });
      expect(files.forProject).toHaveBeenCalledWith(HOST_PROJECT);
    });
  });

  describe('error mapping', () => {
    it('emits file_error when the project is unknown', async () => {
      const { h } = handlersWith({});
      await h.readFile(ws, { projectId: 'nope', path: 'a.txt' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'Project not found' });
    });

    it('emits file_error with the underlying message, project and path', async () => {
      const { h } = handlersWith({ readFile: jest.fn().mockRejectedValue(new Error('File not found')) });
      await h.readFile(ws, { projectId: 'p1', path: 'ghost.js' });
      expect(lastFrame()).toEqual({ type: 'file_error', projectId: 'p1', path: 'ghost.js', error: 'File not found' });
    });
  });

  // Through a real RelayFileClient, so relay's code reaches the browser as the text a person reads.
  describe('relay refusals reach the browser as file_error text', () => {
    function realHandlers(reply) {
      const transport = {
        fetch: jest.fn(async () => reply),
        stream: jest.fn(),
        createWebSocket: jest.fn(),
      };
      const files = new RelayFileClient({ relayTransport: transport, log: new NullLogger() });
      const h = new FileHandlers({ resolveProject: (id) => (id === 'p1' ? PROJECT : null), files });
      return { h, transport };
    }

    it.each([
      ['a symlink', { status: 403, data: { code: 'SYMLINK', error: 'x' } }, 'Symbolic links are not opened'],
      ['a read-only project', { status: 403, data: { code: 'READ_ONLY', error: 'x' } }, 'This project is read-only'],
      ['a path leaving the project', { status: 403, data: { code: 'TRAVERSAL', error: 'x' } }, 'Path traversal not allowed'],
    ])('%s', async (_label, reply, message) => {
      const { h } = realHandlers(reply);
      await h.writeFile(ws, { projectId: 'p1', path: 'escape/secret.txt', content: 'x' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: message });
    });

    it('a relay that is down says so', async () => {
      const { h, transport } = realHandlers({});
      transport.fetch.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      await h.readFile(ws, { projectId: 'p1', path: 'a.md' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'Relay is not reachable' });
    });

    it('a file type the editor does not open is refused without asking relay', async () => {
      const { h, transport } = realHandlers({ status: 200, data: {} });
      await h.readFile(ws, { projectId: 'p1', path: 'pic.png' });
      expect(lastFrame()).toMatchObject({ type: 'file_error', error: 'File type not allowed for editing' });
      expect(transport.fetch).not.toHaveBeenCalled();
    });
  });

  describe('searchProject', () => {
    it('returns search_results from the project search with the request options and a signal', async () => {
      const pf = { search: jest.fn().mockResolvedValue({ matches: [{ file: 'a' }], truncated: false, durationMs: 7 }) };
      const { h } = handlersWith(pf);
      await h.searchProject(ws, { requestId: 'r1', projectId: 'p1', query: 'foo', options: { word: true } });
      expect(pf.search).toHaveBeenCalledWith('/work/acme', 'foo', { word: true }, { signal: expect.any(AbortSignal) });
      expect(lastFrame()).toEqual({ type: 'search_results', requestId: 'r1', projectId: 'p1', matches: [{ file: 'a' }], truncated: false, durationMs: 7 });
    });

    it('emits search_error when the project is unknown', async () => {
      const { h } = handlersWith({});
      await h.searchProject(ws, { requestId: 'r1', projectId: 'nope', query: 'foo' });
      expect(lastFrame()).toMatchObject({ type: 'search_error', error: 'Project not found' });
    });

    it('emits search_error with the failure message', async () => {
      const { h } = handlersWith({ search: jest.fn().mockRejectedValue(new Error('Search query is empty')) });
      await h.searchProject(ws, { requestId: 'r1', projectId: 'p1', query: '' });
      expect(lastFrame()).toEqual({ type: 'search_error', requestId: 'r1', projectId: 'p1', error: 'Search query is empty' });
    });

    it('cancelSearch ends a search in flight and the browser, which has moved on, gets no frame', async () => {
      let signal;
      const pf = {
        // Settles the way an aborted relay request does.
        search: jest.fn((_root, _q, _o, ctl) => new Promise((_resolve, reject) => {
          signal = ctl.signal;
          ctl.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })),
      };
      const { h } = handlersWith(pf);
      const done = h.searchProject(ws, { requestId: 'r1', projectId: 'p1', query: 'foo' });
      expect(h.cancelSearch('r1')).toBe(true);
      await done;
      expect(signal.aborted).toBe(true);
      expect(ws.sent).toEqual([]);
      expect(h.cancelSearch('r1')).toBe(false);
    });

    it('cancelSearch for an unknown request does nothing', () => {
      const { h } = handlersWith({});
      expect(h.cancelSearch('never-started')).toBe(false);
    });
  });
});
