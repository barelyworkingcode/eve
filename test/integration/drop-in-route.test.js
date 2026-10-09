// POST /api/sessions/:id/drop-in: eve checks the body, then returns relay's status
// and body unchanged. A bad body never reaches relay.
const http = require('http');
const express = require('express');
const registerRoutes = require('../../routes/index');

describe('POST /api/sessions/:id/drop-in', () => {
  let server;
  let baseUrl;
  let transport;

  beforeEach((done) => {
    delete process.env.EVE_NO_AUTH;
    transport = { fetch: jest.fn(), fetchRaw: jest.fn() };
    const app = express();
    app.use(express.json());
    registerRoutes(app, {
      authService: { isEnrolled: jest.fn(() => false), validateSession: jest.fn(), checkRateLimit: jest.fn(() => true) },
      trustedNetwork: { isTrusted: jest.fn(() => false) },
      relayTransport: transport,
      refreshProjectCache: jest.fn(),
      removeFromProjectCache: jest.fn(),
      resolveProject: jest.fn(),
      fileServiceFor: jest.fn(),
      refreshHostCache: jest.fn(),
      removeFromHostCache: jest.fn(),
      ttsService: { listVoices: jest.fn() },
      sttService: { isAvailable: jest.fn(), transcribe: jest.fn() },
      log: null,
    });
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });
  afterEach((done) => { server.close(done); });

  const post = (id, body, headers = { 'Content-Type': 'application/json' }) =>
    fetch(`${baseUrl}/api/sessions/${id}/drop-in`, { method: 'POST', headers, body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body) });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['cols missing', { rows: 24 }],
    ['rows missing', { cols: 80 }],
    ['zero cols', { cols: 0, rows: 24 }],
    ['rows above 500', { cols: 80, rows: 501 }],
    ['negative cols', { cols: -1, rows: 24 }],
    ['a fractional size', { cols: 80.5, rows: 24 }],
    ['sizes as strings', { cols: '80', rows: '24' }],
    ['a body that is not JSON', 'cols=80&rows=24'],
  ])('answers 400 and never calls relay for %s', async (_what, body) => {
    const headers = typeof body === 'string' ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' };
    const res = await post('s1', body, headers);
    expect(res.status).toBe(400);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('forwards a good body to relay as {cols, rows} and nothing else', async () => {
    transport.fetch.mockResolvedValue({ status: 201, data: { sessionId: 's1' } });
    await post('s1', { cols: 80, rows: 24, extra: 'x' });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    const [method, path, body] = transport.fetch.mock.calls[0];
    expect([method, path, body]).toEqual(['POST', '/api/sessions/s1/drop-in', { cols: 80, rows: 24 }]);
  });

  it.each([
    [201, { sessionId: 's1', claudeSessionId: 'c1', terminal: { terminalId: 't1' } }],
    [404, { error: 'session_not_found', message: 'no session s1' }],
    [409, { error: 'tool_running', message: 'a tool is running (Bash); wait for it to finish or stop the turn, then try again' }],
    [502, { error: 'unavailable', message: 'the session host is not available' }],
  ])('returns relay\'s %i and its body unchanged', async (status, data) => {
    transport.fetch.mockResolvedValue({ status, data });
    const res = await post('s1', { cols: 80, rows: 24 });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(data);
  });
});
