const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const SessionStore = require('./session-store');
const AuthService = require('./auth');
const TaskScheduler = require('./task-scheduler');
const TerminalManager = require('./terminal-manager');
const FileHandlers = require('./file-handlers');
const SessionManager = require('./session-manager');
const registerRoutes = require('./routes/index');
const createWsHandler = require('./ws-handler');
const pidRegistry = require('./pid-registry');

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
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Configure LM Studio provider data directory
const LMStudioProvider = require('./providers/lmstudio-provider');
LMStudioProvider.setDataDir(DATA_DIR);

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Settings storage
let settings = {
  providers: { claude: true, gemini: true, lmstudio: true },
  providerConfig: {
    claude: { path: null, responseTimeout: 120000, debug: false },
    gemini: { path: null, responseTimeout: 120000, debug: false }
  },
  debug: false
};

// Project storage
const projects = new Map();

// Session storage
const sessions = new Map();

// Load settings from disk
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.providers) {
        settings.providers = { ...settings.providers, ...data.providers };
      }
      if (data.debug !== undefined) {
        settings.debug = data.debug;
      }
      if (data.providerConfig) {
        for (const provider of ['claude', 'gemini']) {
          if (data.providerConfig[provider]) {
            settings.providerConfig[provider] = {
              ...settings.providerConfig[provider],
              ...data.providerConfig[provider]
            };
          }
        }
      }
      console.log('Loaded settings:', JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error('Failed to load settings:', err.message);
  }
}

// Load projects from disk
function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      for (const project of data.projects || []) {
        projects.set(project.id, project);
      }
      console.log(`Loaded ${projects.size} projects`);
    }
  } catch (err) {
    console.error('Failed to load projects:', err.message);
  }
}

// Save projects to disk
function saveProjects() {
  try {
    const data = { projects: Array.from(projects.values()) };
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save projects:', err.message);
  }
}

// Load settings and projects on startup
loadSettings();
loadProjects();

// Pre-fetch LM Studio models if provider is enabled
if (settings.providers.lmstudio) {
  LMStudioProvider.fetchModels();
}

// Services
const authService = new AuthService(DATA_DIR);
const sessionStore = new SessionStore(DATA_DIR);
const taskScheduler = new TaskScheduler(projects, DATA_DIR);

const sessionManager = new SessionManager({ sessions, projects, settings, sessionStore });
sessionManager.restoreSavedSessions();

const fileHandlers = new FileHandlers(projects);
const terminalManager = new TerminalManager({
  onLinkedSessionExit: (sessionId) => {
    const session = sessions.get(sessionId);
    if (session && session.transferred) {
      session.transferred = false;
      sessionManager.initProvider(session);
      session.ws?.send(JSON.stringify({
        type: 'system_message',
        sessionId,
        message: 'CLI terminal closed. Web session is active again.'
      }));
    }
  }
});

// Static middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/xterm-addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use('/marked', express.static(path.join(__dirname, 'node_modules/marked')));
app.use('/dompurify', express.static(path.join(__dirname, 'node_modules/dompurify/dist')));
app.use(express.json({ limit: '50mb' }));

// Register HTTP routes
const { resolvePermission, setAlwaysAllow } = registerRoutes(app, {
  authService, projects, sessions, sessionManager, taskScheduler,
  saveProjects,
  getAllModels: () => sessionManager.getAllModels(),
  getProviderForModel: (model) => sessionManager.getProviderForModel(model),
  settings
});

// WebSocket connection handler
wss.on('connection', createWsHandler({
  authService, sessions, sessionManager, fileHandlers, terminalManager, resolvePermission, setAlwaysAllow
}));

// Broadcast message to all connected WebSocket clients
function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

// Task scheduler event handlers
taskScheduler.on('run_task', async ({ projectId, task, callback }) => {
  const project = projects.get(projectId);
  if (!project) {
    callback(new Error('Project not found'));
    return;
  }
  try {
    const result = await sessionManager.executeHeadlessTask(project, task.model, task.prompt, task.args || []);
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});

taskScheduler.on('task_started', (execution) => broadcast({ type: 'task_started', ...execution }));
taskScheduler.on('task_completed', (execution) => broadcast({ type: 'task_completed', ...execution }));
taskScheduler.on('task_failed', (execution) => broadcast({ type: 'task_failed', ...execution }));
taskScheduler.on('tasks_updated', (data) => broadcast({ type: 'tasks_updated', ...data }));

const PORT = process.env.PORT || 3000;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

server.listen(PORT, () => {
  const protocol = HTTPS_KEY && HTTPS_CERT ? 'https' : 'http';
  console.log(`${protocol.toUpperCase()} server listening on ${protocol}://localhost:${PORT}`);
  if (authService.isEnrolled()) {
    console.log('Authentication: enabled (passkey enrolled)');
  } else {
    console.log('Authentication: disabled (no passkey enrolled - first visitor will become owner)');
  }
  taskScheduler.start();
  cleanupOrphanedProcesses();
});

if (httpServer) {
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on http://localhost:${HTTP_PORT}`);
  });
}

// --- Startup orphan cleanup ---
function cleanupOrphanedProcesses() {
  const pids = pidRegistry.getAll();
  if (!pids.length) return;

  console.log(`[Cleanup] Found ${pids.length} tracked PIDs from previous run`);
  const alive = [];

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      alive.push(pid);
      console.log(`[Cleanup] Sent SIGTERM to orphaned process (PID ${pid})`);
    } catch (e) {
      // ESRCH = process doesn't exist, already gone
    }
  }

  if (alive.length) {
    setTimeout(() => {
      for (const pid of alive) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
          console.log(`[Cleanup] Force-killed process (PID ${pid})`);
        } catch (e) {
          // Already exited after SIGTERM
        }
      }
    }, 2000);
  }

  pidRegistry.clear();
}

// --- Graceful shutdown ---
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received, cleaning up...`);

  const forceExitTimeout = setTimeout(() => {
    console.error('[Shutdown] Timed out, forcing exit');
    process.exit(1);
  }, 5000);
  forceExitTimeout.unref();

  for (const [id, session] of sessions) {
    try {
      if (session.provider) session.provider.kill();
      sessionStore.save(session);
    } catch (e) {
      console.error(`[Shutdown] Error cleaning session ${id}:`, e.message);
    }
  }

  try {
    terminalManager.killAll();
  } catch (e) {
    console.error('[Shutdown] Error killing terminals:', e.message);
  }

  pidRegistry.clear();

  for (const client of wss.clients) {
    try { client.close(1001, 'Server shutting down'); } catch (e) { /* ignore */ }
  }

  server.close(() => {
    console.log('[Shutdown] Complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[Warning] Unhandled rejection:', reason);
});
