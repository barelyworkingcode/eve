const { RelayTransport, RelayConfigError } = require('../../relay-transport');

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

describe('socket mode over a real Unix socket', () => {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('fetch and fetchRaw send no Authorization header even with RELAY_FRONTEND_TOKEN set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-rt-'));
    const socketPath = path.join(dir, 'frontend.sock');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise((r) => server.listen(socketPath, r));
    try {
      const t = RelayTransport.fromEnv({
        env: { RELAY_FRONTEND_SOCKET: socketPath, RELAY_FRONTEND_TOKEN: 'must-not-be-sent' },
        log: mkLog(),
      });
      const result = await t.fetch('POST', '/api/projects', { name: 'x' });
      await t.fetchRaw('GET', '/api/generated/a.png');
      expect(result).toEqual({ status: 200, data: [] });
      expect(seen).toHaveLength(2);
      for (const headers of seen) expect(headers.authorization).toBeUndefined();
      t.agent.destroy();
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('relay scope (chief-of-staff)', () => {
  const http = require('http');
  const listen = (onRequest, onUpgrade) => new Promise((resolve) => {
    const server = http.createServer(onRequest);
    if (onUpgrade) server.on('upgrade', onUpgrade);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const transportFor = (server) => RelayTransport.fromEnv({
    env: { RELAY_FRONTEND_URL: `http://127.0.0.1:${server.address().port}` },
    log: mkLog(),
  });

  test('fetch sends X-Relay-Scope only when a scope is given', async () => {
    const seen = [];
    const server = await listen((req, res) => {
      seen.push(req.headers['x-relay-scope']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const t = transportFor(server);
    await t.fetch('GET', '/api/sessions', undefined, { scope: 'chief-of-staff' });
    await t.fetch('GET', '/api/sessions');
    server.close();
    expect(seen).toEqual(['chief-of-staff', undefined]);
  });

  test('createWebSocket sends X-Relay-Scope on the upgrade only when a scope is given', async () => {
    const seen = [];
    const server = await listen(() => {}, (req, socket) => { seen.push(req.headers['x-relay-scope']); socket.destroy(); });
    const t = transportFor(server);
    for (const opts of [{ scope: 'chief-of-staff' }, {}]) {
      await new Promise((resolve) => {
        const ws = t.createWebSocket('/ws', opts);
        ws.on('error', () => {});
        ws.on('close', resolve);
      });
    }
    server.close();
    expect(seen).toEqual(['chief-of-staff', undefined]);
  });

  test.each(['admin', '', 'Chief-Of-Staff', null, 7])('scope %j throws RelayConfigError and sends nothing', async (scope) => {
    const onRequest = jest.fn();
    const server = await listen(onRequest);
    const t = transportFor(server);
    await expect(t.fetch('GET', '/api/sessions', undefined, { scope })).rejects.toBeInstanceOf(RelayConfigError);
    expect(() => t.createWebSocket('/ws', { scope })).toThrow(RelayConfigError);
    server.close();
    expect(onRequest).not.toHaveBeenCalled();
  });
});
