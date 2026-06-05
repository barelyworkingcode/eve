const express = require('express');
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
const { TrustedNetworkService } = require('./trusted-network');
const { RelayTransport, RelayConfigError } = require('./relay-transport');
const { isAllowedWsOrigin, parsePublicOrigin } = require('./ws-origin');
const { computeInlineScriptHashes, buildShellCsp, securityHeaders } = require('./security-headers');
const { ipHostGuard } = require('./ip-host-guard');
const { enrollmentGate, isEnrollmentBlocked } = require('./enrollment-gate');
const { Logger } = require('./logger');
const UiCommandBus = require('./ui-command-bus');

const log = new Logger(process.env.LOG_LEVEL || 'info');
const serverLog = log.child('Server');

const app = express();

// Eve's canonical origin (EVE_PUBLIC_ORIGIN). Shared by the WS origin gate and
// the bare-IP guard.
const PUBLIC_ORIGIN = parsePublicOrigin();

// Security response headers on every route (nosniff, frame-options, referrer,
// COOP, and HSTS over TLS). The strict app-shell CSP is set separately in
// serveIndexWithCachebust. See security-headers.js.
// Placeholder — will be replaced after trustedNetwork is initialized.
let securityHeadersMiddleware;
const securityHeadersPlaceholder = (req, res, next) => {
  if (securityHeadersMiddleware) {
    securityHeadersMiddleware(req, res, next);
  } else {
    next();
  }
};
app.use(securityHeadersPlaceholder);

// Pre-enrollment gate: until a passkey is enrolled, only bootstrap-trusted
// clients (loopback / LAN / WireGuard) may reach Eve at all — remote scanners
// get a boring 404 and can't race for ownership. Runs before the IP guard so a
// blocked remote request gets a uniform 404, not a hostname hint.
// Instantiated below after authService and trustedNetwork are initialized.
let enrollmentGateMiddleware;

// Placeholder for enrollment gate middleware. Will be registered after
// authService and trustedNetwork are initialized.
const enrollmentGatePlaceholder = (req, res, next) => {
  if (enrollmentGateMiddleware) {
    enrollmentGateMiddleware(req, res, next);
  } else {
    next();
  }
};
app.use(enrollmentGatePlaceholder);

// When a canonical origin is configured, refuse browser access by bare IP —
// WebAuthn needs a hostname RP-ID, so IP access can't authenticate anyway.
// See ip-host-guard.js.
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

const wss = new WebSocketServer({ noServer: true });

// Anti-CSWSH: reject WebSocket upgrades carrying a cross-site browser Origin
// BEFORE the socket is accepted. See ws-origin.js and
// docs/security-audit-frontend.md (C1). Set EVE_PUBLIC_ORIGIN to Eve's canonical
// origin when fronting it with a reverse proxy.

