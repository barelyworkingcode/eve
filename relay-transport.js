/**
 * RelayTransport — singleton service that owns all Eve↔relayLLM traffic.
 *
 * Two transport modes, same abstractions:
 *
 *  1. Socket mode (preferred)   — Unix domain socket allocated by the `relay`
 *     orchestrator at spawn time. Enabled by setting RELAY_LLM_SOCKET.
 *     File-system permissions (0600) anchor authorization; the bearer token
 *     is defense-in-depth.
 *
 *  2. TCP mode (fallback)       — HTTPS + WSS for split-host deployments.
 *     Off-loopback HTTP is refused at startup. TLS certificate verification
 *     is always on; an internal CA bundle can be supplied via RELAY_LLM_CA.
 *
 * In both modes, every HTTP request carries `Authorization: Bearer <token>`
 * and every WebSocket upgrade carries the same header via the `ws` package's
 * {headers} constructor option — so relayLLM can reject unauthenticated
 * upgrades before protocol-switching.
 *
 * Full design: plans/cozy-honking-toast.md Section B.
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
  return LOOPBACK_HOSTS.has(h) || h.startsWith('127.');
}

class RelayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

class RelayTransport {
  /**
   * Build a RelayTransport from the process environment. Does NOT perform
   * the startup validation — call assertStartupConfig() for that. This split
   * lets tests construct the object with synthetic config and then assert
   * on the validation step independently.
   *
   * @param {object} [deps]
   * @param {NodeJS.ProcessEnv} [deps.env]
   * @param {Logger} [deps.log]
   */
  static fromEnv({ env = process.env, log } = {}) {
    const socketPath = env.RELAY_LLM_SOCKET || null;
    const url = env.RELAY_LLM_URL || 'http://localhost:3001';
    const token = env.RELAY_LLM_TOKEN || null;
    const caPath = env.RELAY_LLM_CA || null;

    return new RelayTransport({ socketPath, url, token, caPath, env, log });
  }

  /**
   * @param {object} opts
   * @param {string|null} opts.socketPath
   * @param {string} opts.url
   * @param {string|null} opts.token
   * @param {string|null} [opts.caPath]
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @param {Logger} [opts.log]
   */
  constructor({ socketPath, url, token, caPath = null, log }) {
    this.log = log || new NullLogger();
    this.socketPath = socketPath;
    this.token = token;

    this.mode = socketPath ? 'socket' : 'tcp';

    // Parse the TCP URL even in socket mode — we still use its `pathname`
    // for path-joining when the orchestrator passes both (rare but legal).
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new RelayConfigError(`Invalid RELAY_LLM_URL: ${url} (${err.message})`);
    }
    this.parsedUrl = parsed;
    this.loopback = isLoopbackHost(parsed.hostname);

    // Read CA cert once at startup (if configured). Reused for both the
    // https.Agent and createWebSocket() — no per-connection disk reads.
    this._caBuffer = caPath ? fs.readFileSync(caPath) : undefined;

    // Build the shared HTTP agent used by both fetch() and the WS upgrade.
    if (this.mode === 'socket') {
      this.agent = new http.Agent({ keepAlive: true, socketPath });
      this._httpBase = 'http://relay-llm.localsocket';
      this._wsBase = 'ws://relay-llm.localsocket';
    } else if (parsed.protocol === 'https:') {
      this.agent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: true,
        ca: this._caBuffer,
      });
      this._httpBase = `${parsed.protocol}//${parsed.host}`;
      this._wsBase = `wss://${parsed.host}`;
    } else {
      // Plain http: — only valid for loopback dev. We still build an agent
      // so call-site behavior is uniform; assertStartupConfig() may refuse.
      this.agent = new http.Agent({ keepAlive: true });
      this._httpBase = `${parsed.protocol}//${parsed.host}`;
      this._wsBase = `ws://${parsed.host}`;
    }

    // Pre-compute request options that are constant per-instance so
    // _nodeRequest doesn't re-parse the URL on every call.
    this._isHttps = parsed.protocol === 'https:';
    this._requestLib = this._isHttps ? https : http;
  }

  /**
   * Fail-closed startup validation. Call once in server.js before listen().
   * Throws RelayConfigError on any insecure configuration.
   */
  assertStartupConfig() {
    // Token is required except for the explicit dev-loopback case.
    if (!this.token) {
      if (this.mode === 'socket') {
        throw new RelayConfigError('RELAY_LLM_SOCKET is set but RELAY_LLM_TOKEN is missing — refusing to start.');
      }
      if (!this.loopback) {
        throw new RelayConfigError(
          `RELAY_LLM_URL points off-loopback (${this.parsedUrl.hostname}) but RELAY_LLM_TOKEN is missing — refusing to start.`
        );
      }
      // Loopback + plain HTTP + no token: legacy dev config. Warn loudly.
      this.log.warn(
        `RELAY_LLM_TOKEN is not set. Running without relay authentication is only safe for local dev on loopback. ` +
        `Set RELAY_LLM_TOKEN as soon as possible — see plans/cozy-honking-toast.md Section B.`
      );
    }

    // TLS is required for off-loopback TCP mode.
    if (this.mode === 'tcp' && !this.loopback && this.parsedUrl.protocol !== 'https:') {
      throw new RelayConfigError(
        `RELAY_LLM_URL must use https:// for non-loopback hosts (got ${this.parsedUrl.protocol}//${this.parsedUrl.hostname}). ` +
        `Refusing to start — plaintext credentials on the network are not supported.`
      );
    }

    // Log the effective config at startup so operators can verify it.
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

  // --- HTTP ---

  /**
   * Make an authenticated HTTP request to relayLLM. Returns { status, data }
   * where data is the parsed JSON body (or null if empty).
   *
   * @param {string} method
   * @param {string} path — relayLLM path, e.g. '/api/projects'
   * @param {any} [body] — JSON-serializable body, omitted for GET/DELETE
   */
  async fetch(method, path, body) {
    const url = this._buildUrl(this._httpBase, path);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const opts = {
      method,
      headers,
      // Node's undici-based fetch uses a `dispatcher`, not `agent`, for
      // pooling. We use the Node core `http` module instead so we keep
      // full control of agent reuse (esp. for socket mode).
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    return this._nodeRequest(url, opts);
  }

  /**
   * Create a WebSocket connection to relayLLM's /ws endpoint.
   * The bearer token is sent via the Authorization header during the
   * HTTP upgrade, so relayLLM can reject unauthenticated upgrades before
   * protocol-switching.
   *
   * @param {string} [wsPath] — defaults to '/ws'
   */
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

  /**
   * Like fetch(), but returns the raw response Buffer instead of parsing JSON.
   * Used for proxying binary content (generated images, etc.).
   *
   * @param {string} method
   * @param {string} path
   * @returns {Promise<{status: number, data: Buffer, headers: object}>}
   */
  async fetchRaw(method, path) {
    const url = this._buildUrl(this._httpBase, path);
    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return this._nodeRequestRaw(url, { method, headers });
  }

  // --- Internal ---

  _buildUrl(base, path) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalized}`;
  }

  /**
   * Low-level http/https.request wrapper that honors the shared agent
   * (including socketPath for Unix sockets). Returns a Promise<{status, data}>.
   */
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

  /**
   * Like _nodeRequest, but returns the raw Buffer without JSON parsing.
   * Used by fetchRaw() for binary responses (images, etc.).
   */
  _nodeRequestRaw(url, { method, headers }) {
    return this._doRequest(url, { method, headers }).then(({ status, buffer, headers: h }) => ({
      status, data: buffer, headers: h,
    }));
  }

  /**
   * Shared core for _nodeRequest and _nodeRequestRaw. Returns the raw
   * response buffer, status, and headers without any interpretation.
   */
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
