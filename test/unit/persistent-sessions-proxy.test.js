// Persistent (tmux) host sessions: eve only forwards. relay owns enumeration,
// name/ownership checks and the kill (../relay/docs/ssh-hosts.md), so these
// pin the pass-through contract — auth, path, status and body.
const http = require('http');
const express = require('express');
const registerRoutes = require('../../routes/index');
const FileService = require('../../file-service');
const terminalMessages = require('../../ws/terminal-messages');

describe('persistent-sessions proxy routes', () => {
  let server;
  let baseUrl;
  let deps;

  beforeEach((done) => {
    deps = {
      authService: { isEnrolled: jest.fn(() => true), validateSession: jest.fn((t) => t === 'good') },
      trustedNetwork: { isTrusted: jest.fn(() => false) },
      relayTransport: { fetch: jest.fn(), fetchRaw: jest.fn() },
      refreshProjectCache: jest.fn(),
      removeFromProjectCache: jest.fn(),
      resolveProject: jest.fn(() => null),
      fileService: new FileService(),
      fileServiceFor: jest.fn(() => new FileService()),
      refreshHostCache: jest.fn(),
      removeFromHostCache: jest.fn(),
      hostPool: { disconnect: jest.fn() },
      ttsService: {}, sttService: {},
      log: null,
    };
    delete process.env.EVE_NO_AUTH;
    const app = express();
    app.use(express.json());
    registerRoutes(app, deps);
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => { server.close(done); });

  const req = (method, p, token = 'good') =>
    fetch(`${baseUrl}${p}`, { method, headers: token ? { 'x-session-token': token } : {} });

  it('requires the same session auth as the neighbouring terminal-template route', async () => {
    const neighbour = await req('GET', '/api/terminal/templates', null);
    const list = await req('GET', '/api/projects/p1/persistent-sessions', null);
    const kill = await req('DELETE', '/api/projects/p1/persistent-sessions/eve-p1-a-1', 'bad');
    expect(neighbour.status).toBe(401);
    expect(list.status).toBe(401);
    expect(kill.status).toBe(401);
    expect(deps.relayTransport.fetch).not.toHaveBeenCalled();
  });

  it('forwards GET to relay with the project id encoded and returns its list', async () => {
    const sessions = [{ name: 'eve-x-1', template_id: 'shell', n: 1, attached: 0 }];
    deps.relayTransport.fetch.mockResolvedValue({ status: 200, data: sessions });
    const res = await req('GET', '/api/projects/my%20proj/persistent-sessions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sessions);
    expect(deps.relayTransport.fetch).toHaveBeenCalledWith('GET', '/api/projects/my%20proj/persistent-sessions', undefined);
  });

  it.each([409, 502, 404])('passes a relay %i status and {error} body through on GET', async (status) => {
    deps.relayTransport.fetch.mockResolvedValue({ status, data: { error: `relay says ${status}` } });
    const res = await req('GET', '/api/projects/p1/persistent-sessions');
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `relay says ${status}` });
  });

  it('forwards DELETE with both segments encoded and passes 204 through with no body', async () => {
    deps.relayTransport.fetch.mockResolvedValue({ status: 204, data: null });
    const res = await req('DELETE', '/api/projects/p1/persistent-sessions/eve%20p1');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(deps.relayTransport.fetch).toHaveBeenCalledWith('DELETE', '/api/projects/p1/persistent-sessions/eve%20p1');
  });

  it.each([409, 502])('passes a relay %i status and {error} body through on DELETE', async (status) => {
    deps.relayTransport.fetch.mockResolvedValue({ status, data: { error: 'nope' } });
    const res = await req('DELETE', '/api/projects/p1/persistent-sessions/eve-p1-a-1');
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('answers 502 {error} when relay is unreachable', async () => {
    deps.relayTransport.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const list = await req('GET', '/api/projects/p1/persistent-sessions');
    const kill = await req('DELETE', '/api/projects/p1/persistent-sessions/eve-p1-a-1');
    expect(list.status).toBe(502);
    expect(kill.status).toBe(502);
    expect(await kill.json()).toEqual({ error: 'Service unavailable' });
  });
});

describe('terminal_create persistSession forwarding', () => {
  const handler = terminalMessages.find((m) => m.type === 'terminal_create');

  async function create(message) {
    const relayTransport = {
      fetch: jest.fn().mockResolvedValue({ status: 201, data: { terminalId: 't1' } }),
    };
    const ctx = {
      ws: { send: jest.fn() },
      relayClient: { send: jest.fn() },
      message: { type: 'terminal_create', templateId: 'shell', projectId: 'p1', directory: '', cols: 80, rows: 24, ...message },
      deps: { relayTransport },
    };
    await handler.handle(ctx);
    return relayTransport.fetch.mock.calls[0];
  }

  it('sends persistSession to relay as snake_case persist_session', async () => {
    const [method, path, body] = await create({ persistSession: 'eve-p1-shell-2' });
    expect(method).toBe('POST');
    expect(path).toBe('/api/terminals');
    expect(body.persist_session).toBe('eve-p1-shell-2');
    expect(body).not.toHaveProperty('persistSession');
  });

  it('omits persist_session entirely when persistSession is absent', async () => {
    const [, , body] = await create({});
    expect(body).not.toHaveProperty('persist_session');
    expect(body).toMatchObject({ templateId: 'shell', projectId: 'p1' });
  });
});