// Route upgrades from both servers to the same WebSocket handler
function handleUpgrade(req, socket, head) {
  // Pre-enrollment gate: drop remote upgrades until a passkey exists. Mirrors
  // the HTTP enrollmentGate so a scanner can't reach the WS protocol either.
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

// Data directory for persistence (override with --data <path>)
function parseDataDir() {
  const idx = process.argv.indexOf('--data');
  if (idx !== -1 && process.argv[idx + 1]) {
    const arg = process.argv[idx + 1];
    return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  }
  return path.join(__dirname, 'data');
}
const DATA_DIR = parseDataDir();

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Settings (local to Eve - only used for terminal claude path)
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = {
  providerConfig: {
    claude: { path: null }
  }
};

function loadSettings() {
  // parseJsonc tolerates // and /* */ comments so users can toggle blocks
  // by commenting them out. Comments don't survive writes — saving the file
  // re-serializes via JSON.stringify. Unlike JSON.parse, parseJsonc returns
  // undefined (not a throw) on unparseable input, so guard data with `?.`.
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

// Project cache (refreshed from relayLLM via RelayTransport)
const projectCache = new Map();

// Bus for LLM-initiated UI commands: the eve-control MCP POSTs to a loopback-
// only endpoint and this fans a ui_command out to the browser(s) viewing the
// calling project. The shared secret arrives via .env (relay hands the same
// value to the MCP at registration); without it the endpoint stays inert.
const INTERNAL_SECRET = process.env.EVE_INTERNAL_SECRET || '';
const uiCommandBus = new UiCommandBus({ internalSecret: INTERNAL_SECRET, log: log.child('UiCommandBus') });
if (!INTERNAL_SECRET) {
  serverLog.info('EVE_INTERNAL_SECRET not set — eve-control /internal/ui-command is disabled (run `npm run register:mcp`).');
}

// Services
const authService = new AuthService(DATA_DIR, log.child('Auth'));
const trustedNetwork = new TrustedNetworkService({ log: log.child('TrustedNetwork') });

// Initialize security headers middleware now that trustedNetwork is available
securityHeadersMiddleware = securityHeaders({ trustedNetwork });

// Instantiate enrollment gate middleware now that authService and trustedNetwork are initialized
enrollmentGateMiddleware = enrollmentGate({ authService, trustedNetwork, log: serverLog });

// Relay transport (Unix socket preferred, TCP fallback). Fails the process
// hard on any insecure configuration — see plans/cozy-honking-toast.md
// Section B for the threat model.
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

const searchService = new SearchService();
const fileHandlers = new FileHandlers({
  resolveProject: (id) => projectCache.get(id),
  searchService,
});
const moduleService = new ModuleService(fileHandlers.fileService);
const moduleInvoker = new ModuleInvoker({
  relayTransport,
  moduleService,
  fileService: fileHandlers.fileService,
  resolveProject: (id) => projectCache.get(id),
  log,
});
const searchSummarizer = new SearchSummarizer({
  relayTransport,
  resolveProject: (id) => projectCache.get(id),
  log,
});

function normalizeProject(p) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    allowedMcpIds: p.allowed_mcp_ids || [],
    allowedModels: p.allowed_models || [],
    chatTemplates: (p.chat_templates || []).map(t => ({
      id: t.id,
      name: t.name,
      model: t.model,
      mode: t.mode || 'text',
      voice: t.voice || '',
      systemPrompt: t.system_prompt || '',
      appendClaudeMd: !!t.append_claude_md,
      useRelayTools: !!t.use_relay_tools,
    })),
    permissionPolicy: p.permission_policy ? {
      defaultMode: p.permission_policy.default_mode || 'default',
      allowedTools: p.permission_policy.allowed_tools || [],
      deniedTools: p.permission_policy.denied_tools || [],
    } : null,
    token: p.token || '',
    createdAt: p.created_at || '',
  };
}

