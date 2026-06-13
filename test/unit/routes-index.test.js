/**
 * Integration test for the proxy/auth surface of routes/index.js: the
 * requireAuth gate, the load-bearing hidden-session filter on /api/sessions,
 * proxy error mapping, project-cache wiring, and the voices cache. The
 * /api/files route is covered separately in files-route.test.js.
 */
const http = require('http');
const express = require('express');
const registerRoutes = require('../../routes/index');
const FileService = require('../../file-service');

describe('routes/index proxy + auth surface', () => {
  let server;
  let baseUrl;
  let deps;

  function buildDeps() {
    return {
      authService: {
        isEnrolled: jest.fn(() => false),
        validateSession: jest.fn(() => false),
        checkRateLimit: jest.fn(() => true),
        generateEnrollmentOptions: jest.fn(),
        verifyEnrollment: jest.fn(),
        generateLoginOptions: jest.fn(),
        verifyLogin: jest.fn(),
      },
      trustedNetwork: { isTrusted: jest.fn(() => false) },
      relayTransport: { fetch: jest.fn(), fetchRaw: jest.fn() },
      refreshProjectCache: jest.fn(),
      removeFromProjectCache: jest.fn(),
      resolveProject: jest.fn((id) => (id === 'p1' ? { id: 'p1', path: '/tmp/p1', displayName: 'P1' } : null)),
      fileService: new FileService(),
      ttsService: { listVoices: jest.fn() },
      sttService: { isAvailable: jest.fn(), transcribe: jest.fn() },
      moduleService: {},
      log: null,
    };
  }

  beforeEach((done) => {
    delete process.env.EVE_NO_AUTH;
    deps = buildDeps();
    const app = express();
    app.use(express.json());
    registerRoutes(app, deps);
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => { server.close(done); });

  describe('requireAuth gate', () => {
    it('401s an enrolled, untrusted client with no valid token', async () => {
      deps.authService.isEnrolled.mockReturnValue(true);
      deps.authService.validateSession.mockReturnValue(false);
      const res = await fetch(`${baseUrl}/api/models`);
      expect(res.status).toBe(401);
      expect(deps.relayTransport.fetch).not.toHaveBeenCalled();
    });

    it('passes through with a valid session token', async () => {
      deps.authService.isEnrolled.mockReturnValue(true);
      deps.authService.validateSession.mockReturnValue(true);
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: { models: [] } });
      const res = await fetch(`${baseUrl}/api/models`, { headers: { 'x-session-token': 'good' } });
      expect(res.status).toBe(200);
      expect(deps.authService.validateSession).toHaveBeenCalledWith('good');
    });

    it('bypasses auth for a trusted client', async () => {
      deps.authService.isEnrolled.mockReturnValue(true);
      deps.trustedNetwork.isTrusted.mockReturnValue(true);
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: { models: [] } });
      const res = await fetch(`${baseUrl}/api/models`);
      expect(res.status).toBe(200);
    });

    it('bypasses auth before enrollment (first-run bootstrap)', async () => {
      deps.authService.isEnrolled.mockReturnValue(false);
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: { models: [] } });
      const res = await fetch(`${baseUrl}/api/models`);
      expect(res.status).toBe(200);
    });
  });

  describe('proxy helper', () => {
    it('forwards method/path and relays status + body', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: { models: ['m1'] } });
      const res = await fetch(`${baseUrl}/api/models`);
      expect(deps.relayTransport.fetch).toHaveBeenCalledWith('GET', '/api/models', undefined);
      expect(await res.json()).toEqual({ models: ['m1'] });
    });

    it('maps a relay transport failure to 502', async () => {
      deps.relayTransport.fetch.mockRejectedValue(new Error('relay down'));
      const res = await fetch(`${baseUrl}/api/models`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('Service unavailable');
    });
  });

  describe('GET /api/sessions hidden-session filter (load-bearing)', () => {
    it('strips __module: and __search: ephemeral sessions from the list', async () => {
      deps.relayTransport.fetch.mockResolvedValue({
        status: 200,
        data: [
          { id: '1', name: 'My chat' },
          { id: '2', name: '__module:demo:abcdef' },
          { id: '3', name: '__search:abc123' },
          { id: '4', name: 'Another chat' },
        ],
      });
      const res = await fetch(`${baseUrl}/api/sessions`);
      const list = await res.json();
      expect(list.map(s => s.name)).toEqual(['My chat', 'Another chat']);
    });
  });

  describe('GET /api/projects normalization', () => {
    it('refreshes the cache and returns normalized projects', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: [{ id: 'p1', name: 'p1-raw' }] });
      const res = await fetch(`${baseUrl}/api/projects`);
      expect(deps.refreshProjectCache).toHaveBeenCalledWith([{ id: 'p1', name: 'p1-raw' }]);
      expect(await res.json()).toEqual([{ id: 'p1', path: '/tmp/p1', displayName: 'P1' }]);
    });
  });

  describe('project mutations update the cache', () => {
    it('POST upsert refreshes the cache with the relay response', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 201, data: { id: 'p1', name: 'new' } });
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new' }),
      });
      expect(res.status).toBe(201);
      expect(deps.refreshProjectCache).toHaveBeenCalledWith([{ id: 'p1', name: 'new' }]);
    });

    it('DELETE removes the project from the cache on success', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: {} });
      const res = await fetch(`${baseUrl}/api/projects/p1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(deps.removeFromProjectCache).toHaveBeenCalledWith('p1');
    });
  });

  describe('GET /api/tts/voices', () => {
    it('caches the voice list (second hit does not re-query the daemon)', async () => {
      deps.ttsService.listVoices.mockResolvedValue([{ id: 'af_heart' }]);
      await fetch(`${baseUrl}/api/tts/voices`);
      const res2 = await fetch(`${baseUrl}/api/tts/voices`);
      expect(deps.ttsService.listVoices).toHaveBeenCalledTimes(1);
      expect(await res2.json()).toEqual([{ id: 'af_heart' }]);
    });

    it('503s when voices are unavailable and nothing is cached', async () => {
      deps.ttsService.listVoices.mockRejectedValue(new Error('daemon down'));
      const res = await fetch(`${baseUrl}/api/tts/voices`);
      expect(res.status).toBe(503);
    });
  });
});
