const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const ClaudeProvider = require('./providers/claude-provider');
const GeminiProvider = require('./providers/gemini-provider');
const LMStudioProvider = require('./providers/lmstudio-provider');
const SessionStore = require('./session-store');
const FileService = require('./file-service');
const AuthService = require('./auth');
const TaskScheduler = require('./task-scheduler');

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

// Data directory for persistence
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Auth service
const authService = new AuthService(DATA_DIR);

// Session persistence
const sessionStore = new SessionStore(DATA_DIR);

// File service for secure file operations
const fileService = new FileService();

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
      path: null, // Uses CLAUDE_PATH env var or default
      responseTimeout: 120000, // 2 minutes
      debug: false
    },
    gemini: {
      path: null, // Uses GEMINI_PATH env var or default
      responseTimeout: 120000,
      debug: false
    }
  },
  debug: false
};

// Project storage: projectId -> { id, name, path, createdAt }
const projects = new Map();

// Session storage: sessionId -> { ws, directory, provider, processing, stats, projectId }
const sessions = new Map();

// Terminal storage: terminalId -> { ws, pty, directory, command, buffer, exited, exitCode }
const terminals = new Map();
const TERMINAL_BUFFER_SIZE = 100000; // ~100KB scrollback per terminal

// Load settings from disk
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

      // Merge top-level settings
      if (data.providers) {
        settings.providers = { ...settings.providers, ...data.providers };
      }
      if (data.debug !== undefined) {
        settings.debug = data.debug;
      }

      // Deep merge provider config
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

// Get provider config for a given provider type
function getProviderConfig(providerType) {
  return settings.providerConfig[providerType] || {};
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

// Initialize task scheduler
const taskScheduler = new TaskScheduler(projects, DATA_DIR);

// Load saved sessions on startup
const savedSessions = sessionStore.loadAll();
for (const sessionData of savedSessions) {
  const session = {
    ...sessionData,
    ws: null,
    provider: null,
    processing: false,
    saveHistory: null
  };
  session.saveHistory = () => sessionStore.save(session);
  sessions.set(sessionData.sessionId, session);
}

// Determine which provider a model uses
function getProviderForModel(model) {
  const lmStudioModels = LMStudioProvider.getModels().map(m => m.value);
  if (model.startsWith('gemini')) {
    return 'gemini';
  } else if (lmStudioModels.includes(model)) {
    return 'lmstudio';
  } else {
    return 'claude';
  }
}

// Get all available models from enabled providers
function getAllModels() {
  const allModels = [];

  if (settings.providers.claude) {
    allModels.push(...ClaudeProvider.getModels());
  }
  if (settings.providers.gemini) {
    allModels.push(...GeminiProvider.getModels());
  }
  if (settings.providers.lmstudio) {
    allModels.push(...LMStudioProvider.getModels());
  }

  return allModels;
}

// Valid model names
const VALID_MODELS = getAllModels().map(m => m.value);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/xterm-addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use(express.json({ limit: '50mb' }));

// Get client IP for rate limiting
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket?.remoteAddress ||
         'unknown';
}

// Auth routes (unauthenticated)
app.get('/api/auth/status', (req, res) => {
  // Skip auth for localhost - it's a dev environment
  if (authService.isLocalhost(req)) {
    return res.json({ enrolled: false, authenticated: true, localhost: true });
  }
  const enrolled = authService.isEnrolled();
  const token = req.headers['x-session-token'];
  const authenticated = enrolled && authService.validateSession(token);
  res.json({ enrolled, authenticated });
});

