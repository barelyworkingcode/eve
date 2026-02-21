const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const ClaudeProvider = require('./providers/claude-provider');
const GeminiProvider = require('./providers/gemini-provider');
const LMStudioProvider = require('./providers/lmstudio-provider');

// Provider registry - order matters: first match wins in getProviderForModel()
// Claude must be last as the catch-all fallback
const providerRegistry = [];

function registerProvider(key, ProviderClass, matchModel) {
  providerRegistry.push({ key, ProviderClass, matchModel });
}

registerProvider('gemini', GeminiProvider, m => m.startsWith('gemini'));
registerProvider('lmstudio', LMStudioProvider, m => LMStudioProvider.getModels().some(mod => mod.value === m));
registerProvider('claude', ClaudeProvider, () => true);

class SessionManager {
  constructor({ sessions, projects, settings, sessionStore }) {
    this.sessions = sessions;
    this.projects = projects;
    this.settings = settings;
    this.sessionStore = sessionStore;
  }

  // --- Provider management ---

  getProviderForModel(model) {
    const entry = providerRegistry.find(p => p.matchModel(model));
    return entry?.key || 'claude';
  }

  getProviderClass(model) {
    const type = this.getProviderForModel(model);
    const entry = providerRegistry.find(p => p.key === type);
    return entry?.ProviderClass || ClaudeProvider;
  }

  getProviderConfig(providerType) {
    return this.settings.providerConfig[providerType] || {};
  }

  isProviderEnabled(provider) {
    return this.settings.providers[provider];
  }

  initProvider(session, extraArgs = []) {
    const ProviderClass = this.getProviderClass(session.model);
    const config = this.getProviderConfig(this.getProviderForModel(session.model));
    session.provider = new ProviderClass(session, config);
    if (extraArgs.length > 0 && 'customArgs' in session.provider) {
      session.provider.customArgs.push(...extraArgs);
    }
    session.provider.startProcess();
    return session.provider;
  }

  getAllModels() {
    const allModels = [];
    for (const { key, ProviderClass } of providerRegistry) {
      if (this.settings.providers[key]) {
        allModels.push(...ProviderClass.getModels());
      }
    }
    return allModels;
  }

  // --- Hook configuration ---

  ensureHookConfig(projectDir) {
    if (!projectDir) return;

    const settingsDir = path.join(projectDir, '.claude');
    const settingsFile = path.join(settingsDir, 'settings.local.json');
    const hookCommand = `node ${path.resolve(__dirname, 'scripts/permission-hook.js')}`;

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      // File doesn't exist or is invalid -- start fresh
    }

    // Check if our hook is already present
    const hooks = settings.hooks?.PreToolUse || [];
    const eveHookExists = hooks.some(h =>
      h.hooks?.some(hh => hh.command?.includes('permission-hook.js'))
    );
    if (eveHookExists) return;

