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
const registerRoutes = require('./routes');

const app = express();

// HTTPS support for WebAuthn on non-localhost
const HTTPS_KEY = process.env.HTTPS_KEY;
const HTTPS_CERT = process.env.HTTPS_CERT;

const server = HTTPS_KEY && HTTPS_CERT
  ? https.createServer({
      key: fs.readFileSync(HTTPS_KEY),
      cert: fs.readFileSync(HTTPS_CERT)
    }, app)
  : createServer(app);

const wss = new WebSocketServer({ server });

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
  providers: {
    claude: true,
    gemini: true,
    lmstudio: true
  },
  providerConfig: {
    claude: {
      path: null,
      responseTimeout: 120000,
      debug: false
    },
    gemini: {
      path: null,
      responseTimeout: 120000,
      debug: false
    }
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
app.use(express.json({ limit: '50mb' }));

// Register HTTP routes
registerRoutes(app, {
  authService,
  projects,
  sessions,
  taskScheduler,
  saveProjects,
  getAllModels: () => sessionManager.getAllModels(),
  getProviderForModel: (model) => sessionManager.getProviderForModel(model),
  settings
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const host = (req.headers.host || 'localhost').split(':')[0];
  const isLocalhostConnection = host === 'localhost' || host === '127.0.0.1';
  const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !isLocalhostConnection;
  let isAuthenticated = !requiresAuth;
  let currentSessionId = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[Server] Received message:', message.type);

      // Handle auth message first
      if (message.type === 'auth') {
        if (!requiresAuth) {
          ws.send(JSON.stringify({ type: 'auth_success' }));
          return;
        }
        if (authService.validateSession(message.token)) {
          isAuthenticated = true;
          ws.send(JSON.stringify({ type: 'auth_success' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
          ws.close(4001, 'Unauthorized');
        }
        return;
      }

      // Block all other messages until authenticated
      if (!isAuthenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
        return;
      }

      switch (message.type) {
        case 'create_session':
          currentSessionId = sessionManager.createSession(ws, message.directory, message.projectId);
          break;

        case 'join_session':
          currentSessionId = sessionManager.joinSession(ws, message.sessionId);
          break;

        case 'user_input':
          console.log('[Server] user_input received, currentSessionId:', currentSessionId);
          if (currentSessionId) {
            sessionManager.sendMessage(currentSessionId, message.text, message.files);
          } else {
            console.log('[Server] No currentSessionId, message dropped');
          }
          break;

        case 'end_session':
          if (currentSessionId) {
            sessionManager.endSession(currentSessionId);
            currentSessionId = null;
          }
          break;

        case 'delete_session':
          console.log('[Server] delete_session received for:', message.sessionId);
          sessionManager.deleteSession(message.sessionId, ws);
          if (currentSessionId === message.sessionId) {
            currentSessionId = null;
          }
          break;

        case 'rename_session':
          sessionManager.renameSession(message.sessionId, message.name, ws);
          break;

        case 'list_directory':
          fileHandlers.listDirectory(ws, message);
          break;

        case 'read_file':
          console.log('[Server] read_file request:', message.projectId, message.path);
          fileHandlers.readFile(ws, message);
          break;

        case 'write_file':
          fileHandlers.writeFile(ws, message);
          break;

        case 'rename_file':
          fileHandlers.renameFile(ws, message);
          break;

        case 'move_file':
          fileHandlers.moveFile(ws, message);
          break;

        case 'delete_file':
          fileHandlers.deleteFile(ws, message);
          break;

        case 'create_directory':
          fileHandlers.createDirectory(ws, message);
          break;

        case 'terminal_create':
          terminalManager.createTerminal(ws, message.directory, message.command, message.args, message.sessionId, sessionManager.getProviderConfig('claude'));
          break;

        case 'terminal_input':
          terminalManager.handleInput(message.terminalId, message.data);
          break;

        case 'terminal_resize':
          terminalManager.handleResize(message.terminalId, message.cols, message.rows);
          break;

        case 'terminal_close':
          terminalManager.close(message.terminalId);
          break;

        case 'terminal_list':
          terminalManager.list(ws);
          break;

        case 'terminal_reconnect':
          terminalManager.reconnect(ws, message.terminalId);
          break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    if (currentSessionId && sessions.has(currentSessionId)) {
      sessions.get(currentSessionId).ws = null;
    }
    terminalManager.detachAll(ws);
  });
});

// Broadcast message to all connected WebSocket clients
function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(data);
    }
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
    const result = await sessionManager.executeHeadlessTask(project, task.model, task.prompt);
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});

taskScheduler.on('task_started', (execution) => {
  broadcast({ type: 'task_started', ...execution });
});

taskScheduler.on('task_completed', (execution) => {
  broadcast({ type: 'task_completed', ...execution });
});

taskScheduler.on('task_failed', (execution) => {
  broadcast({ type: 'task_failed', ...execution });
});

taskScheduler.on('tasks_updated', (data) => {
  broadcast({ type: 'tasks_updated', ...data });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const protocol = HTTPS_KEY && HTTPS_CERT ? 'https' : 'http';
  console.log(`${protocol.toUpperCase()} server listening on ${protocol}://localhost:${PORT}`);
  if (authService.isEnrolled()) {
    console.log('Authentication: enabled (passkey enrolled)');
  } else {
    console.log('Authentication: disabled (no passkey enrolled - first visitor will become owner)');
  }

  taskScheduler.start();
});
