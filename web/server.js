const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const ClaudeProvider = require('./providers/claude-provider');
const GeminiProvider = require('./providers/gemini-provider');
const LMStudioProvider = require('./providers/lmstudio-provider');
const SessionStore = require('./session-store');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Data directory for persistence
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Session persistence
const sessionStore = new SessionStore(DATA_DIR);

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
    messages: [],
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

      switch (message.type) {
        case 'create_session':
          currentSessionId = createSession(ws, message.directory, message.projectId);
          break;

        case 'join_session':
          currentSessionId = joinSession(ws, message.sessionId);
          break;

        case 'user_input':
          if (currentSessionId) {
            sendMessage(currentSessionId, message.text, message.files);
          }
          break;

        case 'end_session':
          if (currentSessionId) {
            endSession(currentSessionId);
            currentSessionId = null;
          }
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

      // Instantiate the correct provider
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

      sessions.set(sessionId, session);
    }
  }

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    return null;
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
/help - Show this help message`
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