app.post('/api/auth/enroll/start', async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!authService.checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (authService.isEnrolled()) {
      return res.status(400).json({ error: 'Already enrolled' });
    }
    const { options, challengeId } = await authService.generateEnrollmentOptions(req);
    console.log('[Auth] Enrollment started - rpId:', options.rp.id, 'origin:', authService.getOrigin(req));
    res.json({ options, challengeId });
  } catch (err) {
    console.error('Enrollment start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/enroll/finish', async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!authService.checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (authService.isEnrolled()) {
      return res.status(400).json({ error: 'Already enrolled' });
    }
    const { response, challengeId } = req.body;
    if (!response || typeof response !== 'object' || !challengeId || typeof challengeId !== 'string') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    console.log('[Auth] Enrollment finish - credential.id from client:', response.id);
    console.log('[Auth] Enrollment finish - credential.rawId from client:', response.rawId);
    const token = await authService.verifyEnrollment(req, response, challengeId);
    res.json({ token });
  } catch (err) {
    console.error('Enrollment finish failed:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login/start', async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!authService.checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (!authService.isEnrolled()) {
      return res.status(400).json({ error: 'Not enrolled' });
    }
    const { options, challengeId } = await authService.generateLoginOptions(req);
    console.log('[Auth] Login started - rpId:', options.rpId, 'origin:', authService.getOrigin(req));
    console.log('[Auth] Stored credential rpId from auth.json:', authService.loadCredentials()?.rpId || '(not stored)');
    console.log('[Auth] allowCredentials:', JSON.stringify(options.allowCredentials));
    res.json({ options, challengeId });
  } catch (err) {
    console.error('Login start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login/finish', async (req, res) => {
  try {
    const ip = getClientIp(req);
    if (!authService.checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (!authService.isEnrolled()) {
      return res.status(400).json({ error: 'Not enrolled' });
    }
    const { response, challengeId } = req.body;
    if (!response || typeof response !== 'object' || !challengeId || typeof challengeId !== 'string') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const token = await authService.verifyLogin(req, response, challengeId);
    res.json({ token });
  } catch (err) {
    console.error('Login finish failed:', err);
    res.status(400).json({ error: err.message });
  }
});

// Auth middleware for protected routes
function requireAuth(req, res, next) {
  // Skip auth if not enrolled, auth disabled, or localhost
  if (!authService.isEnrolled() || process.env.EVE_NO_AUTH === '1' || authService.isLocalhost(req)) {
    return next();
  }
  const token = req.headers['x-session-token'];
  if (!authService.validateSession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// API to list all models
app.get('/api/models', requireAuth, (req, res) => {
  res.json(getAllModels());
});

// API to list all projects
app.get('/api/projects', requireAuth, (req, res) => {
  const projectsList = Array.from(projects.values()).map(project => {
    const provider = getProviderForModel(project.model);
    const disabled = !settings.providers[provider];
    return { ...project, disabled };
  });
  res.json(projectsList);
});

// API to create a project
app.post('/api/projects', requireAuth, (req, res) => {
  const { name, path: projectPath, model } = req.body;
  if (!name || !projectPath) {
    return res.status(400).json({ error: 'Name and path are required' });
  }

  const project = {
    id: uuidv4(),
    name,
    path: projectPath,
    model: VALID_MODELS.includes(model) ? model : 'haiku',
    createdAt: new Date().toISOString()
  };

  projects.set(project.id, project);
  saveProjects();
  res.json(project);
});

// API to delete a project
app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!projects.has(id)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  projects.delete(id);
  saveProjects();
  res.json({ success: true });
});

// API to list active sessions
app.get('/api/sessions', requireAuth, (req, res) => {
  const sessionList = [];
  for (const [id, session] of sessions) {
    sessionList.push({
      id,
      directory: session.directory,
      projectId: session.projectId || null,
      active: session.provider !== null
    });
  }
  res.json(sessionList);
});

// API to list all scheduled tasks
app.get('/api/tasks', requireAuth, (req, res) => {
  res.json(taskScheduler.getAllTasks());
});

// API to get task execution history
app.get('/api/tasks/:projectId/:taskId/history', requireAuth, (req, res) => {
  const { projectId, taskId } = req.params;
  const history = taskScheduler.getTaskHistory(projectId, taskId);
  res.json(history);
});

// API to manually run a task
app.post('/api/tasks/:projectId/:taskId/run', requireAuth, (req, res) => {
  const { projectId, taskId } = req.params;
  try {
    taskScheduler.runTaskNow(projectId, taskId);
    res.json({ success: true, message: 'Task execution started' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API to update a task (enable/disable)
app.put('/api/tasks/:projectId/:taskId', requireAuth, (req, res) => {
  const { projectId, taskId } = req.params;
  const updates = req.body;
  try {
    const task = taskScheduler.updateTask(projectId, taskId, updates);
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

wss.on('connection', (ws, req) => {
  // Track authentication state for this connection
  // Skip auth for localhost - it's a dev environment
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
          currentSessionId = createSession(ws, message.directory, message.projectId);
          break;

        case 'join_session':
          currentSessionId = joinSession(ws, message.sessionId);
          break;

        case 'user_input':
          console.log('[Server] user_input received, currentSessionId:', currentSessionId);
          if (currentSessionId) {
            sendMessage(currentSessionId, message.text, message.files);
          } else {
            console.log('[Server] No currentSessionId, message dropped');
          }
          break;

        case 'end_session':
          if (currentSessionId) {
            endSession(currentSessionId);
            currentSessionId = null;
          }
          break;

        case 'delete_session':
          console.log('[Server] delete_session received for:', message.sessionId);
          deleteSession(message.sessionId, ws);
          if (currentSessionId === message.sessionId) {
            currentSessionId = null;
          }
          break;

        case 'list_directory':
          handleListDirectory(ws, message);
          break;

        case 'read_file':
          console.log('[Server] read_file request:', message.projectId, message.path);
          handleReadFile(ws, message);
          break;

        case 'write_file':
          handleWriteFile(ws, message);
          break;

        case 'rename_file':
          handleRenameFile(ws, message);
          break;

        case 'move_file':
          handleMoveFile(ws, message);
          break;

        case 'delete_file':
          handleDeleteFile(ws, message);
          break;

        case 'create_directory':
          handleCreateDirectory(ws, message);
          break;

        case 'terminal_create':
          createTerminal(ws, message.directory, message.command);
          break;

        case 'terminal_input':
          handleTerminalInput(message.terminalId, message.data);
          break;

        case 'terminal_resize':
          handleTerminalResize(message.terminalId, message.cols, message.rows);
          break;

        case 'terminal_close':
          closeTerminal(message.terminalId);
          break;

        case 'terminal_list':
          handleTerminalList(ws);
          break;

        case 'terminal_reconnect':
          handleTerminalReconnect(ws, message.terminalId);
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

    // Detach terminals from this WebSocket (but don't kill them - allow reconnect)
    for (const [terminalId, terminal] of terminals) {
      if (terminal.ws === ws) {
        terminal.ws = null;
      }
    }
  });
});

function createSession(ws, directory, projectId = null) {
  const sessionId = uuidv4();

  const project = projectId ? projects.get(projectId) : null;
  const model = project?.model || 'haiku';
  const sessionDirectory = project?.path || directory;

  const session = {
    sessionId,
    ws,
    directory: sessionDirectory,
    projectId,
    provider: null,
    processing: false,
    model,
    createdAt: new Date().toISOString(),
    messages: [],
    stats: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    },
    saveHistory: () => sessionStore.save(session)
  };

  sessions.set(sessionId, session);

  // Instantiate the correct provider based on the model
  const lmStudioModels = LMStudioProvider.getModels().map(m => m.value);
  if (model.startsWith('gemini')) {
    session.provider = new GeminiProvider(session, getProviderConfig('gemini'));
  } else if (lmStudioModels.includes(model)) {
    session.provider = new LMStudioProvider(session);
  } else {
    session.provider = new ClaudeProvider(session, getProviderConfig('claude'));
  }

  // Start the provider process
  session.provider.startProcess();

  ws.send(JSON.stringify({
    type: 'session_created',
    sessionId,
    directory: sessionDirectory,
    projectId,
    metadata: session.provider.getMetadata()
  }));

  return sessionId;
}

function joinSession(ws, sessionId) {
  let session = sessions.get(sessionId);

  // If session not in memory, try to load from disk
  if (!session) {
    const savedSession = sessionStore.load(sessionId);
    if (savedSession) {
      // Recreate session from saved state
      session = {
        ...savedSession,
        ws: null,
        provider: null,
        processing: false,
        saveHistory: () => sessionStore.save(session)
      };
      sessions.set(sessionId, session);
    }
  }

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    return null;
  }

  // Create provider if not exists (e.g., after server restart)
  if (!session.provider) {
    const lmStudioModels = LMStudioProvider.getModels().map(m => m.value);
    if (session.model.startsWith('gemini')) {
      session.provider = new GeminiProvider(session, getProviderConfig('gemini'));
    } else if (lmStudioModels.includes(session.model)) {
      session.provider = new LMStudioProvider(session);
    } else {
      session.provider = new ClaudeProvider(session, getProviderConfig('claude'));
      // Restore Claude session ID for resume support
      if (session.claudeSessionId) {
        session.provider.claudeSessionId = session.claudeSessionId;
      }
      // Restore custom CLI args
      if (session.customArgs && session.customArgs.length > 0) {
        session.provider.customArgs = session.customArgs;
      }
    }

    // Start the provider process
    if (session.provider.startProcess) {
      session.provider.startProcess();
    }
  }

  session.ws = ws;
  ws.send(JSON.stringify({
    type: 'session_joined',
    sessionId,
    directory: session.directory,
    metadata: session.provider?.getMetadata() || session.directory,
    history: session.messages || []
  }));

  // Send current stats
  ws.send(JSON.stringify({
    type: 'stats_update',
    sessionId,
    stats: session.stats
  }));

  return sessionId;
}

function handleSlashCommand(sessionId, text) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Helper to send system messages
  const sendSystemMessage = (message) => {
    session.ws?.send(JSON.stringify({
      type: 'system_message',
      sessionId,
      message
    }));
  };

  // Global commands handled by server
  switch (command) {
    case 'clear': {
      if (session.provider) {
        session.provider.kill();
      }
      session.messages = [];
      session.stats = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0
      };
      // Clear Claude session ID so we start fresh
      session.claudeSessionId = null;
      if (session.provider.claudeSessionId !== undefined) {
        session.provider.claudeSessionId = null;
      }
      sessionStore.save(session);
      session.provider.startProcess();
      sendSystemMessage('Conversation history cleared');
      session.ws?.send(JSON.stringify({
        type: 'clear_messages',
        sessionId
      }));
      session.ws?.send(JSON.stringify({
        type: 'stats_update',
        sessionId,
        stats: session.stats
      }));
      return true;
    }

    case 'help': {
      // Build help message with global and provider-specific commands
      let helpText = `Global commands:
/clear - Clear conversation history
/zsh - Open terminal in session directory
/claude - Open Claude CLI in session directory
/help - Show this help message`;

      // Get provider-specific commands
      if (session.provider && session.provider.constructor.getCommands) {
        const providerCommands = session.provider.constructor.getCommands();
        if (providerCommands.length > 0) {
          const providerName = session.provider.constructor.name.replace('Provider', '');
          helpText += `\n\nProvider commands (${providerName}):`;
          for (const cmd of providerCommands) {
            helpText += `\n/${cmd.name} - ${cmd.description}`;
          }
        }
      }

      sendSystemMessage(helpText);
      return true;
    }

    case 'zsh':
    case 'bash': {
      session.ws?.send(JSON.stringify({
        type: 'terminal_request',
        sessionId,
        directory: session.directory,
        command: 'shell'
      }));
      return true;
    }

    case 'claude': {
      session.ws?.send(JSON.stringify({
        type: 'terminal_request',
        sessionId,
        directory: session.directory,
        command: 'claude'
      }));
      return true;
    }
  }

  // Delegate to provider for provider-specific commands
  if (session.provider && session.provider.handleCommand) {
    const handled = session.provider.handleCommand(command, args, sendSystemMessage, trimmed);
    if (handled) {
      return true;
    }
  }

  // Not a recognized command - pass through to LLM
  return false;
}

function sendMessage(sessionId, text, files = []) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (handleSlashCommand(sessionId, text)) {
    return;
  }

  // Save user message to history
  const userMessage = {
    timestamp: new Date().toISOString(),
    role: 'user',
    content: text,
    files: files || []
  };
  session.messages.push(userMessage);
  sessionStore.save(session);

  if (session.provider) {
    session.provider.sendMessage(text, files);
  }
}

function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    sessionStore.save(session);
    if (session.provider) {
      session.provider.kill();
    }
    sessions.delete(sessionId);
  }
}

function deleteSession(sessionId, ws) {
  console.log('[Server] deleteSession called for:', sessionId);
  const session = sessions.get(sessionId);

  if (session) {
    console.log('[Server] Found session, killing provider and deleting');
    if (session.provider) {
      session.provider.kill();
    }
    sessionStore.delete(sessionId);
    sessions.delete(sessionId);
  } else {
    console.log('[Server] Session not found in memory');
  }

  console.log('[Server] Sending session_ended');
  ws.send(JSON.stringify({
    type: 'session_ended',
    sessionId
  }));
}

async function handleListDirectory(ws, message) {
  const { projectId, path: relativePath } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: relativePath,
        error: 'Project not found'
      }));
    }

    const entries = await fileService.listDirectory(project.path, relativePath || '/');

    ws.send(JSON.stringify({
      type: 'directory_listing',
      projectId,
      path: relativePath || '/',
      entries
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: relativePath,
      error: err.message
    }));
  }
}

