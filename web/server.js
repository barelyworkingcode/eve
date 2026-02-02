const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const ClaudeProvider = require('./providers/claude-provider');
const GeminiProvider = require('./providers/gemini-provider');
const LMStudioProvider = require('./providers/lmstudio-provider');
const SessionStore = require('./session-store');
const FileService = require('./file-service');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Data directory for persistence
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

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
  }
};

// Project storage: projectId -> { id, name, path, createdAt }
const projects = new Map();

// Session storage: sessionId -> { ws, directory, provider, processing, stats, projectId }
const sessions = new Map();

// Terminal storage: terminalId -> { ws, pty, directory, command }
const terminals = new Map();

// Load settings from disk
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      settings = { ...settings, ...data };
      console.log('Loaded settings:', settings);
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

// API to list all models
app.get('/api/models', (req, res) => {
  res.json(getAllModels());
});

// API to list all projects
app.get('/api/projects', (req, res) => {
  const projectsList = Array.from(projects.values()).map(project => {
    const provider = getProviderForModel(project.model);
    const disabled = !settings.providers[provider];
    return { ...project, disabled };
  });
  res.json(projectsList);
});

// API to create a project
app.post('/api/projects', (req, res) => {
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
app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  if (!projects.has(id)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  projects.delete(id);
  saveProjects();
  res.json({ success: true });
});

// API to list active sessions
app.get('/api/sessions', (req, res) => {
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

wss.on('connection', (ws) => {
  let currentSessionId = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[Server] Received message:', message.type);

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
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    if (currentSessionId && sessions.has(currentSessionId)) {
      sessions.get(currentSessionId).ws = null;
    }

    // Clean up terminals owned by this WebSocket
    for (const [terminalId, terminal] of terminals) {
      if (terminal.ws === ws) {
        terminal.pty.kill();
        terminals.delete(terminalId);
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
      contextWindow: 200000,
      costUsd: 0
    },
    saveHistory: () => sessionStore.save(session)
  };

  sessions.set(sessionId, session);

  // Instantiate the correct provider based on the model
  const lmStudioModels = LMStudioProvider.getModels().map(m => m.value);
  if (model.startsWith('gemini')) {
    session.provider = new GeminiProvider(session);
  } else if (lmStudioModels.includes(model)) {
    session.provider = new LMStudioProvider(session);
  } else {
    session.provider = new ClaudeProvider(session);
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
      session.provider = new GeminiProvider(session);
    } else if (lmStudioModels.includes(session.model)) {
      session.provider = new LMStudioProvider(session);
    } else {
      session.provider = new ClaudeProvider(session);
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
  const totalTokens = session.stats.inputTokens + session.stats.outputTokens +
                      session.stats.cacheReadTokens + session.stats.cacheCreationTokens;
  const contextPercent = Math.round((totalTokens / session.stats.contextWindow) * 100);

  ws.send(JSON.stringify({
    type: 'stats_update',
    sessionId,
    stats: {
      ...session.stats,
      contextPercent,
      totalTokens
    }
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

  switch (command) {
    case 'model': {
      if (args.length === 0) {
        session.ws?.send(JSON.stringify({
          type: 'system_message',
          sessionId,
          message: `Current model: ${session.model}`
        }));
      } else {
        const newModel = args[0].toLowerCase();
        if (VALID_MODELS.includes(newModel)) {
          session.model = newModel;
          if (session.provider) {
            session.provider.kill();
          }
          
          const lmStudioModels = LMStudioProvider.getModels().map(m => m.value);
          if (newModel.startsWith('gemini')) {
            session.provider = new GeminiProvider(session);
          } else if (lmStudioModels.includes(newModel)) {
            session.provider = new LMStudioProvider(session);
          } else {
            session.provider = new ClaudeProvider(session);
          }
          
          session.provider.startProcess();
          session.ws?.send(JSON.stringify({
            type: 'system_message',
            sessionId,
            message: `Model changed to: ${newModel} (new session started)`
          }));
        } else {
          session.ws?.send(JSON.stringify({
            type: 'system_message',
            sessionId,
            message: `Invalid model. Valid options: ${VALID_MODELS.join(', ')}`
          }));
        }
      }
      return true;
    }

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
        contextWindow: 200000,
        costUsd: 0
      };
      sessionStore.save(session);
      session.provider.startProcess();
      session.ws?.send(JSON.stringify({
        type: 'system_message',
        sessionId,
        message: 'Conversation history cleared'
      }));
      session.ws?.send(JSON.stringify({
        type: 'clear_messages',
        sessionId
      }));
      session.ws?.send(JSON.stringify({
        type: 'stats_update',
        sessionId,
        stats: { ...session.stats, contextPercent: 0, totalTokens: 0 }
      }));
      return true;
    }

    case 'help': {
      session.ws?.send(JSON.stringify({
        type: 'system_message',
        sessionId,
        message: `Available commands:
/model [name] - Show or set model (${VALID_MODELS.join(', ')})
/clear - Clear conversation history
/cost - Show usage/billing info (provider-specific)
/context - Show context window usage (provider-specific)
/compact - Compact conversation history (provider-specific)
/zsh - Open terminal in session directory
/claude - Open Claude CLI in session directory
/help - Show this help message`
      }));
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

    case 'cost':
    case 'context':
    case 'compact':
      return false;

    default:
      return false;
  }
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
    command
  };

  terminals.set(terminalId, terminal);

  ptyProcess.onData((data) => {
    ws.send(JSON.stringify({
      type: 'terminal_output',
      terminalId,
      data
    }));
  });

  ptyProcess.onExit(({ exitCode }) => {
    ws.send(JSON.stringify({
      type: 'terminal_exit',
      terminalId,
      exitCode
    }));
    terminals.delete(terminalId);
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
    terminal.pty.kill();
    terminals.delete(terminalId);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
