const { RelayTransport, RelayConfigError, isLoopbackHost } = require('../../relay-transport');

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
  test('matches the canonical loopback forms', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  test('rejects non-loopback, incl. non-canonical 127.x (overly-broad check removed, #11)', () => {
    expect(isLoopbackHost('relay.internal')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('127.1.2.3')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('RelayTransport.fromEnv', () => {
  test('builds a socket-mode transport that ignores a stray RELAY_FRONTEND_TOKEN', () => {
    const t = RelayTransport.fromEnv({
      env: {
        RELAY_FRONTEND_SOCKET: '/tmp/relay-llm.sock',
        RELAY_FRONTEND_TOKEN: 'deadbeef',
      },
      log: mkLog(),
    });
    expect(t.mode).toBe('socket');
    expect(t.socketPath).toBe('/tmp/relay-llm.sock');
    expect(t.token).toBeNull();
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

  test('socket mode without RELAY_FRONTEND_TOKEN is not an error and does not warn', () => {
    const log = mkLog();
    const t = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_SOCKET: '/tmp/x.sock' },
      log,
    });
    expect(() => t.assertStartupConfig()).not.toThrow();
    expect(log.calls.warn).toHaveLength(0);
    expect(log.calls.info[0][0]).not.toMatch(/token set/);
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

// fetch(…, { signal }) and stream(): the file plane's two additions. A real
// loopback http server stands in for relay's frontend.
describe('abortable fetch and streamed responses', () => {
  const http = require('http');
  let server;
  let transport;
  let hold;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/slow') { hold = res; return; } // never answered until the test ends it
      if (req.url === '/bytes') {
        res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/10', 'X-Seen-Range': String(req.headers.range) });
        res.write('abcd');
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    transport = RelayTransport.fromEnv({
      env: { RELAY_FRONTEND_URL: `http://127.0.0.1:${server.address().port}`, RELAY_FRONTEND_TOKEN: 't' },
      log: mkLog(),
    });
  });

  afterAll(async () => {
    if (hold) hold.end();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  test('fetch still answers { status, data } without a signal', async () => {
    await expect(transport.fetch('GET', '/ok')).resolves.toEqual({ status: 200, data: { ok: true } });
  });

  test('an aborted fetch rejects with name AbortError', async () => {
    const ctl = new AbortController();
    const pending = transport.fetch('POST', '/slow', {}, { signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a fetch whose signal is already aborted rejects with name AbortError', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(transport.fetch('POST', '/slow', {}, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('stream resolves with status, headers and an unread body, sending the given headers', async () => {
    const res = await transport.stream('GET', '/bytes', { headers: { Range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-3/10');
    expect(res.headers['x-seen-range']).toBe('bytes=0-3');
    const chunks = [];
    for await (const c of res.body) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('abcd');
  });
});