async function handleReadFile(ws, message) {
  const { projectId, path: relativePath } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: relativePath,
        error: 'Project not found'
      }));
    }

    const { content, size } = await fileService.readFile(project.path, relativePath);

    ws.send(JSON.stringify({
      type: 'file_content',
      projectId,
      path: relativePath,
      content,
      size
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: relativePath,
      error: err.message
    }));
  }
}

async function handleWriteFile(ws, message) {
  const { projectId, path: relativePath, content } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: relativePath,
        error: 'Project not found'
      }));
    }

    await fileService.writeFile(project.path, relativePath, content);

    ws.send(JSON.stringify({
      type: 'file_saved',
      projectId,
      path: relativePath
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: relativePath,
      error: err.message
    }));
  }
}

async function handleRenameFile(ws, message) {
  const { projectId, path: relativePath, newName } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: relativePath,
        error: 'Project not found'
      }));
    }

    const newPath = await fileService.renameFile(project.path, relativePath, newName);

    ws.send(JSON.stringify({
      type: 'file_renamed',
      projectId,
      oldPath: relativePath,
      newPath: '/' + newPath
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: relativePath,
      error: err.message
    }));
  }
}

async function handleMoveFile(ws, message) {
  const { projectId, sourcePath, destDirectory } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: sourcePath,
        error: 'Project not found'
      }));
    }

    const newPath = await fileService.moveFile(project.path, sourcePath, destDirectory);

    ws.send(JSON.stringify({
      type: 'file_moved',
      projectId,
      oldPath: sourcePath,
      newPath: '/' + newPath
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: sourcePath,
      error: err.message
    }));
  }
}

