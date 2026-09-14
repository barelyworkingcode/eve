// The launch fd is exercised as a real fd 3 pipe in a spawned node child, the
// shape relay produces; Hello runs against a real Unix-socket server.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { readLaunchSecret, sayHello, establishLaunchIdentity, LaunchIdentityError } = require('../../launch-identity');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'launch-identity.js');
const SECRET = 'a3'.repeat(32);

// Runs `body` in a child whose fd 3 is a pipe fed `payload` then closed.
// The child prints one JSON line describing what happened.
function runWithLaunchFd(payload, body, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const script = `
      const li = require(${JSON.stringify(MODULE_PATH)});
      const fs = require('fs');
      const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      (async () => { ${body} })().catch((e) => out({ error: e.name + ': ' + e.message }));
    `;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, RELAY_LAUNCH_FD: '3', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch { reject(new Error(`child output: ${stdout} ${stderr}`)); }
    });
    child.stdio[3].end(payload);
  });
}

function tmpSocketPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eli-'));
  return { dir, socketPath: path.join(dir, 'bridge.sock') };
}

// Answers each connection's first line with `reply(parsedLine)`; a string
// reply is written raw, `null` closes without answering.
function startBridge(reply) {
  const { dir, socketPath } = tmpSocketPath();
  const received = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const msg = JSON.parse(buf.slice(0, nl));
      received.push(msg);
      const r = reply(msg);
      if (r === null) return conn.end();
      conn.write(typeof r === 'string' ? r : JSON.stringify(r) + '\n');
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    socketPath,
    received,
    close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })),
  })));
}

describe('readLaunchSecret over a real inherited fd 3 pipe', () => {
  test('reads the 64-hex secret and closes the fd', async () => {
    const result = await runWithLaunchFd(SECRET, `
      const secret = li.readLaunchSecret('3');
      let closed = false;
      try { fs.fstatSync(3); } catch (e) { closed = e.code === 'EBADF'; }
      out({ secret, closed });
    `);
    expect(result).toEqual({ secret: SECRET, closed: true });
  });

  test.each([
    ['too short', 'ab'.repeat(31) + 'a'],
    ['uppercase', 'AB'.repeat(32)],
    ['trailing newline', SECRET + '\n'],
    ['empty', ''],
    ['non-hex', 'zz'.repeat(32)],
  ])('rejects a %s secret without echoing it', async (_label, payload) => {
    const result = await runWithLaunchFd(payload, `
      try { li.readLaunchSecret('3'); out({ ok: true }); }
      catch (e) {
        let closed = false;
        try { fs.fstatSync(3); } catch (err) { closed = err.code === 'EBADF'; }
        out({ error: e.message, name: e.name, closed });
      }
    `);
    expect(result.name).toBe('LaunchIdentityError');
    expect(result.closed).toBe(true);
    if (payload.trim()) expect(result.error).not.toContain(payload.trim());
  });

  test('establishLaunchIdentity strips RELAY_LAUNCH_FD from the env children inherit', async () => {
    const bridge = await startBridge((msg) => ({ type: 'OK', data: { service_id: msg.name, relay_pid: 42 } }));
    try {
      const result = await runWithLaunchFd(SECRET, `
        const id = await li.establishLaunchIdentity({ env: process.env });
        const childEnv = require('child_process').execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']).toString();
        out({ id, inProcessEnv: 'RELAY_LAUNCH_FD' in process.env, childEnv: JSON.parse(childEnv) });
      `, { RELAY_BRIDGE_SOCKET: bridge.socketPath, RELAY_SERVICE_ID: 'eve' });
      expect(result.id).toEqual({ serviceId: 'eve', relayPid: 42 });
      expect(result.inProcessEnv).toBe(false);
      expect(result.childEnv.RELAY_LAUNCH_FD).toBeUndefined();
      expect(JSON.stringify(result.childEnv)).not.toContain(SECRET);
      expect(bridge.received).toEqual([{ type: 'Hello', name: 'eve', token: SECRET }]);
    } finally {
      await bridge.close();
    }
  });
});

