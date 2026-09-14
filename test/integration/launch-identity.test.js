// server.js launched the way relay launches it: a secret on an fd 3 pipe,
// a bridge socket for Hello, and a frontend socket. Asserts ordering from the
// fake relay's side (what arrived, and when), never from eve's logs alone.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const EVE_DIR = path.resolve(__dirname, '..', '..');
const SECRET = '5e'.repeat(32);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startBridge(dir, { reply, delayMs = 0 }) {
  const socketPath = path.join(dir, 'bridge.sock');
  const events = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const msg = JSON.parse(buf.slice(0, nl));
      events.push({ at: Date.now(), kind: 'hello', msg });
      setTimeout(() => {
        events.push({ at: Date.now(), kind: 'reply' });
        conn.write(JSON.stringify(reply(msg)) + '\n');
      }, delayMs);
    });
    conn.on('error', () => {});
  });
  return new Promise((r) => server.listen(socketPath, () => r({ socketPath, events, server })));
}

function startFrontend(dir) {
  const socketPath = path.join(dir, 'frontend.sock');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ at: Date.now(), url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/api/eve/passkeys') ? '{}' : '[]');
  });
  return new Promise((r) => server.listen(socketPath, () => r({ socketPath, requests, server })));
}

async function launchEve({ dir, payload, bridgeSocket, frontendSocket }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-li-data-'));
  const port = await freePort();
  const env = { ...process.env };
  for (const k of ['RELAY_FRONTEND_URL', 'RELAY_SERVICE_TOKEN', 'RELAY_MCP_TOKEN', 'EVE_PUBLIC_ORIGIN']) delete env[k];
  Object.assign(env, {
    PORT: String(port),
    EVE_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    RELAY_LAUNCH_FD: '3',
    RELAY_SERVICE_ID: 'eve',
    RELAY_BRIDGE_SOCKET: bridgeSocket,
    RELAY_FRONTEND_SOCKET: frontendSocket,
    RELAY_FRONTEND_TOKEN: 'stray-token-must-not-be-sent',
  });
  const child = spawn(process.execPath, ['server.js', '--data', dataDir], {
    cwd: EVE_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.stdio[3].end(payload);
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    port,
    exited,
    output: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(t);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function waitFor(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('server.js relay launch identity', () => {
  let dir;
  const closers = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-')); });
  afterEach(async () => {
    while (closers.length) await closers.pop()();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Hello completes before the first frontend call, which carries no Authorization', async () => {
    const bridge = await startBridge(dir, {
      reply: (msg) => ({ type: 'OK', data: { service_id: msg.name, relay_pid: 4242 } }),
      delayMs: 500,
    });
    const frontend = await startFrontend(dir);
    closers.push(() => new Promise((r) => bridge.server.close(r)), () => new Promise((r) => frontend.server.close(r)));

    const eve = await launchEve({ dir, payload: SECRET, bridgeSocket: bridge.socketPath, frontendSocket: frontend.socketPath });
    closers.push(eve.stop);

    await waitFor(() => frontend.requests.some((r) => r.url === '/api/projects'));
    const replyAt = bridge.events.find((e) => e.kind === 'reply').at;

    expect(bridge.events[0].msg).toEqual({ type: 'Hello', name: 'eve', token: SECRET });
    expect(bridge.events.filter((e) => e.kind === 'hello')).toHaveLength(1);
    expect(Math.min(...frontend.requests.map((r) => r.at))).toBeGreaterThanOrEqual(replyAt);
    for (const r of frontend.requests) expect(r.authorization).toBeUndefined();

    const psEnv = require('child_process').execFileSync('ps', ['eww', '-o', 'command=', '-p', String(eve.child.pid)]).toString();
    expect(psEnv).not.toContain(SECRET);
    expect(eve.output()).not.toContain(SECRET);
  });

  test('a refused Hello exits non-zero before any frontend call, without logging the secret', async () => {
    const bridge = await startBridge(dir, {
      reply: () => ({ type: 'Error', code: -32001, message: 'unauthorized' }),
    });
    const frontend = await startFrontend(dir);
    closers.push(() => new Promise((r) => bridge.server.close(r)), () => new Promise((r) => frontend.server.close(r)));

    const eve = await launchEve({ dir, payload: SECRET, bridgeSocket: bridge.socketPath, frontendSocket: frontend.socketPath });
    closers.push(eve.stop);

    expect(await eve.exited).toBe(1);
    expect(frontend.requests).toHaveLength(0);
    expect(eve.output()).toMatch(/Refusing to start: relay launch identity failed: .*-32001/);
    expect(eve.output()).not.toContain(SECRET);
  });

  test('a malformed launch secret exits non-zero without dialing the bridge', async () => {
    const bridge = await startBridge(dir, { reply: () => ({ type: 'OK', data: { service_id: 'eve', relay_pid: 1 } }) });
    const frontend = await startFrontend(dir);
    closers.push(() => new Promise((r) => bridge.server.close(r)), () => new Promise((r) => frontend.server.close(r)));

    const bad = SECRET.toUpperCase();
    const eve = await launchEve({ dir, payload: bad, bridgeSocket: bridge.socketPath, frontendSocket: frontend.socketPath });
    closers.push(eve.stop);

    expect(await eve.exited).toBe(1);
    expect(bridge.events).toHaveLength(0);
    expect(frontend.requests).toHaveLength(0);
    expect(eve.output()).not.toContain(bad);
  });
});