async function handleDeleteFile(ws, message) {
  const { projectId, path: relativePath } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: relativePath,
        error: 'Project not found'
      }));
    }

    await fileService.deleteFile(project.path, relativePath);

    ws.send(JSON.stringify({
      type: 'file_deleted',
      projectId,
      path: relativePath
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: relativePath,
      error: err.message
    }));
  }
}

async function handleCreateDirectory(ws, message) {
  const { projectId, parentPath, name } = message;

  try {
    const project = projects.get(projectId);
    if (!project) {
      return ws.send(JSON.stringify({
        type: 'file_error',
        projectId,
        path: parentPath,
        error: 'Project not found'
      }));
    }

    const newPath = await fileService.createDirectory(project.path, parentPath, name);

    ws.send(JSON.stringify({
      type: 'directory_created',
      projectId,
      path: '/' + newPath,
      name
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'file_error',
      projectId,
      path: parentPath,
      error: err.message
    }));
  }
}

// Terminal management functions
function createTerminal(ws, directory, command) {
  const terminalId = uuidv4();
  const shell = process.env.SHELL || '/bin/zsh';

  let cmd, args;
  if (command === 'claude') {
    cmd = 'claude';
    args = [];
  } else {
    cmd = shell;
    args = [];
  }

  const ptyProcess = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: directory || process.env.HOME,
    env: process.env
  });

  const terminal = {
    ws,
    pty: ptyProcess,
    directory,
    command,
    buffer: '',
    exited: false,
    exitCode: null
  };

  terminals.set(terminalId, terminal);

  ptyProcess.onData((data) => {
    // Buffer output for reconnection
    terminal.buffer += data;
    if (terminal.buffer.length > TERMINAL_BUFFER_SIZE) {
      terminal.buffer = terminal.buffer.slice(-TERMINAL_BUFFER_SIZE);
    }
    // Send to client if connected
    if (terminal.ws?.readyState === 1) {
      terminal.ws.send(JSON.stringify({
        type: 'terminal_output',
        terminalId,
        data
      }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    terminal.exited = true;
    terminal.exitCode = exitCode;
    // Add exit message to buffer
    const exitMsg = `\r\n\x1b[90m[Process Terminated]\x1b[0m\r\n`;
    terminal.buffer += exitMsg;
    // Send to client if connected
    if (terminal.ws?.readyState === 1) {
      terminal.ws.send(JSON.stringify({
        type: 'terminal_exit',
        terminalId,
        exitCode
      }));
    }
    // Don't delete terminal - keep for reconnect until explicitly closed
  });

  ws.send(JSON.stringify({
    type: 'terminal_created',
    terminalId,
    directory,
    command
  }));
}

function handleTerminalInput(terminalId, data) {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    terminal.pty.write(data);
  }
}

function handleTerminalResize(terminalId, cols, rows) {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    terminal.pty.resize(cols, rows);
  }
}

