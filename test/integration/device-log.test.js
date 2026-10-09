const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ws-handler reads these env vars once at module load, so they must be set
// before the require below. Low ceiling keeps the throttle test cheap.
process.env.EVE_RATELIMIT_MAX = '3';
process.env.EVE_RATELIMIT_WINDOW_MS = '10000';
delete process.env.EVE_NO_AUTH;

// device_log writes into the repo working tree by default; EVE_DEVICE_LOG_PATH
// points it at a tmpdir instead, also read once at module load.
const deviceLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-device-log-'));
const deviceLogPath = path.join(deviceLogDir, 'relay-device.log');
process.env.EVE_DEVICE_LOG_PATH = deviceLogPath;

// RelayClient and FileWatcher are constructed inside the handler, not injected,
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

  function makeDeps(overrides = {}) {
    const fileServiceMock = { validatePath: jest.fn(() => '/proj1/abs.txt') };
    return {
      authService: { isEnrolled: jest.fn(() => false), validateSession: jest.fn(() => true) },
      trustedNetwork: { isTrusted: jest.fn(() => true) },
      relayTransport: {
        fetch: jest.fn().mockResolvedValue({ status: 200, data: { sessionId: 'S1', directory: '/proj1', projectId: 'p1', model: 'gpt' } }),
        createWebSocket: jest.fn(),
      },
      fileHandlers: {
        fileServiceFor: jest.fn(() => fileServiceMock),
        cancelSearch: jest.fn(),
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

  describe('device_log (points at a tmpdir via EVE_DEVICE_LOG_PATH, not the repo tree)', () => {
    beforeEach(() => {
      fs.rmSync(deviceLogPath, { force: true });
    });

    async function readLogEventually() {
      // appendDeviceLog's fs.appendFile is fire-and-forget, and fs.appendFile
      // itself opens the file before it writes — a single flush() tick is
      // enough for the file to exist but empty, not for the write to have
      // landed. Poll on non-empty content, not mere existence.
      const deadline = Date.now() + 1000;
      for (;;) {
        if (fs.existsSync(deviceLogPath)) {
          const content = fs.readFileSync(deviceLogPath, 'utf8');
          if (content) return content;
        }
        if (Date.now() >= deadline) return '';
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it('appends "<iso> <ip> <line>" per line from the connection\'s remote address', async () => {
      const ws = mount(makeDeps());
      await sendMsg(ws, { type: 'device_log', lines: ['boot', 'wake'] });
      const text = await readLogEventually();
      const rows = text.trim().split('\n');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z 127\.0\.0\.1 boot$/);
      expect(rows[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z 127\.0\.0\.1 wake$/);
    });

    it('writes nothing for a malformed message (neither line nor lines)', async () => {
      const ws = mount(makeDeps());
      await sendMsg(ws, { type: 'device_log', notLines: 'oops' });
      await new Promise((r) => setTimeout(r, 100)); // give an accidental async write a chance to land
      expect(fs.existsSync(deviceLogPath)).toBe(false);
    });
  });
});
