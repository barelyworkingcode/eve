const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const AuthService = require('./auth');
const FileHandlers = require('./file-handlers');
const registerRoutes = require('./routes/index');
const createWsHandler = require('./ws-handler');
const TTSService = require('./tts-service');
const STTService = require('./stt-service');
const { Logger } = require('./logger');

const log = new Logger(process.env.LOG_LEVEL || 'debug');
const serverLog = log.child('Server');

const app = express();

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

// Route upgrades from both servers to the same WebSocket handler
function handleUpgrade(req, socket, head) {
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
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.providerConfig?.claude) {
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

// relayLLM connection
const RELAY_LLM_URL = process.env.RELAY_LLM_URL || 'http://localhost:3001';
const RELAY_LLM_WS_URL = RELAY_LLM_URL.replace(/^http/, 'ws') + '/ws';
serverLog.info(`relayLLM URL: ${RELAY_LLM_URL} (WS: ${RELAY_LLM_WS_URL})`);

// Project cache (refreshed from relayLLM via HTTP proxy routes)
const projectCache = new Map();

async function refreshProjectCache(data) {
  try {
    let projects = data;
    if (!projects) {
      const response = await fetch(`${RELAY_LLM_URL}/api/projects`);
      if (!response.ok) throw new Error(`relayLLM returned ${response.status}`);
      projects = await response.json();
    }
    if (!Array.isArray(projects)) return;
    projectCache.clear();
    for (const p of projects) {
      projectCache.set(p.id, p);
    }
  } catch (err) {
    log.child('ProjectCache').error('Refresh failed:', err.message);
  }
}

// Initial project cache load
refreshProjectCache();

// Services
const authService = new AuthService(DATA_DIR, log.child('Auth'));
const fileHandlers = new FileHandlers((id) => projectCache.get(id));

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

// TTS service (connects to Kokoro daemon)
const ttsService = new TTSService(
  process.env.TTS_HOST || 'localhost',
  parseInt(process.env.TTS_PORT || '9997', 10)
);

// STT service (connects to Whisper daemon)
const sttService = new STTService(
  process.env.STT_HOST || 'localhost',
  parseInt(process.env.STT_PORT || '9998', 10)
);

// Register HTTP routes (proxy to relayLLM + scheduler + local auth)
registerRoutes(app, { authService, relayUrl: RELAY_LLM_URL, refreshProjectCache, resolveProject: (id) => projectCache.get(id), ttsService, sttService, log });

// WebSocket connection handler
wss.on('connection', createWsHandler({
  authService, fileHandlers,
  relayWsUrl: RELAY_LLM_WS_URL,
  relayHttpUrl: RELAY_LLM_URL,
  claudeConfig: settings.providerConfig.claude,
  resolveProject: (id) => projectCache.get(id),
  ttsService,
  sttService,
  log: log.child('WsHandler')
}));

const PORT = process.env.PORT || 3000;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

server.listen(PORT, () => {
  const protocol = HTTPS_KEY && HTTPS_CERT ? 'https' : 'http';
  serverLog.info(`${protocol.toUpperCase()} server listening on ${protocol}://localhost:${PORT}`);
  if (authService.isEnrolled()) {
    serverLog.info('Authentication: enabled (passkey enrolled)');
  } else {
    serverLog.info('Authentication: disabled (no passkey enrolled - first visitor will become owner)');
  }

  if (httpServer) {
    httpServer.listen(HTTP_PORT, () => {
      serverLog.info(`HTTP server listening on http://localhost:${HTTP_PORT}`);
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
