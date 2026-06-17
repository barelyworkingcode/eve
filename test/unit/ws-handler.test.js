const { EventEmitter } = require('events');

// Low rate-limit ceiling so the throttle test is cheap. Read once at module
// load by ws-handler, so it must be set before the require below.
process.env.EVE_RATELIMIT_MAX = '3';
process.env.EVE_RATELIMIT_WINDOW_MS = '10000';
delete process.env.EVE_NO_AUTH;

// RelayClient and FileWatcher are constructed inside the handler (not injected),
// so mock the modules to inspect dispatch routing without opening real sockets.
jest.mock('../../relay-client');
jest.mock('../../file-watcher');

const RelayClient = require('../../relay-client');
const FileWatcher = require('../../file-watcher');
const createWsHandler = require('../../ws-handler');

const flush = () => new Promise((r) => setImmediate(r));

function makeWs() {
  const ws = new EventEmitter();
  ws.send = jest.fn();
  ws.close = jest.fn();
  return ws;
}

function makeReq() {
  return { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
}

describe('createWsHandler', () => {
  let relayClient;
  let fileWatcher;

  beforeEach(() => {
    relayClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      joinSession: jest.fn(),
      leaveSession: jest.fn(),
      endSession: jest.fn(),
      deleteSession: jest.fn(),
      renameSession: jest.fn(),
      setSessionFolder: jest.fn(),
      stopGeneration: jest.fn(),
      sendPermissionResponse: jest.fn(),
      setPermissionMode: jest.fn(),
      sendMessage: jest.fn(),
      send: jest.fn(),
      setVoiceMode: jest.fn(),
      setSuppressNextJoin: jest.fn(),
      currentSessionId: null,
      sessionDirectory: null,
      voiceMode: false,
    };
    RelayClient.mockImplementation(() => relayClient);

    fileWatcher = {
      watchProject: jest.fn(),
      watch: jest.fn(),
      unwatch: jest.fn(),
      markSelfWrite: jest.fn(),
      closeAll: jest.fn(),
    };
    FileWatcher.mockImplementation(() => fileWatcher);
  });

  // Default deps: NOT enrolled → no auth required → isAuthenticated from the start.
  function makeDeps(overrides = {}) {
    return {
      authService: { isEnrolled: jest.fn(() => false), validateSession: jest.fn(() => true) },
      trustedNetwork: { isTrusted: jest.fn(() => true) },
      relayTransport: {
        fetch: jest.fn().mockResolvedValue({ status: 200, data: { sessionId: 'S1', directory: '/proj1', projectId: 'p1', model: 'gpt' } }),
        createWebSocket: jest.fn(),
      },
      fileHandlers: {
        fileService: { validatePath: jest.fn(() => '/proj1/abs.txt') },
        searchService: { cancel: jest.fn() },
        listDirectory: jest.fn(),
        readFile: jest.fn(),
        writeFile: jest.fn(),
        renameFile: jest.fn(),
        moveFile: jest.fn(),
        deleteFile: jest.fn(),
        uploadFile: jest.fn(),
        createDirectory: jest.fn(),
        searchProject: jest.fn().mockResolvedValue(undefined),
      },
      moduleService: { getModule: jest.fn().mockResolvedValue({}), isFilePermitted: jest.fn(() => true) },
      moduleInvoker: null,
      searchSummarizer: null,
      resolveProject: jest.fn((id) => (id ? { path: '/proj1', permissionPolicy: null } : null)),
      ttsService: null,
      sttService: null,
      uiBus: { register: jest.fn(), unregister: jest.fn(), setProject: jest.fn() },
      log: undefined,
      ...overrides,
    };
  }

  function mount(deps) {
    const ws = makeWs();
    createWsHandler(deps)(ws, makeReq());
    return ws;
  }

  async function sendMsg(ws, obj) {
    ws.emit('message', Buffer.from(JSON.stringify(obj)));
    await flush();
  }

  describe('authentication gate', () => {
    function authRequiredDeps(validateSession) {
      return makeDeps({
        authService: { isEnrolled: () => true, validateSession },
        trustedNetwork: { isTrusted: () => false },
      });
    }

    it('blocks non-auth messages until authenticated', async () => {
      const ws = mount(authRequiredDeps(jest.fn(() => true)));
      await sendMsg(ws, { type: 'join_session', sessionId: 's' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Authentication required' }));
      expect(relayClient.joinSession).not.toHaveBeenCalled();
    });

    it('accepts a valid session token, then lets messages through', async () => {
      const ws = mount(authRequiredDeps(jest.fn(() => true)));
      await sendMsg(ws, { type: 'auth', token: 'good' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth_success' }));
      await sendMsg(ws, { type: 'join_session', sessionId: 's' });
      expect(relayClient.joinSession).toHaveBeenCalledWith('s');
    });

    it('rejects an invalid token, replies auth_failed, and closes 4001', async () => {
      const ws = mount(authRequiredDeps(jest.fn(() => false)));
      await sendMsg(ws, { type: 'auth', token: 'bad' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
      expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    });

    it('when auth is not required, auth frame succeeds without validating the token', async () => {
      const deps = makeDeps(); // not enrolled → no auth
      const ws = mount(deps);
      await sendMsg(ws, { type: 'auth', token: 'whatever' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth_success' }));
      expect(deps.authService.validateSession).not.toHaveBeenCalled();
    });
  });

  describe('app-level heartbeat', () => {
    it('answers an app-level ping with a pong even before auth', async () => {
      const deps = makeDeps({
        authService: { isEnrolled: () => true, validateSession: jest.fn(() => true) },
        trustedNetwork: { isTrusted: () => false },
      });
      const ws = mount(deps);
      await sendMsg(ws, { type: 'ping' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
    });
  });

  describe('expensive-op rate limiting (per connection)', () => {
    it('allows up to the cap then rejects with a rate-limit error', async () => {
      const deps = makeDeps();
      const ws = mount(deps);
      for (let i = 0; i < 3; i++) {
        await sendMsg(ws, { type: 'search_project', requestId: `r${i}`, projectId: 'p1', query: 'x' });
      }
      ws.send.mockClear();
      await sendMsg(ws, { type: 'search_project', requestId: 'r4', projectId: 'p1', query: 'x' });

      expect(deps.fileHandlers.searchProject).toHaveBeenCalledTimes(3);
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'error',
        message: 'Rate limit exceeded — too many requests, please slow down.',
        requestId: 'r4',
      }));
    });
  });

  describe('dispatch routing', () => {
    let ws;
    let deps;
    beforeEach(() => { deps = makeDeps(); ws = mount(deps); });

    it('join_session → relayClient.joinSession', async () => {
      await sendMsg(ws, { type: 'join_session', sessionId: 's9' });
      expect(relayClient.joinSession).toHaveBeenCalledWith('s9');
    });

    it('end_session falls back to currentSessionId when none given', async () => {
      relayClient.currentSessionId = 'cur';
      await sendMsg(ws, { type: 'end_session' });
      expect(relayClient.endSession).toHaveBeenCalledWith('cur');
    });

    it('permission_response forwards id, approval and reason', async () => {
      await sendMsg(ws, { type: 'permission_response', permissionId: 'perm', approved: false, reason: 'no' });
      expect(relayClient.sendPermissionResponse).toHaveBeenCalledWith('perm', false, 'no');
    });

    it('user_input (non-slash) is forwarded to relay as a message', async () => {
      await sendMsg(ws, { type: 'user_input', text: 'hello world', sessionId: 's' });
      expect(relayClient.sendMessage).toHaveBeenCalled();
      const [text] = relayClient.sendMessage.mock.calls[0];
      expect(text).toContain('hello world');
    });

    it('terminal_create is proxied to relay with the projectId', async () => {
      await sendMsg(ws, { type: 'terminal_create', templateId: 't', projectId: 'p1' });
      expect(relayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_create', projectId: 'p1' }));
    });

    it('list_directory starts the project watcher and lists', async () => {
      await sendMsg(ws, { type: 'list_directory', projectId: 'p1', path: '/' });
      expect(fileWatcher.watchProject).toHaveBeenCalledWith('p1');
      expect(deps.fileHandlers.listDirectory).toHaveBeenCalled();
    });

    it('write_file marks a self-write before delegating to writeFile', async () => {
      await sendMsg(ws, { type: 'write_file', projectId: 'p1', path: 'a.txt', content: 'x' });
      expect(deps.fileHandlers.fileService.validatePath).toHaveBeenCalledWith('/proj1', 'a.txt');
      expect(fileWatcher.markSelfWrite).toHaveBeenCalledWith('/proj1/abs.txt');
      expect(deps.fileHandlers.writeFile).toHaveBeenCalled();
    });

    it('search_cancel cancels the search by requestId', async () => {
      await sendMsg(ws, { type: 'search_cancel', requestId: 'rc' });
      expect(deps.fileHandlers.searchService.cancel).toHaveBeenCalledWith('rc');
    });

    it('records the viewed project on the ui bus for any project-scoped message', async () => {
      await sendMsg(ws, { type: 'read_file', projectId: 'p1', path: 'a.txt' });
      expect(deps.uiBus.setProject).toHaveBeenCalledWith(relayClient, 'p1');
    });
  });

  describe('create_session', () => {
    it('POSTs to relay, emits session_created, suppresses the echo join, and joins', async () => {
      const deps = makeDeps();
      const ws = mount(deps);
      await sendMsg(ws, { type: 'create_session', projectId: 'p1' });

      expect(deps.relayTransport.fetch).toHaveBeenCalledWith('POST', '/api/sessions', expect.objectContaining({ projectId: 'p1', directory: '/proj1' }));
      const created = ws.send.mock.calls.map(c => JSON.parse(c[0])).find(m => m.type === 'session_created');
      expect(created).toMatchObject({ sessionId: 'S1', model: 'gpt' });
      expect(relayClient.setSuppressNextJoin).toHaveBeenCalledWith('S1');
      expect(relayClient.joinSession).toHaveBeenCalledWith('S1');
    });

    it('surfaces a non-2xx relay response as an error frame', async () => {
      const deps = makeDeps({
        relayTransport: { fetch: jest.fn().mockResolvedValue({ status: 500, data: { error: 'boom' } }), createWebSocket: jest.fn() },
      });
      const ws = mount(deps);
      await sendMsg(ws, { type: 'create_session', projectId: 'p1' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'boom' }));
      expect(relayClient.joinSession).not.toHaveBeenCalled();
    });
  });

  describe('module file ops (server-side permission gate)', () => {
    it('denies a read for a path not in the module permissions', async () => {
      const deps = makeDeps({
        moduleService: { getModule: jest.fn().mockResolvedValue({}), isFilePermitted: jest.fn(() => false) },
      });
      const ws = mount(deps);
      await sendMsg(ws, { type: 'module_read_file', requestId: 'rq', projectId: 'p1', moduleName: 'm', path: 'secret.txt' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'module_file_response', requestId: 'rq', op: 'read',
        ok: false, error: 'Permission denied: secret.txt not in module permissions.files',
      }));
    });

    it('reads a permitted file through the file service', async () => {
      const deps = makeDeps();
      deps.fileHandlers.fileService.readFile = jest.fn().mockResolvedValue({ content: 'hi', size: 2 });
      const ws = mount(deps);
      await sendMsg(ws, { type: 'module_read_file', requestId: 'rq', projectId: 'p1', moduleName: 'm', path: 'ok.txt' });
      expect(deps.fileHandlers.fileService.readFile).toHaveBeenCalledWith('/proj1', 'ok.txt');
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'module_file_response', requestId: 'rq', op: 'read', ok: true, content: 'hi', size: 2,
      }));
    });

    // The write side runs the SAME manifest re-read + permissions.files gate as
    // read (module invariant #2). It was previously untested: a regression that
    // dropped the gate on writes would let an AI-authored iframe overwrite any
    // project file. These pin that the gate is enforced for writes too.
    it('denies a write for a path not in the module permissions and never touches the disk', async () => {
      const deps = makeDeps({
        moduleService: { getModule: jest.fn().mockResolvedValue({}), isFilePermitted: jest.fn(() => false) },
      });
      deps.fileHandlers.fileService.writeFile = jest.fn();
      const ws = mount(deps);
      await sendMsg(ws, { type: 'module_write_file', requestId: 'rq', projectId: 'p1', moduleName: 'm', path: 'secret.txt', content: 'x' });
      expect(deps.fileHandlers.fileService.writeFile).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'module_file_response', requestId: 'rq', op: 'write',
        ok: false, error: 'Permission denied: secret.txt not in module permissions.files',
      }));
    });

    it('writes a permitted file through the file service and marks the self-write', async () => {
      const deps = makeDeps();
      deps.fileHandlers.fileService.writeFile = jest.fn().mockResolvedValue(undefined);
      deps.fileHandlers.fileService.validatePath = jest.fn(() => '/proj1/ok.txt');
      const ws = mount(deps);
      await sendMsg(ws, { type: 'module_write_file', requestId: 'rq', projectId: 'p1', moduleName: 'm', path: 'ok.txt', content: 'new body' });
      expect(deps.fileHandlers.fileService.writeFile).toHaveBeenCalledWith('/proj1', 'ok.txt', 'new body');
      // Self-write marking suppresses the watcher echoing eve's own write back as
      // an external file_changed.
      expect(fileWatcher.markSelfWrite).toHaveBeenCalledWith('/proj1/ok.txt');
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'module_file_response', requestId: 'rq', op: 'write', ok: true,
      }));
    });

    it('reports a write failure from the file service as ok:false', async () => {
      const deps = makeDeps();
      deps.fileHandlers.fileService.writeFile = jest.fn().mockRejectedValue(new Error('EACCES: denied'));
      const ws = mount(deps);
      await sendMsg(ws, { type: 'module_write_file', requestId: 'rq', projectId: 'p1', moduleName: 'm', path: 'ok.txt', content: 'x' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'module_file_response', requestId: 'rq', op: 'write', ok: false, error: 'EACCES: denied',
      }));
    });
  });

  describe('module_invoke_ai guards', () => {
    it('fails fast when no module invoker is configured', async () => {
      const ws = mount(makeDeps({ moduleInvoker: null }));
      await sendMsg(ws, { type: 'module_invoke_ai', requestId: 'rq', projectId: 'p1', moduleName: 'm', prompt: 'hi' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'module_ai_failed', requestId: 'rq', error: 'Module invoker not initialized',
      }));
    });
  });

  describe('read_plan_file path validation', () => {
    it('rejects a path outside ~/.claude/plans', async () => {
      const ws = mount(makeDeps());
      await sendMsg(ws, { type: 'read_plan_file', path: '/etc/passwd' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Plan file path not allowed' }));
    });

    it('rejects a missing path', async () => {
      const ws = mount(makeDeps());
      await sendMsg(ws, { type: 'read_plan_file', path: '' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Invalid plan file path' }));
    });
  });

  describe('error handling and lifecycle', () => {
    it('replies with an error frame on malformed JSON', async () => {
      const ws = mount(makeDeps());
      ws.emit('message', Buffer.from('not json{'));
      await flush();
      const sent = ws.send.mock.calls.map(c => JSON.parse(c[0]));
      expect(sent.some(m => m.type === 'error')).toBe(true);
    });

    it('reports a relay connection failure to the browser', async () => {
      relayClient.connect = jest.fn().mockRejectedValue(new Error('down'));
      const ws = mount(makeDeps());
      await flush();
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Cannot connect to relay service' }));
    });

    it('cleans up relay, watcher, and ui bus on socket close', async () => {
      const deps = makeDeps();
      const ws = mount(deps);
      ws.emit('close');
      expect(relayClient.close).toHaveBeenCalled();
      expect(fileWatcher.closeAll).toHaveBeenCalled();
      expect(deps.uiBus.unregister).toHaveBeenCalledWith(relayClient);
    });
  });
});
