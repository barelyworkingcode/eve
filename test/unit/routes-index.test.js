// The /api/files route is covered separately in files-route.test.js.
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
      fileServiceFor: jest.fn(() => new FileService()),
      refreshHostCache: jest.fn(),
      removeFromHostCache: jest.fn(),
      hostPool: { disconnect: jest.fn() },
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

    it('never projects ssh_argv, even for a host project resolveProject attaches a host onto', async () => {
      // Simulates server.js#resolveProject attaching {id,name,status} from
      // its hostCache — never the raw hostView, which carries ssh_argv.
      deps.resolveProject.mockImplementation((id) => (id === 'p1'
        ? { id: 'p1', path: '/srv/app', hostId: 'h1', host: { id: 'h1', name: 'devbox', status: 'connected' } }
        : null));
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: [{ id: 'p1', name: 'p1-raw', host_id: 'h1' }] });
      const res = await fetch(`${baseUrl}/api/projects`);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain('ssh_argv');
      expect(JSON.stringify(body)).not.toContain('BatchMode');
      expect(body[0].host).toEqual({ id: 'h1', name: 'devbox', status: 'connected' });
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

  describe('SSH hosts routes (../relay/docs/ssh-hosts.md) — ssh_argv must never reach the browser', () => {
    const hostViewWithSecret = {
      id: 'h1', name: 'devbox', target: 'admin@devbox.local', port: 0, identity_file: '',
      status: 'connected',
      ssh_argv: ['ssh', '-o', 'BatchMode=yes', 'admin@devbox.local'],
    };

    it('GET /api/hosts refreshes the host cache and strips ssh_argv', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: [hostViewWithSecret] });
      const res = await fetch(`${baseUrl}/api/hosts`);
      const list = await res.json();
      expect(deps.refreshHostCache).toHaveBeenCalledWith([hostViewWithSecret]);
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('ssh_argv');
      expect(list[0]).toMatchObject({ id: 'h1', name: 'devbox', status: 'connected' });
      expect(JSON.stringify(list)).not.toContain('BatchMode');
    });

    it('POST /api/hosts strips ssh_argv from the created hostView and refreshes the cache', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 201, data: hostViewWithSecret });
      const res = await fetch(`${baseUrl}/api/hosts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'devbox', target: 'admin@devbox.local' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).not.toHaveProperty('ssh_argv');
      expect(deps.refreshHostCache).toHaveBeenCalledWith([hostViewWithSecret]);
    });

    it('PUT /api/hosts/:id strips ssh_argv', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: hostViewWithSecret });
      const res = await fetch(`${baseUrl}/api/hosts/h1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'devbox2' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).not.toHaveProperty('ssh_argv');
    });

    it('POST /api/hosts/:id/probe strips ssh_argv from the re-probed hostView', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: hostViewWithSecret });
      const res = await fetch(`${baseUrl}/api/hosts/h1/probe`, { method: 'POST' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).not.toHaveProperty('ssh_argv');
    });

    it('POST /api/hosts/:id/disconnect strips ssh_argv and tears down the pool agent', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: hostViewWithSecret });
      const res = await fetch(`${baseUrl}/api/hosts/h1/disconnect`, { method: 'POST' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).not.toHaveProperty('ssh_argv');
      expect(deps.hostPool.disconnect).toHaveBeenCalledWith('h1');
    });

    it('DELETE /api/hosts/:id removes it from the cache and disconnects the pool agent', async () => {
      deps.relayTransport.fetch.mockResolvedValue({ status: 204, data: null });
      const res = await fetch(`${baseUrl}/api/hosts/h1`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(deps.removeFromHostCache).toHaveBeenCalledWith('h1');
      expect(deps.hostPool.disconnect).toHaveBeenCalledWith('h1');
    });

    it('a 409 (host referenced by a project) does not touch the cache or pool', async () => {
      deps.relayTransport.fetch.mockResolvedValue({
        status: 409, data: { error: 'host in use', projects: ['relayfs'] },
      });
      const res = await fetch(`${baseUrl}/api/hosts/h1`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(deps.removeFromHostCache).not.toHaveBeenCalled();
      expect(deps.hostPool.disconnect).not.toHaveBeenCalled();
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
