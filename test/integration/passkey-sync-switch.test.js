// EVE_PASSKEY_SYNC=off through a real spawned eve: a verify-only eve never
// touches relay's passkey routes, and the live eve (service id `eve`) refuses
// the switch. Observed from the fake relay's request log, since an empty
// report and no report look the same in listReportedPasskeys().
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { startEve } = require('./harness');
const { createFakeRelay } = require('./fake-relay');

const EVE_DIR = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const passkeyCalls = (relay) => relay.requests.filter((r) => r.path.startsWith('/api/eve/passkeys'));
const sawPath = (relay, p) => relay.requests.some((r) => r.path === p);

async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await sleep(50);
  }
}

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

describe('EVE_PASSKEY_SYNC switch (fake relay)', () => {
  const stops = [];
  afterEach(async () => {
    while (stops.length) await stops.pop()();
  });

  it('an eve without the switch reports its passkeys, even as service id eve', async () => {
    const eve = await startEve({ env: { RELAY_SERVICE_ID: 'eve' } });
    stops.push(eve.stop);

    await waitUntil(() => passkeyCalls(eve.relay).some((r) => r.method === 'PUT'));
    expect(passkeyCalls(eve.relay)).toContainEqual({ method: 'PUT', path: '/api/eve/passkeys' });
  });

  it('with EVE_PASSKEY_SYNC=off a non-live eve serves but never calls the passkey routes', async () => {
    const eve = await startEve({ env: { RELAY_SERVICE_ID: 'eve-verify', EVE_PASSKEY_SYNC: 'off' } });
    stops.push(eve.stop);

    await waitUntil(() => sawPath(eve.relay, '/api/projects'));
    await sleep(1500);

    expect(passkeyCalls(eve.relay)).toEqual([]);
  });

  it('with EVE_PASSKEY_SYNC=off the live eve exits non-zero naming the variable', async () => {
    const relay = createFakeRelay();
    const relayPort = await relay.listen();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-data-'));
    stops.push(async () => {
      await relay.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const env = { ...process.env };
    for (const k of ['RELAY_LAUNCH_FD', 'EVE_PUBLIC_ORIGIN']) delete env[k];
    Object.assign(env, {
      PORT: String(await freePort()),
      EVE_BIND_HOST: '127.0.0.1',
      RELAY_FRONTEND_SOCKET: '',
      RELAY_FRONTEND_URL: `http://127.0.0.1:${relayPort}`,
      RELAY_FRONTEND_TOKEN: 'test-token',
      RELAY_LOG_LEVEL: 'error',
      RELAY_SERVICE_ID: 'eve',
      EVE_PASSKEY_SYNC: 'off',
    });
    const child = spawn(process.execPath, ['server.js', '--data', dataDir], { cwd: EVE_DIR, env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    stops.push(async () => { child.kill('SIGKILL'); await exited; });

    let timer;
    const timedOut = new Promise((r) => { timer = setTimeout(() => r('still running'), 8000); });
    const code = await Promise.race([exited, timedOut]);
    clearTimeout(timer);

    expect(code).not.toBe('still running');
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(output).toMatch(/EVE_PASSKEY_SYNC/);
    // Any relay call at all means eve got as far as serving before refusing.
    expect(relay.requests).toEqual([]);
  });
});
