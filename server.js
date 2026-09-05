const express = require('express');
const compression = require('compression');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { parse: parseJsonc } = require('jsonc-parser');
const AuthService = require('./auth');
const FileHandlers = require('./file-handlers');
const SearchService = require('./search-service');
const SearchSummarizer = require('./search-summarizer');
const ModuleService = require('./module-service');
const ModuleInvoker = require('./module-invoker');
const registerRoutes = require('./routes/index');
const createWsHandler = require('./ws-handler');
const TTSService = require('./tts-service');
const STTService = require('./stt-service');
const { TrustedNetworkService, isLoopbackHost } = require('./trusted-network');
const { RelayTransport, RelayConfigError } = require('./relay-transport');
const { isAllowedWsOrigin, parsePublicOrigin } = require('./ws-origin');
const { computeInlineScriptHashes, buildShellCsp, securityHeaders } = require('./security-headers');
const { ipHostGuard } = require('./ip-host-guard');
const { enrollmentGate, isEnrollmentBlocked } = require('./enrollment-gate');
const { Logger } = require('./logger');
const UiCommandBus = require('./ui-command-bus');
const { normalizeProject } = require('./project-normalize');
const { HostPool } = require('./ssh-host-pool');

const log = new Logger(process.env.LOG_LEVEL || 'info');
const serverLog = log.child('Server');

const app = express();

// Shared by the WS origin gate and the bare-IP guard.
const PUBLIC_ORIGIN = parsePublicOrigin();

// Replaced once trustedNetwork is initialized below; the app-shell CSP is set
// separately in serveIndexWithCachebust.
let securityHeadersMiddleware;
const securityHeadersPlaceholder = (req, res, next) => {
  if (securityHeadersMiddleware) {
    securityHeadersMiddleware(req, res, next);
  } else {
    next();
  }
};
app.use(securityHeadersPlaceholder);

// Until a passkey is enrolled, only bootstrap-trusted clients (loopback / LAN
// / WireGuard) may reach Eve — remote scanners get a boring 404 and can't
// race for ownership. Runs before the IP guard so a blocked remote request
// gets a uniform 404, not a hostname hint. Instantiated below.
let enrollmentGateMiddleware;

const enrollmentGatePlaceholder = (req, res, next) => {
  if (enrollmentGateMiddleware) {
    enrollmentGateMiddleware(req, res, next);
  } else {
    next();
  }
};
app.use(enrollmentGatePlaceholder);

// WebAuthn needs a hostname RP-ID, so bare-IP access can't authenticate
// anyway; refused when a canonical origin is configured. See ip-host-guard.js.
app.use(ipHostGuard({ origin: PUBLIC_ORIGIN }));

// HTTPS support for WebAuthn on non-localhost
const HTTPS_KEY = process.env.HTTPS_KEY;
const HTTPS_CERT = process.env.HTTPS_CERT;
const DUAL_LISTEN = process.env.DUAL_LISTEN === 'true';

const server = HTTPS_KEY && HTTPS_CERT
  ? https.createServer({
      key: fs.readFileSync(HTTPS_KEY),
      cert: fs.readFileSync(HTTPS_CERT)
    }, app)
  : createServer(app);

// Optional HTTP server for localhost when running HTTPS as primary
const httpServer = (HTTPS_KEY && HTTPS_CERT && DUAL_LISTEN)
  ? createServer(app)
  : null;

// `threshold` skips tiny frames where deflate would cost more CPU than it
// saves; no-context-takeover caps per-connection memory (the ws README flags
// the alternative as a fragmentation risk under load). Binary audio frames
// pass `{ compress: false }` at their send sites.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 3, memLevel: 7 },
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    concurrencyLimit: 10,
    serverMaxWindowBits: 13,
  },
});

