/**
 * RelayTransport is the single egress point for all Eve<->relay traffic; no
 * other module may open a raw fetch()/WebSocket to relay. Socket mode's 0600
 * perms anchor authorization (bearer token is defense-in-depth); TCP fallback
 * refuses off-loopback plaintext at startup. assertStartupConfig() must never
 * gain a skip-verify escape. See docs/security-review-auth-transport.md Section B.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const WebSocket = require('ws');

const { NullLogger } = require('./logger');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h);
}

class RelayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

class RelayTransport {
  // Does not validate; call assertStartupConfig() separately.
  static fromEnv({ env = process.env, log } = {}) {
    const socketPath = env.RELAY_FRONTEND_SOCKET || null;
    const url = env.RELAY_FRONTEND_URL || 'http://localhost:3001';
    const token = env.RELAY_FRONTEND_TOKEN || null;
    const caPath = env.RELAY_FRONTEND_CA || null;

    return new RelayTransport({ socketPath, url, token, caPath, env, log });
  }

  constructor({ socketPath, url, token, caPath = null, log }) {
    this.log = log || new NullLogger();
    this.socketPath = socketPath;
    this.token = token;

    this.mode = socketPath ? 'socket' : 'tcp';

    // Parsed even in socket mode: its pathname is still used for path-joining
    // when the orchestrator passes both (rare but legal).
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new RelayConfigError(`Invalid RELAY_FRONTEND_URL: ${url} (${err.message})`);
    }
    this.parsedUrl = parsed;
    this.loopback = isLoopbackHost(parsed.hostname);

    // Read once at startup and reused by both the https.Agent and
    // createWebSocket() — no per-connection disk reads.
    this._caBuffer = caPath ? fs.readFileSync(caPath) : undefined;

    if (this.mode === 'socket') {
      this.agent = new http.Agent({ keepAlive: true, socketPath });
      this._httpBase = 'http://relay-frontend.localsocket';
      this._wsBase = 'ws://relay-frontend.localsocket';
    } else if (parsed.protocol === 'https:') {
      this.agent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: true,
        ca: this._caBuffer,
      });
      this._httpBase = `${parsed.protocol}//${parsed.host}`;
      this._wsBase = `wss://${parsed.host}`;
    } else {
      // Plain http: is only valid for loopback dev; built uniformly here so
      // call-site behavior doesn't branch — assertStartupConfig() is what refuses it.
      this.agent = new http.Agent({ keepAlive: true });
      this._httpBase = `${parsed.protocol}//${parsed.host}`;
      this._wsBase = `ws://${parsed.host}`;
    }

    this._isHttps = parsed.protocol === 'https:';
    this._requestLib = this._isHttps ? https : http;
  }

  // Fail-closed: call once in server.js before listen(). Throws
  // RelayConfigError on any insecure configuration.
  assertStartupConfig() {
    if (!this.token) {
      if (this.mode === 'socket') {
        throw new RelayConfigError('RELAY_FRONTEND_SOCKET is set but RELAY_FRONTEND_TOKEN is missing — refusing to start.');
      }
      if (!this.loopback) {
        throw new RelayConfigError(
          `RELAY_FRONTEND_URL points off-loopback (${this.parsedUrl.hostname}) but RELAY_FRONTEND_TOKEN is missing — refusing to start.`
        );
      }
      this.log.warn(
        `RELAY_FRONTEND_TOKEN is not set. Running without relay authentication is only safe for local dev on loopback. ` +
        `Set RELAY_FRONTEND_TOKEN as soon as possible — see docs/security-review-auth-transport.md Section B.`
      );
    }

    if (this.mode === 'tcp' && !this.loopback && this.parsedUrl.protocol !== 'https:') {
      throw new RelayConfigError(
        `RELAY_FRONTEND_URL must use https:// for non-loopback hosts (got ${this.parsedUrl.protocol}//${this.parsedUrl.hostname}). ` +
        `Refusing to start — plaintext credentials on the network are not supported.`
      );
    }

    if (this.mode === 'socket') {
      this.log.info(`Relay transport: unix socket at ${this.socketPath}${this.token ? ' (token set)' : ' (NO TOKEN — dev only)'}`);
    } else {
      this.log.info(
        `Relay transport: ${this.parsedUrl.protocol}//${this.parsedUrl.host}` +
        `${this.token ? ' (token set)' : ' (NO TOKEN — dev only)'}` +
        `${this._caBuffer ? ' (custom CA)' : ''}`
      );
    }
  }

  async fetch(method, path, body) {
    const url = this._buildUrl(this._httpBase, path);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    // Deliberately Node core `http`/`https`, not global fetch(): undici-based
    // fetch pools via a `dispatcher`, not `agent`, which loses control of
    // agent reuse (needed for socket mode).
    const opts = {
      method,
      headers,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    return this._nodeRequest(url, opts);
  }

  createWebSocket(wsPath = '/ws') {
    const url = this._buildUrl(this._wsBase, wsPath);
    const options = { agent: this.agent };
    if (this.token) {
      options.headers = { Authorization: `Bearer ${this.token}` };
    }
    if (this._isHttps && this._caBuffer) {
      options.ca = this._caBuffer;
      options.rejectUnauthorized = true;
    }
    return new WebSocket(url, options);
  }

  async fetchRaw(method, path) {
    const url = this._buildUrl(this._httpBase, path);
    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return this._nodeRequestRaw(url, { method, headers });
  }

  _buildUrl(base, path) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalized}`;
  }

  _nodeRequest(url, { method, headers, body }) {
    return this._doRequest(url, { method, headers, body }).then(({ status, buffer }) => {
      const raw = buffer.toString('utf8');
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = raw; }
      }
      return { status, data };
    });
  }

  _nodeRequestRaw(url, { method, headers }) {
    return this._doRequest(url, { method, headers }).then(({ status, buffer, headers: h }) => ({
      status, data: buffer, headers: h,
    }));
  }

  _doRequest(url, { method, headers, body }) {
    return new Promise((resolve, reject) => {
      const baseLen = url.indexOf('/', url.indexOf('//') + 2);
      const pathAndQuery = baseLen >= 0 ? url.slice(baseLen) : '/';
      const opts = {
        method,
        hostname: this.parsedUrl.hostname,
        port: this.parsedUrl.port || (this._isHttps ? 443 : 80),
        path: pathAndQuery,
        headers: { ...headers },
        agent: this.agent,
      };
      if (this.mode === 'socket') {
        opts.hostname = 'localhost';
        opts.port = null;
      }
      if (body !== undefined) {
        opts.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = this._requestLib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            buffer: Buffer.concat(chunks),
            headers: res.headers,
          });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

module.exports = {
  RelayTransport,
  RelayConfigError,
  // Exported for unit tests
  isLoopbackHost,
};
