/**
 * Relay launch identity: when relay launches eve it hands over a one-shot
 * secret on an inherited pipe (RELAY_LAUNCH_FD) instead of a token in the
 * environment. Eve spends it on a bridge Hello, after which relay recognises
 * eve's frontend-socket connections by the kernel's audit token for this
 * process — no credential ever sits in eve's environment, argv, or on the wire
 * again. Contract: ../spec-launch-identity.md.
 */

const fs = require('fs');
const net = require('net');

const LAUNCH_SECRET_SHAPE = /^[0-9a-f]{64}$/;
const FD_NUMBER_SHAPE = /^[0-9]+$/;
const HELLO_TIMEOUT_MS = 10000;
const MAX_REPLY_BYTES = 64 * 1024;

class LaunchIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LaunchIdentityError';
  }
}

function readLaunchSecret(fdText) {
  if (!FD_NUMBER_SHAPE.test(fdText)) {
    throw new LaunchIdentityError('RELAY_LAUNCH_FD is not a file descriptor number');
  }
  const fd = Number(fdText);
  let bytes;
  try {
    bytes = fs.readFileSync(fd);
  } catch (err) {
    throw new LaunchIdentityError(`reading the launch fd failed (${err.code || err.name})`);
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed or never valid; the read error is the one to report */ }
  }
  const secret = bytes.toString('latin1');
  if (!LAUNCH_SECRET_SHAPE.test(secret)) {
    throw new LaunchIdentityError(`launch secret is not 64 lowercase hex characters (read ${bytes.length} bytes)`);
  }
  return secret;
}

function redact(text, secret) {
  return String(text).split(secret).join('[redacted]');
}

function sayHello({ socketPath, serviceId, secret, timeoutMs = HELLO_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buffered = '';
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err); else resolve(value);
    };
    const fail = (message) => settle(new LaunchIdentityError(redact(message, secret)));

    const timer = setTimeout(() => fail(`bridge Hello timed out after ${timeoutMs}ms`), timeoutMs);

    conn.setEncoding('utf8');
    conn.on('connect', () => {
      conn.write(JSON.stringify({ type: 'Hello', name: serviceId, token: secret }) + '\n');
    });
    conn.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        if (buffered.length > MAX_REPLY_BYTES) fail('bridge Hello reply exceeds size limit');
        return;
      }
      settleFromReply(buffered.slice(0, newline));
    });
    conn.on('error', (err) => fail(`bridge Hello connection failed (${err.code || err.message})`));
    conn.on('close', () => fail('bridge closed the connection before answering Hello'));

    function settleFromReply(line) {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return fail('bridge Hello reply is not JSON');
      }
      if (reply && reply.type === 'Error') {
        return fail(`bridge refused Hello (code ${reply.code}): ${reply.message || 'no message'}`);
      }
      const data = reply && reply.type === 'OK' ? reply.data : null;
      if (!data || typeof data.service_id !== 'string' || !Number.isInteger(data.relay_pid)) {
        return fail('bridge Hello reply is malformed');
      }
      if (data.service_id !== serviceId) {
        return fail(`bridge bound Hello to service "${data.service_id}", expected "${serviceId}"`);
      }
      settle(null, { serviceId: data.service_id, relayPid: data.relay_pid });
    }
  });
}

/**
 * Returns null when eve is not relay-launched. Otherwise consumes the launch
 * fd synchronously — so it is closed before anything can spawn — removes
 * RELAY_LAUNCH_FD from `env` so no child inherits it, and returns the Hello
 * promise. Throws LaunchIdentityError synchronously for a bad fd or secret.
 */
function establishLaunchIdentity({ env = process.env, timeoutMs } = {}) {
  if (env.RELAY_LAUNCH_FD === undefined) return null;
  const fdText = env.RELAY_LAUNCH_FD;
  delete env.RELAY_LAUNCH_FD;

  const secret = readLaunchSecret(fdText);
  const socketPath = env.RELAY_BRIDGE_SOCKET;
  const serviceId = env.RELAY_SERVICE_ID;
  if (!socketPath) throw new LaunchIdentityError('RELAY_LAUNCH_FD is set but RELAY_BRIDGE_SOCKET is missing');
  if (!serviceId) throw new LaunchIdentityError('RELAY_LAUNCH_FD is set but RELAY_SERVICE_ID is missing');

  return sayHello({ socketPath, serviceId, secret, timeoutMs });
}

module.exports = {
  establishLaunchIdentity,
  LaunchIdentityError,
  // Exported for unit tests
  readLaunchSecret,
  sayHello,
};
