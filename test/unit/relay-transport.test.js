const { RelayTransport, RelayConfigError, isLoopbackHost } = require('../../relay-transport');

// Silent logger that still records warnings so we can assert on them.
function mkLog() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  return {
    calls,
    debug: (...a) => calls.debug.push(a),
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
    child: function () { return this; },
  };
}

describe('isLoopbackHost', () => {
  test('matches common loopback forms', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  test('rejects non-loopback', () => {
    expect(isLoopbackHost('relay.internal')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('RelayTransport.fromEnv', () => {
  test('builds a socket-mode transport when RELAY_FRONTEND_SOCKET is set', () => {
    const t = RelayTransport.fromEnv({
      env: {
        RELAY_FRONTEND_SOCKET: '/tmp/relay-llm.sock',
        RELAY_FRONTEND_TOKEN: 'deadbeef',
      },
      log: mkLog(),
    });
    expect(t.mode).toBe('socket');
    expect(t.socketPath).toBe('/tmp/relay-llm.sock');
    expect(t.token).toBe('deadbeef');
  });

  test('defaults to TCP mode on loopback when only the URL default is used', () => {
    const t = RelayTransport.fromEnv({ env: {}, log: mkLog() });
    expect(t.mode).toBe('tcp');
    expect(t.loopback).toBe(true);
  });

  test('honors RELAY_FRONTEND_URL for a remote HTTPS relay', () => {
    const t = RelayTransport.fromEnv({
      env: {
        RELAY_FRONTEND_URL: 'https://relay.internal:3001',
        RELAY_FRONTEND_TOKEN: 't',
      },
      log: mkLog(),
    });
    expect(t.mode).toBe('tcp');
    expect(t.loopback).toBe(false);
    expect(t.parsedUrl.protocol).toBe('https:');
  });

  test('rejects an invalid URL in the constructor', () => {
    expect(() => RelayTransport.fromEnv({ env: { RELAY_FRONTEND_URL: 'not a url' }, log: mkLog() }))
      .toThrow(RelayConfigError);
  });
});

describe('assertStartupConfig', () => {
  test('passes on loopback http with no token (warns loudly)', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({ env: {}, log });
    expect(() => t.assertStartupConfig()).not.toThrow();
    expect(log.calls.warn.length).toBeGreaterThan(0);
    expect(log.calls.warn[0][0]).toMatch(/RELAY_FRONTEND_TOKEN is not set/);
  });

  test('passes on loopback http with a token', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: 'http://localhost:3001', RELAY_FRONTEND_TOKEN: 't' },
      log,
    });
    expect(() => t.assertStartupConfig()).not.toThrow();
    expect(log.calls.warn.length).toBe(0);
  });

  test('passes on https remote with a token', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: 'https://relay.internal', RELAY_FRONTEND_TOKEN: 't' },
      log,
    });
    expect(() => t.assertStartupConfig()).not.toThrow();
  });

  test('refuses off-loopback http regardless of token', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: 'http://relay.internal:3001', RELAY_FRONTEND_TOKEN: 't' },
      log,
    });
    expect(() => t.assertStartupConfig()).toThrow(RelayConfigError);
    expect(() => t.assertStartupConfig()).toThrow(/https/);
  });

  test('refuses off-loopback without a token even if the URL is https', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: 'https://relay.internal' },
      log,
    });
    expect(() => t.assertStartupConfig()).toThrow(RelayConfigError);
    expect(() => t.assertStartupConfig()).toThrow(/RELAY_FRONTEND_TOKEN/);
  });

  test('refuses socket mode without a token', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_SOCKET: '/tmp/x.sock' },
      log,
    });
    expect(() => t.assertStartupConfig()).toThrow(RelayConfigError);
    expect(() => t.assertStartupConfig()).toThrow(/RELAY_FRONTEND_TOKEN/);
  });
});

describe('URL / agent wiring', () => {
  test('_buildUrl composes relative paths in socket mode', () => {
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_SOCKET: '/tmp/x.sock', RELAY_FRONTEND_TOKEN: 't' },
      log: mkLog(),
    });
    expect(t._buildUrl(t._httpBase, '/api/projects')).toBe('http://relay-frontend.localsocket/api/projects');
    expect(t._buildUrl(t._httpBase, 'api/projects')).toBe('http://relay-frontend.localsocket/api/projects');
    expect(t._buildUrl(t._wsBase, '/ws')).toBe('ws://relay-frontend.localsocket/ws');
  });

  test('TCP mode uses the configured host', () => {
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: 'https://relay.internal:8443', RELAY_FRONTEND_TOKEN: 't' },
      log: mkLog(),
    });
    expect(t._buildUrl(t._httpBase, '/api/models')).toBe('https://relay.internal:8443/api/models');
    expect(t._buildUrl(t._wsBase, '/ws')).toBe('wss://relay.internal:8443/ws');
  });

  test('socket mode agent is a http.Agent with socketPath', () => {
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_SOCKET: '/tmp/x.sock', RELAY_FRONTEND_TOKEN: 't' },
      log: mkLog(),
    });
    expect(t.agent).toBeDefined();
    // The socketPath is stored on the agent's options object.
    expect(t.agent.options.socketPath).toBe('/tmp/x.sock');
  });

  test('TCP HTTPS mode agent is an https.Agent with rejectUnauthorized: true', () => {
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: 'https://relay.internal', RELAY_FRONTEND_TOKEN: 't' },
      log: mkLog(),
    });
    expect(t.agent).toBeDefined();
    // https.Agent inherits from http.Agent; we can sniff the `options` bag.
    expect(t.agent.options.rejectUnauthorized).toBe(true);
  });
});

describe('fetch() HTTP roundtrip over loopback', () => {
  const http = require('http');

  function startServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => handler(req, res));
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('sends the bearer token and parses JSON', async () => {
    let seenAuth = null;
    let seenBody = null;
    const server = await startServer((req, res) => {
      seenAuth = req.headers['authorization'] || null;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seenBody = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: seenBody }));
      });
    });
    const port = server.address().port;

    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: `http://127.0.0.1:${port}`, RELAY_FRONTEND_TOKEN: 'secret-token' },
      log: mkLog(),
    });

    const result = await t.fetch('POST', '/api/projects', { name: 'foo' });
    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);
    expect(seenAuth).toBe('Bearer secret-token');
    expect(seenBody).toBe('{"name":"foo"}');

    server.close();
  });

  test('omits Authorization when no token is set (loopback dev mode)', async () => {
    let seenAuth = undefined;
    const server = await startServer((req, res) => {
      seenAuth = req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const port = server.address().port;

    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: `http://127.0.0.1:${port}` },
      log: mkLog(),
    });
    await t.fetch('GET', '/api/models');
    expect(seenAuth).toBeUndefined();
    server.close();
  });
});