// Anti-CSWSH: reject WebSocket upgrades carrying a cross-site browser Origin
// before the socket is accepted. See ws-origin.js and
// docs/security-audit-frontend.md (C1).
function handleUpgrade(req, socket, head) {
  // Mirrors the HTTP enrollmentGate so a scanner can't reach the WS protocol either.
  if (isEnrollmentBlocked(req, { authService, trustedNetwork })) {
    serverLog.warn(`Rejected WebSocket upgrade: enrollment gate blocked (no passkey enrolled)`);
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!isAllowedWsOrigin(req, { publicOrigin: PUBLIC_ORIGIN })) {
    serverLog.warn(`Rejected WebSocket upgrade from disallowed origin: ${req.headers.origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}
server.on('upgrade', handleUpgrade);
if (httpServer) httpServer.on('upgrade', handleUpgrade);

function parseDataDir() {
  const idx = process.argv.indexOf('--data');
  if (idx !== -1 && process.argv[idx + 1]) {
    const arg = process.argv[idx + 1];
    return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  }
  return path.join(__dirname, 'data');
}
const DATA_DIR = parseDataDir();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Operator-authored, read-only to Eve; only used for the terminal claude path.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = {
  providerConfig: {
    claude: { path: null }
  }
};

function loadSettings() {
  // parseJsonc returns undefined (not a throw) on unparseable input — guard
  // data with `?.`. Comments don't survive a write; save re-serializes via
  // JSON.stringify.
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = parseJsonc(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data?.providerConfig?.claude) {
        settings.providerConfig.claude = {
          ...settings.providerConfig.claude,
          ...data.providerConfig.claude
        };
      }
      serverLog.info('Loaded settings');
    }
  } catch (err) {
    serverLog.error('Failed to load settings:', err.message);
  }
}
loadSettings();

const projectCache = new Map();
// id -> relay's hostView (../relay/docs/ssh-hosts.md), INCLUDING ssh_argv —
// this cache is server-side only. ssh_argv must never reach resolveProject's
// output or any HTTP/WS response; routes/index.js strips it explicitly on
// every hosts response.
const hostCache = new Map();

// The eve-control MCP POSTs to a loopback-only endpoint; this fans the
// ui_command out to browser(s) viewing the calling project. Secret arrives via
// .env — relay hands the same value to the MCP at registration; without it
// the endpoint stays inert.
const INTERNAL_SECRET = process.env.EVE_INTERNAL_SECRET || '';
const uiCommandBus = new UiCommandBus({ internalSecret: INTERNAL_SECRET, log: log.child('UiCommandBus') });
if (!INTERNAL_SECRET) {
  serverLog.info('EVE_INTERNAL_SECRET not set — eve-control /internal/ui-command is disabled (run `npm run register:mcp`).');
}

const authService = new AuthService(DATA_DIR, log.child('Auth'));
const trustedNetwork = new TrustedNetworkService({ log: log.child('TrustedNetwork') });

securityHeadersMiddleware = securityHeaders({ trustedNetwork });
enrollmentGateMiddleware = enrollmentGate({ authService, trustedNetwork, log: serverLog });

// Fails the process hard on any insecure configuration.
let relayTransport;
try {
  relayTransport = RelayTransport.fromEnv({ log: log.child('RelayTransport') });
  relayTransport.assertStartupConfig();
} catch (err) {
  if (err instanceof RelayConfigError) {
    serverLog.error(`Refusing to start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Attaches the derived, browser-safe `host` field (null for a console
// project) to a cached project without mutating the cache entry itself —
// host status can change between two resolveProject() calls for the same
// cached project, independent of any project-cache refresh.
function resolveProject(id) {
  const project = projectCache.get(id);
  if (!project) return null;
  if (!project.hostId) return { ...project, host: null };
  const hostView = hostCache.get(project.hostId);
  return {
    ...project,
    host: hostView ? { id: hostView.id, name: hostView.name, status: hostView.status } : null,
  };
}

const hostPool = new HostPool({
  resolveHost: (id) => hostCache.get(id),
  log: log.child('HostPool'),
});

const searchService = new SearchService();
const fileHandlers = new FileHandlers({
  resolveProject,
  searchService,
  hostPool,
});
const moduleService = new ModuleService(fileHandlers.fileService);
const moduleInvoker = new ModuleInvoker({
  relayTransport,
  moduleService,
  fileService: fileHandlers.fileService,
  resolveProject,
  log,
});
const searchSummarizer = new SearchSummarizer({
  relayTransport,
  resolveProject,
  log,
});

async function refreshProjectCache(data) {
  try {
    if (Array.isArray(data)) {
      // Partial upsert from a mutation response, not a full refresh.
      for (const p of data) {
        const normalized = normalizeProject(p);
        projectCache.set(normalized.id, normalized);
      }
      return;
    }
    const { status, data: fetched } = await relayTransport.fetch('GET', '/api/projects');
    if (status < 200 || status >= 300) throw new Error(`relayLLM returned ${status}`);
    if (!Array.isArray(fetched)) return;
    projectCache.clear();
    for (const p of fetched) {
      const normalized = normalizeProject(p);
      projectCache.set(normalized.id, normalized);
    }
  } catch (err) {
    log.child('ProjectCache').error('Refresh failed:', err.message);
  }
}

async function refreshHostCache(data) {
  try {
    if (Array.isArray(data)) {
      for (const h of data) hostCache.set(h.id, h);
      return;
    }
    const { status, data: fetched } = await relayTransport.fetch('GET', '/api/hosts');
    if (status < 200 || status >= 300) throw new Error(`relay returned ${status}`);
    if (!Array.isArray(fetched)) return;
    hostCache.clear();
    for (const h of fetched) hostCache.set(h.id, h);
  } catch (err) {
    log.child('HostCache').error('Refresh failed:', err.message);
  }
}

refreshProjectCache();
refreshHostCache();

// Regenerated per server start so script/stylesheet URLs change after a
// restart and Chrome can't serve stale JS against a new server. Computed once
// and reused — neither the file nor the token changes without a restart.
const CACHEBUST = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const INDEX_HTML_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Hashes pin the inline bootstrap scripts so the shell CSP can drop
// 'unsafe-inline'. Relies on the cache-bust rewrite below only touching
// `<script src=...>` tags — inline bodies must stay byte-identical to what's
// hashed here. Disable with EVE_DISABLE_CSP=1 (see docs/security-audit-frontend.md C3).
const SHELL_CSP = process.env.EVE_DISABLE_CSP === '1'
  ? null
  : buildShellCsp(computeInlineScriptHashes(INDEX_HTML_RAW));

const INDEX_HTML_CACHED = INDEX_HTML_RAW
  .replace(/<script\s+src="(?!https?:|\/\/)([^"?]+)"/g, `<script src="$1?rnd=${CACHEBUST}"`)
  .replace(/<link([^>]*?)\s+href="(?!https?:|\/\/)([^"?]+\.(?:css|js))"/g, `<link$1 href="$2?rnd=${CACHEBUST}"`);

function serveIndexWithCachebust(_req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (SHELL_CSP) res.set('Content-Security-Policy', SHELL_CSP);
  res.send(INDEX_HTML_CACHED);
}

// JSON responses are excluded: compressing a response that mixes a secret
// with attacker-influenced content is the BREACH precondition.
app.use(compression({
  filter: (_req, res) => {
    const type = (res.getHeader('Content-Type') || '').split(';')[0].trim();
    return type === 'text/html'
      || type === 'text/css'
      || type === 'text/javascript'
      || type === 'application/javascript'
      || type === 'image/svg+xml';
  },
}));
app.get('/', serveIndexWithCachebust);
app.get('/index.html', serveIndexWithCachebust);

// Module-authored iframe HTML can't carry our server-injected cachebust
// query, so force revalidation every load instead.
app.get('/eve-module-sdk.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/xterm-addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use('/marked', express.static(path.join(__dirname, 'node_modules/marked')));
app.use('/dompurify', express.static(path.join(__dirname, 'node_modules/dompurify/dist')));
app.use('/mermaid', express.static(path.join(__dirname, 'node_modules/mermaid/dist')));
app.use('/vad-onnx', express.static(path.join(__dirname, 'node_modules/@ricky0123/vad-web/node_modules/onnxruntime-web/dist')));
app.use('/vad-web', express.static(path.join(__dirname, 'node_modules/@ricky0123/vad-web/dist')));
app.use('/three', express.static(path.join(__dirname, 'node_modules/three/build')));
app.use(express.json({ limit: '50mb' }));

// Hard-pinned to loopback: a remote host+no-auth override was a footgun with
// no known consumer. A real split-host deployment needs an explicit auth
// layer, not a reopened loopback pin. See docs/security-review-auth-transport.md Section B.
const ttsService = new TTSService('127.0.0.1', parseInt(process.env.TTS_PORT || '9997', 10));
const sttService = new STTService('127.0.0.1', parseInt(process.env.STT_PORT || '9998', 10));

registerRoutes(app, {
  authService,
  trustedNetwork,
  relayTransport,
  refreshProjectCache,
  removeFromProjectCache: (id) => projectCache.delete(id),
  resolveProject,
  fileService: fileHandlers.fileService,
  fileServiceFor: (project) => fileHandlers.fileServiceFor(project),
  refreshHostCache,
  removeFromHostCache: (id) => hostCache.delete(id),
  hostPool,
  ttsService,
  sttService,
  moduleService,
  log,
});

// Gated to a loopback peer AND the shared secret inside the bus — never
// reachable from the browser or the public origin. See ui-command-bus.js.
app.post('/internal/ui-command', (req, res) => uiCommandBus.handleInternalRequest(req, res));

// Single-segment regex so /api/* and /monaco/... stay multi-segment and never match.
app.get(/^\/[^/]+\/?$/, serveIndexWithCachebust);

wss.on('connection', createWsHandler({
  authService,
  trustedNetwork,
  relayTransport,
  fileHandlers,
  moduleService,
  moduleInvoker,
  searchSummarizer,
  resolveProject,
  hostPool,
  ttsService,
  sttService,
  uiBus: uiCommandBus,
  log: log.child('WsHandler')
}));

// A phone moving between networks leaves a half-open TCP socket the server
// can't tell is dead; it would otherwise linger for the OS TCP timeout,
// holding a ghost relay session. ws.isAlive is (re)set in ws-handler.js on
// each 'pong'. unref() so this interval never keeps the process alive.
const WS_HEARTBEAT_MS = 30000;
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, WS_HEARTBEAT_MS);
wsHeartbeat.unref();

const PORT = process.env.PORT || 3000;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

// Traffic (including session tokens) must not leave the host unless the
// operator explicitly opts in: with no TLS, bind loopback only. Set
// EVE_ALLOW_PLAINTEXT_REMOTE=1 to expose plain HTTP on all interfaces anyway.
// See docs/security-audit-frontend.md (M2).
const isPlaintext = !(HTTPS_KEY && HTTPS_CERT);
const allowPlaintextRemote = process.env.EVE_ALLOW_PLAINTEXT_REMOTE === '1';
// EVE_BIND_HOST pins the listen address explicitly — e.g. a WireGuard
// interface IP, so plaintext is reachable only over that encrypted tunnel.
const bindHost = process.env.EVE_BIND_HOST
  || ((isPlaintext && !allowPlaintextRemote) ? '127.0.0.1' : '0.0.0.0');

// Keyed on the address actually bound, not on EVE_ALLOW_PLAINTEXT_REMOTE:
// EVE_BIND_HOST is the second way off loopback, and reporting that bind as
// "loopback only" would hide unencrypted exposure from the operator.
if (isPlaintext && !isLoopbackHost(bindHost)) {
  const via = allowPlaintextRemote
    ? 'EVE_ALLOW_PLAINTEXT_REMOTE=1'
    : `EVE_BIND_HOST=${bindHost}`;
  const where = bindHost === '0.0.0.0' ? 'ALL interfaces' : bindHost;
  serverLog.warn(
    `Eve is serving plain HTTP on ${where} (${via}) — traffic including ` +
    'session tokens is NOT encrypted on the wire. Use HTTPS_KEY / HTTPS_CERT for any networked deployment.'
  );
} else if (isPlaintext) {
  serverLog.info(
    `No TLS configured — binding loopback (${bindHost}) only. Set HTTPS_KEY / HTTPS_CERT for network access, ` +
    'or EVE_ALLOW_PLAINTEXT_REMOTE=1 to expose plain HTTP on all interfaces (not recommended).'
  );
}

server.listen(PORT, bindHost, () => {
  const protocol = isPlaintext ? 'http' : 'https';
  const scope = bindHost === '0.0.0.0' ? '' : ` (bound ${bindHost})`;
  serverLog.info(`${protocol.toUpperCase()} server listening on ${protocol}://localhost:${PORT}${scope}`);
  if (authService.isEnrolled()) {
    serverLog.info('Authentication: enabled (passkey enrolled)');
  } else {
    serverLog.info('Authentication: disabled (no passkey enrolled - first visitor will become owner)');
  }

  if (httpServer) {
    // Loopback-only so DUAL_LISTEN cannot accidentally expose plaintext Eve
    // traffic to the LAN; remote access must go through the HTTPS listener.
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      serverLog.info(`HTTP server listening on http://127.0.0.1:${HTTP_PORT} (loopback-only)`);
    });
  }
});

let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  serverLog.info(`${signal} received, cleaning up...`);

  clearInterval(wsHeartbeat);

  for (const client of wss.clients) {
    try { client.terminate(); } catch (e) { /* ignore */ }
  }

  authService.stop();
  hostPool.disconnectAll();
  server.closeAllConnections?.();
  httpServer?.closeAllConnections?.();
  server.close();
  if (httpServer) httpServer.close();

  serverLog.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  serverLog.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  serverLog.warn('Unhandled rejection:', reason);
});