function closeTerminal(terminalId) {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    if (!terminal.exited) {
      terminal.pty.kill();
    }
    terminals.delete(terminalId);
  }
}

function handleTerminalList(ws) {
  const terminalList = [];
  for (const [id, t] of terminals) {
    terminalList.push({
      terminalId: id,
      directory: t.directory,
      command: t.command,
      exited: t.exited,
      exitCode: t.exitCode
    });
  }
  ws.send(JSON.stringify({ type: 'terminal_list', terminals: terminalList }));
}

function handleTerminalReconnect(ws, terminalId) {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    terminal.ws = ws;  // Reassign WebSocket
    // Replay buffered output
    if (terminal.buffer) {
      ws.send(JSON.stringify({
        type: 'terminal_output',
        terminalId,
        data: terminal.buffer
      }));
    }
    // If exited, send exit event too
    if (terminal.exited) {
      ws.send(JSON.stringify({
        type: 'terminal_exit',
        terminalId,
        exitCode: terminal.exitCode
      }));
    }
  }
}

// Broadcast message to all connected WebSocket clients
function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

// Execute a task in a headless session (no WebSocket)
async function executeHeadlessTask(project, model, prompt) {
  return new Promise((resolve, reject) => {
    const sessionId = `headless-${Date.now()}`;
    const effectiveModel = model || project.model || 'haiku';

    let responseText = '';
    let completed = false;

    const complete = (err) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);

      // Cleanup
      if (session.provider) {
        session.provider.kill();
      }

      if (err) {
        reject(err);
      } else {
        resolve({
          response: responseText,
          stats: session.stats
        });
      }
    };

    // Create a mock WebSocket that captures events
    const mockWs = {
      readyState: 1, // WebSocket.OPEN
      send: (data) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'message_complete') {
            complete(null);
          } else if (message.type === 'error') {
            complete(new Error(message.message));
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    };

    // Create a mock session for the provider
    const session = {
      sessionId,
      ws: mockWs,
      directory: project.path,
      projectId: project.id,
      provider: null,
      processing: false,
      model: effectiveModel,
      messages: [],
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0
      }
    };

    // Create provider based on model
    const lmStudioModels = LMStudioProvider.getModels().map(m => m.value);
    if (effectiveModel.startsWith('gemini')) {
      session.provider = new GeminiProvider(session, getProviderConfig('gemini'));
    } else if (lmStudioModels.includes(effectiveModel)) {
      session.provider = new LMStudioProvider(session);
    } else {
      session.provider = new ClaudeProvider(session, getProviderConfig('claude'));
    }

    // Override handleEvent to capture response text
    const originalHandleEvent = session.provider.handleEvent.bind(session.provider);
    session.provider.handleEvent = (event) => {
      if (event.type === 'assistant') {
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              responseText = block.text; // Replace with full text
            }
          }
        } else if (event.content_block?.type === 'text') {
          responseText = event.content_block.text;
        } else if (event.delta?.type === 'text_delta') {
          responseText += event.delta.text;
        }
      }
      // Call original for processing/stats updates
      originalHandleEvent(event);
    };

    // Set timeout
    const timeout = setTimeout(() => {
      complete(new Error('Task execution timeout (5 minutes)'));
    }, 5 * 60 * 1000);

    // Start provider and send message
    session.provider.startProcess();

    // Small delay to let process start
    setTimeout(() => {
      session.provider.sendMessage(prompt, []);
    }, 100);
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
    const result = await executeHeadlessTask(project, task.model, task.prompt);
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

  // Start task scheduler
  taskScheduler.start();
});
