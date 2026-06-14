/**
 * Integration harness: boots the REAL eve server as a child process (exactly
 * as production runs it — `node server.js`), pointed at the fake relay, on an
 * ephemeral port with a throwaway data dir. Loopback is a trusted subnet, so
 * there's no passkey/auth to deal with. No relay orchestrator, relayLLM, or LLM.
 *
 * Usage:
 *   const eve = await startEve({ projects: [{ id, name, path }] });
 *   ...drive eve.baseUrl over HTTP, or eve.connectWs() over WebSocket...
 *   await eve.stop();
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { createFakeRelay } = require('./fake-relay');

const EVE_DIR = path.resolve(__dirname, '..', '..');

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

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`eve did not become ready at ${url} within ${timeoutMs}ms`);
}

/**
 * A thin WebSocket test client over eve's browser-facing /ws. Collects every
 * JSON frame and lets a test await a specific one.
 */
function makeWsClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { origin: undefined });
  const frames = [];
  const waiters = [];

  const deliver = (frame) => {
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) return deliver({ __binary: true, bytes: data.length });
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    // eve coalesces browser-bound frames into a __batch on a short timer; the
    // real browser client unwraps it, so the test client does too.
    if (msg.type === '__batch' && Array.isArray(msg.msgs)) msg.msgs.forEach(deliver);
    else deliver(msg);
  });

  return {
    raw: ws,
    frames,
    ready: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** Current frame count — pass to waitFor's `fromIndex` to ignore past frames. */
    mark: () => frames.length,
    /**
     * Resolve with the first frame matching pred. Past frames before `fromIndex`
     * are ignored — needed when one socket is reused across steps so a stale
     * frame of the same type (e.g. an earlier session_created) isn't matched.
     */
    waitFor: (pred, timeoutMs = 5000, fromIndex = 0) => new Promise((resolve, reject) => {
      const existing = frames.slice(fromIndex).find(pred);
      if (existing) return resolve(existing);
      const t = setTimeout(() => reject(new Error('waitFor: timed out')), timeoutMs);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    }),
    close: () => new Promise((resolve) => { ws.once('close', resolve); ws.close(); }),
  };
}

async function startEve({ projects = [], env: envOverride = {} } = {}) {
  const relay = createFakeRelay();
  const relayPort = await relay.listen();
  for (const p of projects) relay.addProject(p);

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-data-'));
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    PORT: String(port),
    EVE_BIND_HOST: '127.0.0.1',
    RELAY_FRONTEND_SOCKET: '',                       // force TCP mode at the fake
    RELAY_FRONTEND_URL: `http://127.0.0.1:${relayPort}`,
    RELAY_FRONTEND_TOKEN: 'test-token',
    LOG_LEVEL: process.env.EVE_IT_LOG || 'error',
    EVE_INTERNAL_SECRET: '',
    ...envOverride, // per-test env (e.g. EVE_INTERNAL_SECRET for the ui-command bus)
  };
  if (!('EVE_PUBLIC_ORIGIN' in envOverride)) delete env.EVE_PUBLIC_ORIGIN; // keep the WS origin gate lenient

  const child = spawn('node', ['server.js', '--data', dataDir], { cwd: EVE_DIR, env });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  child.on('exit', (code) => {
    if (code && code !== 0 && !stopping) {
      // Surface a boot failure instead of a mystery timeout.
      // eslint-disable-next-line no-console
      console.error(`eve exited early (code ${code}):\n${stderr.join('')}`);
    }
  });

  let stopping = false;
  try {
    await waitForHttp(`${baseUrl}/api/auth/status`);
  } catch (err) {
    stopping = true;
    child.kill('SIGKILL');
    await relay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`${err.message}\n--- eve stderr ---\n${stderr.join('')}`);
  }

  return {
    baseUrl,
    relay,
    dataDir,
    get: (p, opts) => fetch(`${baseUrl}${p}`, opts),
    connectWs: async () => {
      const client = makeWsClient(`ws://127.0.0.1:${port}/ws`);
      await client.ready();
      return client;
    },
    stop: async () => {
      stopping = true;
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000);
        child.once('exit', () => { clearTimeout(t); r(); }); // clear the fallback so it can't keep the loop alive
      });
      await relay.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startEve };