    // Add Eve's PreToolUse hook
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    settings.hooks.PreToolUse.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: hookCommand,
        timeout: 120
      }]
    });

    try {
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      console.log(`[Hook] Configured PreToolUse hook in ${settingsFile}`);
    } catch (err) {
      console.error(`[Hook] Failed to write settings: ${err.message}`);
    }
  }

  // --- Session lifecycle ---

  createSession(ws, directory, projectId = null) {
    const sessionId = uuidv4();
    const project = projectId ? this.projects.get(projectId) : null;
    const model = project?.model || 'haiku';
    const sessionDirectory = project?.path || directory;

    const session = {
      sessionId,
      ws,
      directory: sessionDirectory,
      projectId,
      name: null,
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
      saveHistory: null
    };
    session.saveHistory = () => this.sessionStore.save(session);

    this.sessions.set(sessionId, session);

    // Ensure the PreToolUse hook is configured in the project directory
    this.ensureHookConfig(sessionDirectory);

    const extraArgs = [];
    if (project?.allowedTools?.length > 0) {
      extraArgs.push('--allowedTools', ...project.allowedTools);
    }
    this.initProvider(session, extraArgs);

    ws.send(JSON.stringify({
      type: 'session_created',
      sessionId,
      directory: sessionDirectory,
      projectId,
      name: null,
      metadata: session.provider.getMetadata()
    }));

    return sessionId;
  }

  joinSession(ws, sessionId) {
    let session = this.sessions.get(sessionId);

    if (!session) {
      const savedSession = this.sessionStore.load(sessionId);
      if (savedSession) {
        session = {
          ...savedSession,
          ws: null,
          provider: null,
          processing: false,
          saveHistory: null
        };
        session.saveHistory = () => this.sessionStore.save(session);
        this.sessions.set(sessionId, session);
      }
    }

    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return null;
    }

    if (!session.provider && !session.transferred) {
      this.initProvider(session);
    }

    session.ws = ws;
    ws.send(JSON.stringify({
      type: 'session_joined',
      sessionId,
      directory: session.directory,
      name: session.name || null,
      metadata: session.provider?.getMetadata() || session.directory,
      history: session.messages || []
    }));

    ws.send(JSON.stringify({
      type: 'stats_update',
      sessionId,
      stats: session.stats
    }));

    return sessionId;
  }

  sendMessage(sessionId, text, files = []) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (this.handleSlashCommand(sessionId, text)) {
      return;
    }

    if (session.transferred) {
      session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId,
        message: 'This session was transferred to a CLI terminal. Use /clear to start a new web conversation.'
      }));
      return;
    }

    const userMessage = {
      timestamp: new Date().toISOString(),
      role: 'user',
      content: text,
      files: files || []
    };
    session.messages.push(userMessage);
    this.sessionStore.save(session);

    if (session.provider) {
      session.provider.sendMessage(text, files);
    }
  }

  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessionStore.save(session);
      if (session.provider) {
        session.provider.kill();
      }
      this.sessions.delete(sessionId);
    }
  }

  deleteSession(sessionId, ws) {
    console.log('[Server] deleteSession called for:', sessionId);
    const session = this.sessions.get(sessionId);

    if (session) {
      console.log('[Server] Found session, killing provider and deleting');
      if (session.provider) {
        session.provider.kill();
      }
      this.sessionStore.delete(sessionId);
      this.sessions.delete(sessionId);
    } else {
      console.log('[Server] Session not found in memory');
    }

    console.log('[Server] Sending session_ended');
    ws.send(JSON.stringify({
      type: 'session_ended',
      sessionId
    }));
  }

  renameSession(sessionId, name, ws) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }
    const trimmed = (name || '').trim().slice(0, 100);
    session.name = trimmed || null;
    this.sessionStore.save(session);

    const msg = JSON.stringify({ type: 'session_renamed', sessionId, name: session.name });
    for (const [, s] of this.sessions) {
      if (s.ws && s.ws.readyState === 1) {
        s.ws.send(msg);
      }
    }
  }

  // --- Slash commands ---

  handleSlashCommand(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return false;

    const parts = trimmed.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    const sendSystemMessage = (message) => {
      session.ws?.send(JSON.stringify({
        type: 'system_message',
        sessionId,
        message
      }));
    };

    switch (command) {
      case 'clear': {
        if (session.provider) {
          session.provider.kill();
          session.provider = null;
        }
        session.messages = [];
        session.stats = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0
        };
        this.getProviderClass(session.model).clearSessionState(session);
        session.transferred = false;

        this.sessionStore.save(session);
        this.initProvider(session);
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
        let helpText = `Global commands:
/clear - Clear conversation history
/zsh - Open terminal in session directory
/claude - Open Claude CLI in session directory
/help - Show this help message`;

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

    if (session.provider && session.provider.handleCommand) {
      const result = session.provider.handleCommand(command, args, sendSystemMessage, trimmed);
      if (result) {
        if (typeof result === 'object' && result.transfer) {
          session.provider.kill();
          session.provider = null;
          session.transferred = true;

          sendSystemMessage('Session transferred to Claude CLI terminal. Use /clear to start a new web conversation.');

          const transfer = result.transfer;
          const terminalArgs = ['--resume', transfer.claudeSessionId, '--model', transfer.model];
          if (transfer.customArgs?.length > 0) {
            terminalArgs.push(...transfer.customArgs);
          }

          session.ws?.send(JSON.stringify({
            type: 'terminal_request',
            sessionId,
            directory: session.directory,
            command: 'claude',
            args: terminalArgs
          }));
        }
        return true;
      }
    }

    return false;
  }

  // --- Headless task execution ---

  async executeHeadlessTask(project, model, prompt, args = []) {
    return new Promise((resolve, reject) => {
      const sessionId = `headless-${Date.now()}`;
      const effectiveModel = model || project.model || 'haiku';

      let responseText = '';
      let completed = false;

      const complete = (err) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);

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

      const mockWs = {
        readyState: 1,
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

      const ProviderClass = this.getProviderClass(effectiveModel);
      const config = this.getProviderConfig(this.getProviderForModel(effectiveModel));
      session.provider = new ProviderClass(session, config);

      if (args.length > 0 && 'customArgs' in session.provider) {
        session.provider.customArgs = [...args];
      }

      const originalHandleEvent = session.provider.handleEvent.bind(session.provider);
      session.provider.handleEvent = (event) => {
        if (event.type === 'assistant') {
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                responseText = block.text;
              }
            }
          } else if (event.content_block?.type === 'text') {
            responseText = event.content_block.text;
          } else if (event.delta?.type === 'text_delta') {
            responseText += event.delta.text;
          }
        }
        originalHandleEvent(event);
      };

      const timeout = setTimeout(() => {
        complete(new Error('Task execution timeout (5 minutes)'));
      }, 5 * 60 * 1000);

      session.provider.startProcess();

      setTimeout(() => {
        session.provider.sendMessage(prompt, []);
      }, 100);
    });
  }

  // --- Session restoration ---

  restoreSavedSessions() {
    const savedSessions = this.sessionStore.loadAll();
    for (const sessionData of savedSessions) {
      const session = {
        ...sessionData,
        ws: null,
        provider: null,
        processing: false,
        saveHistory: null
      };
      session.saveHistory = () => this.sessionStore.save(session);
      this.sessions.set(sessionData.sessionId, session);
    }
    return savedSessions.length;
  }
}

module.exports = SessionManager;