describe('readLaunchSecret input validation', () => {
  test('refuses a non-numeric fd', () => {
    expect(() => readLaunchSecret('three')).toThrow(LaunchIdentityError);
  });

  test('refuses an fd that is not open', () => {
    expect(() => readLaunchSecret('65000')).toThrow(/launch fd failed \(EBADF\)/);
  });
});

describe('establishLaunchIdentity', () => {
  test('returns null when not relay-launched', () => {
    expect(establishLaunchIdentity({ env: {} })).toBeNull();
  });

  test('fails closed when RELAY_LAUNCH_FD is set but unusable, and still strips it', () => {
    const env = { RELAY_LAUNCH_FD: '', RELAY_BRIDGE_SOCKET: '/tmp/x', RELAY_SERVICE_ID: 'eve' };
    expect(() => establishLaunchIdentity({ env })).toThrow(LaunchIdentityError);
    expect('RELAY_LAUNCH_FD' in env).toBe(false);
  });
});

describe('sayHello against a real Unix-socket bridge', () => {
  let bridge;
  afterEach(async () => { if (bridge) await bridge.close(); bridge = null; });

  test('sends one Hello line and resolves on OK', async () => {
    bridge = await startBridge((msg) => ({ type: 'OK', data: { service_id: msg.name, relay_pid: 777 } }));
    await expect(sayHello({ socketPath: bridge.socketPath, serviceId: 'eve', secret: SECRET }))
      .resolves.toEqual({ serviceId: 'eve', relayPid: 777 });
    expect(bridge.received).toEqual([{ type: 'Hello', name: 'eve', token: SECRET }]);
  });

  test('rejects on a bridge Error frame, redacting the secret even if echoed', async () => {
    bridge = await startBridge(() => ({ type: 'Error', code: -32001, message: `unauthorized ${SECRET}` }));
    const err = await sayHello({ socketPath: bridge.socketPath, serviceId: 'eve', secret: SECRET }).catch((e) => e);
    expect(err).toBeInstanceOf(LaunchIdentityError);
    expect(err.message).toMatch(/-32001/);
    expect(err.message).not.toContain(SECRET);
  });

  test.each([
    ['non-JSON', 'not json\n', /not JSON/],
    ['OK without data', JSON.stringify({ type: 'OK' }) + '\n', /malformed/],
    ['OK with a string pid', JSON.stringify({ type: 'OK', data: { service_id: 'eve', relay_pid: '1' } }) + '\n', /malformed/],
    ['unexpected type', JSON.stringify({ type: 'Tools' }) + '\n', /malformed/],
    ['another service id', JSON.stringify({ type: 'OK', data: { service_id: 'relayLLM', relay_pid: 1 } }) + '\n', /expected "eve"/],
  ])('rejects a %s reply', async (_label, raw, pattern) => {
    bridge = await startBridge(() => raw);
    await expect(sayHello({ socketPath: bridge.socketPath, serviceId: 'eve', secret: SECRET })).rejects.toThrow(pattern);
  });

  test('rejects when the bridge closes without answering', async () => {
    bridge = await startBridge(() => null);
    await expect(sayHello({ socketPath: bridge.socketPath, serviceId: 'eve', secret: SECRET })).rejects.toThrow(/closed/);
  });

  test('rejects when the bridge never answers', async () => {
    bridge = await startBridge(() => '');
    await expect(sayHello({ socketPath: bridge.socketPath, serviceId: 'eve', secret: SECRET, timeoutMs: 200 }))
      .rejects.toThrow(/timed out/);
  });

  test('rejects when nothing listens on the socket', async () => {
    const { dir, socketPath } = tmpSocketPath();
    try {
      await expect(sayHello({ socketPath, serviceId: 'eve', secret: SECRET })).rejects.toThrow(/connection failed \(ENOENT\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
