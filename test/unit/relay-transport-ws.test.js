/**
 * Pins the WebSocket egress contract for RelayTransport.createWebSocket().
 * The audit flagged this as the highest-risk untested path: a silent flip to
 * rejectUnauthorized:false, a dropped CA pin, or a missing Authorization header
 * on the WSS upgrade would all ship green without these.
 *
 * `ws` is mocked to capture the constructor args instead of dialing out.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

jest.mock('ws', () => jest.fn().mockImplementation(function (url, options) {
  this.url = url;
  this.options = options;
}));
const { RelayTransport } = require('../../relay-transport');

describe('RelayTransport.createWebSocket (egress contract)', () => {
  it('socket mode: carries the bearer token, no TLS opts', () => {
    const t = new RelayTransport({ socketPath: '/tmp/relay.sock', url: 'http://localhost:3001', token: 'sekret' });
    const ws = t.createWebSocket('/ws');
    expect(ws.url).toBe('ws://relay-frontend.localsocket/ws');
    expect(ws.options.headers.Authorization).toBe('Bearer sekret');
    expect(ws.options.rejectUnauthorized).toBeUndefined();
    expect(ws.options.ca).toBeUndefined();
  });

  it('https mode: pins the custom CA and keeps rejectUnauthorized true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-ca-'));
    const caFile = path.join(dir, 'ca.pem');
    fs.writeFileSync(caFile, 'CA-CERT-BYTES');
    const t = new RelayTransport({ socketPath: null, url: 'https://relay.example:8443', token: 'tok', caPath: caFile });
    const ws = t.createWebSocket('/ws');
    expect(ws.url).toBe('wss://relay.example:8443/ws');
    expect(ws.options.rejectUnauthorized).toBe(true);
    expect(ws.options.ca).toEqual(Buffer.from('CA-CERT-BYTES'));
    expect(ws.options.headers.Authorization).toBe('Bearer tok');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('omits the Authorization header when no token is configured', () => {
    const t = new RelayTransport({ socketPath: null, url: 'http://localhost:3001', token: null });
    const ws = t.createWebSocket('/ws');
    expect(ws.options.headers).toBeUndefined();
  });

  it('builds the scheduler upstream path on the same authenticated transport', () => {
    const t = new RelayTransport({ socketPath: '/tmp/relay.sock', url: 'http://localhost:3001', token: 'tok' });
    const ws = t.createWebSocket('/ws/tasks');
    expect(ws.url).toBe('ws://relay-frontend.localsocket/ws/tasks');
    expect(ws.options.headers.Authorization).toBe('Bearer tok');
  });
});