async function refreshProjectCache(data) {
  try {
    if (Array.isArray(data)) {
      // Partial upsert (one or more projects from a mutation response).
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

// Initial project cache load
refreshProjectCache();

// Cache-busting token, regenerated on every server start. Injected into
// index.html so script and stylesheet URLs change after a restart and Chrome
// can't serve a stale module-host.js / app.js / etc. against a new server.
// The transformed HTML is computed once and reused — neither the file nor the
// token can change without restarting the process.
const CACHEBUST = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const INDEX_HTML_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Pin index.html's inline bootstrap scripts by hash so the shell CSP can drop
// 'unsafe-inline' for scripts. The cache-bust rewrite below only touches
// `<script src=...>` tags, so the inline bodies the browser hashes are
// identical to what we hash here. Disable with EVE_DISABLE_CSP=1 if a future
// dependency needs a looser policy (see docs/security-audit-frontend.md C3).
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
app.get('/', serveIndexWithCachebust);
app.get('/index.html', serveIndexWithCachebust);

// The module SDK is consumed by sandboxed iframes whose <script src> can't
// carry our server-injected cachebust query (iframe HTML is module-authored).
// Force the browser to revalidate every load so a fresh deploy is picked up
// without users having to hard-refresh inside each module.
app.get('/eve-module-sdk.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});

// Static middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/xterm-addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use('/marked', express.static(path.join(__dirname, 'node_modules/marked')));
app.use('/dompurify', express.static(path.join(__dirname, 'node_modules/dompurify/dist')));
app.use('/mermaid', express.static(path.join(__dirname, 'node_modules/mermaid/dist')));
app.use('/onnxruntime-web', express.static(path.join(__dirname, 'node_modules/onnxruntime-web/dist')));
app.use('/vad-onnx', express.static(path.join(__dirname, 'node_modules/@ricky0123/vad-web/node_modules/onnxruntime-web/dist')));
app.use('/transformers', express.static(path.join(__dirname, 'node_modules/@huggingface/transformers/dist')));
app.use('/vad-web', express.static(path.join(__dirname, 'node_modules/@ricky0123/vad-web/dist')));
app.use('/espeak-ng', express.static(path.join(__dirname, 'node_modules/espeak-ng/dist')));
app.use(express.json({ limit: '50mb' }));

// TTS / STT daemons are hard-pinned to loopback. The previous TTS_HOST /
// STT_HOST env overrides let an operator point these at a remote address
// with no authentication — a footgun with no known consumer. If a real
// split-host deployment ever shows up, add an explicit auth layer instead
// of reopening the loopback pin. See plans/cozy-honking-toast.md Section B.
const ttsService = new TTSService('127.0.0.1', parseInt(process.env.TTS_PORT || '9997', 10));
const sttService = new STTService('127.0.0.1', parseInt(process.env.STT_PORT || '9998', 10));

// Register HTTP routes (proxy to relayLLM + scheduler + local auth)
registerRoutes(app, {
  authService,
  trustedNetwork,
  relayTransport,
  refreshProjectCache,
  removeFromProjectCache: (id) => projectCache.delete(id),
  resolveProject: (id) => projectCache.get(id),
  fileService: fileHandlers.fileService,
  ttsService,
  sttService,
  moduleService,
  log,
});

// LLM-initiated UI commands from the eve-control MCP. Gated to a loopback peer
// AND the shared secret inside the bus — never reachable from the browser or
// the public origin. See ui-command-bus.js.
app.post('/internal/ui-command', (req, res) => uiCommandBus.handleInternalRequest(req, res));

// SPA fallback for /<projectslug>/ deep links. Single-segment regex so
// /api/* and /monaco/... stay multi-segment and never match.
app.get(/^\/[^/]+\/?$/, serveIndexWithCachebust);

// WebSocket connection handler
wss.on('connection', createWsHandler({
  authService,
  trustedNetwork,
  relayTransport,
  fileHandlers,
  moduleService,
  moduleInvoker,
  searchSummarizer,
  claudeConfig: settings.providerConfig.claude,
  resolveProject: (id) => projectCache.get(id),
  ttsService,
  sttService,
  uiBus: uiCommandBus,
  log: log.child('WsHandler')
}));

const PORT = process.env.PORT || 3000;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

// Fail safe on plaintext: traffic (including session tokens) must not leave the
// host unless the operator explicitly opts in. With no TLS we bind loopback
// only — remote access is expected to go through the HTTPS listener. Set
// EVE_ALLOW_PLAINTEXT_REMOTE=1 to expose plain HTTP on all interfaces anyway.
// See docs/security-audit-frontend.md (M2).
const isPlaintext = !(HTTPS_KEY && HTTPS_CERT);
const allowPlaintextRemote = process.env.EVE_ALLOW_PLAINTEXT_REMOTE === '1';
// EVE_BIND_HOST pins the listen address explicitly — e.g. a WireGuard interface
// IP so plaintext is reachable only over the (already-encrypted) tunnel and
// nowhere else. When unset: loopback for plaintext, all interfaces otherwise.
const bindHost = process.env.EVE_BIND_HOST
  || ((isPlaintext && !allowPlaintextRemote) ? '127.0.0.1' : '0.0.0.0');

if (isPlaintext && allowPlaintextRemote) {
  serverLog.warn(
    'Eve is serving plain HTTP on ALL interfaces (EVE_ALLOW_PLAINTEXT_REMOTE=1) — traffic including ' +
    'session tokens is NOT encrypted on the wire. Use HTTPS_KEY / HTTPS_CERT for any networked deployment.'
  );
} else if (isPlaintext) {
  serverLog.info(
    'No TLS configured — binding loopback (127.0.0.1) only. Set HTTPS_KEY / HTTPS_CERT for network access, ' +
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
    // The secondary HTTP listener is bound to loopback ONLY so DUAL_LISTEN
    // cannot accidentally expose plaintext Eve traffic to the LAN. Same-host
    // curl scripts still work; remote access must go through the HTTPS
    // primary listener. See plans/cozy-honking-toast.md Section C.
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      serverLog.info(`HTTP server listening on http://127.0.0.1:${HTTP_PORT} (loopback-only)`);
    });
  }
});

// --- Graceful shutdown ---
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  serverLog.info(`${signal} received, cleaning up...`);

  for (const client of wss.clients) {
    try { client.terminate(); } catch (e) { /* ignore */ }
  }

  authService.stop();
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
