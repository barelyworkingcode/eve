// Route test for image paste into a terminal pane. Starts a real Express app on
// a loopback port, so it lives in the integration tier with the other route
// tests that start a server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const registerRoutes = require('../../routes/index');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('POST /api/terminal/paste-image', () => {
  let server, baseUrl, hostPool, agent;

  beforeEach((done) => {
    agent = { request: jest.fn().mockResolvedValue({ ok: true, path: '/tmp/eve-paste-1-ab.png' }) };
    hostPool = { get: jest.fn((id) => (id === 'h1' ? agent : null)), disconnect: jest.fn() };
    const app = express();
    app.use(express.json());
    registerRoutes(app, {
      authService: { isEnrolled: () => true, validateSession: (t) => t === 'good' },
      trustedNetwork: { isTrusted: () => false },
      relayTransport: { fetch: jest.fn(), fetchRaw: jest.fn() },
      hostPool,
      log: null,
    });
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => { server.close(done); });

  const post = (query, headers, body = PNG) => fetch(`${baseUrl}/api/terminal/paste-image${query}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', ...headers }, body,
  });

  it('401s without a session token', async () => {
    const res = await post('?host=h1', {});
    expect(res.status).toBe(401);
    expect(agent.request).not.toHaveBeenCalled();
  });

  it('writes a host paste through the pool and returns its path', async () => {
    const res = await post('?host=h1', { 'x-session-token': 'good' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: '/tmp/eve-paste-1-ab.png' });
    expect(Buffer.from(agent.request.mock.calls[0][1].data, 'base64')).toEqual(PNG);
  });

  it('writes a console paste locally when no host is given', async () => {
    const res = await post('', { 'x-session-token': 'good' });
    expect(res.status).toBe(200);
    const { path: full } = await res.json();
    try {
      expect(path.dirname(full)).toBe(os.tmpdir());
      expect(fs.readFileSync(full)).toEqual(PNG);
    } finally {
      fs.rmSync(full, { force: true });
    }
  });

  it('refuses an unsupported image type and an unknown host', async () => {
    const svg = await post('?host=h1', { 'x-session-token': 'good', 'Content-Type': 'image/svg+xml' }, '<svg/>');
    expect(svg.status).toBe(415);
    const unknown = await post('?host=nope', { 'x-session-token': 'good' });
    expect(unknown.status).toBe(404);
  });
});
