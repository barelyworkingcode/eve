const SessionManager = require('../../session-manager');
const { MockWebSocket, createMockSession } = require('../helpers/mock-session');

// Minimal settings and dependencies for SessionManager
function createTestManager(overrides = {}) {
  const sessions = overrides.sessions || new Map();
  const projects = overrides.projects || new Map();
  const settings = overrides.settings || {
    providers: { claude: true, gemini: true, lmstudio: false },
    providerConfig: {}
  };
  const sessionStore = overrides.sessionStore || {
    save: jest.fn(),
    load: jest.fn(),
    delete: jest.fn(),
    loadAll: jest.fn(() => [])
  };

  return new SessionManager({ sessions, projects, settings, sessionStore });
}

describe('SessionManager', () => {
  describe('getProviderForModel', () => {
    let manager;

    beforeEach(() => {
      manager = createTestManager();
    });

    it('routes gemini models to gemini provider', () => {
      expect(manager.getProviderForModel('gemini-2.0-flash')).toBe('gemini');
      expect(manager.getProviderForModel('gemini-2.0-flash-lite')).toBe('gemini');
      expect(manager.getProviderForModel('auto-gemini-2.5')).not.toBe('gemini'); // doesn't start with 'gemini'
    });

    it('falls back to claude for unknown models', () => {
      expect(manager.getProviderForModel('haiku')).toBe('claude');
      expect(manager.getProviderForModel('sonnet')).toBe('claude');
      expect(manager.getProviderForModel('opus')).toBe('claude');
      expect(manager.getProviderForModel('anything-else')).toBe('claude');
    });
  });

  describe('getAllModels', () => {
    it('returns models from enabled providers only', () => {
      const manager = createTestManager({
        settings: {
          providers: { claude: true, gemini: false, lmstudio: false },
          providerConfig: {}
        }
      });

      const models = manager.getAllModels();
      const groups = [...new Set(models.map(m => m.group))];
      expect(groups).toContain('Claude');
      expect(groups).not.toContain('Gemini');
    });

    it('returns models from multiple enabled providers', () => {
      const manager = createTestManager({
        settings: {
          providers: { claude: true, gemini: true, lmstudio: false },
          providerConfig: {}
        }
      });

      const models = manager.getAllModels();
      const groups = [...new Set(models.map(m => m.group))];
      expect(groups).toContain('Claude');
      expect(groups).toContain('Gemini');
    });

    it('returns empty array when no providers enabled', () => {
      const manager = createTestManager({
        settings: {
          providers: { claude: false, gemini: false, lmstudio: false },
          providerConfig: {}
        }
      });

      const models = manager.getAllModels();
      expect(models).toEqual([]);
    });
  });

  describe('handleSlashCommand', () => {
    let manager;
    let ws;
    let session;

    beforeEach(() => {
      ws = new MockWebSocket();
      session = createMockSession({ ws });
      const sessions = new Map();
      sessions.set(session.sessionId, session);

      manager = createTestManager({ sessions });

      // Stub initProvider to avoid spawning real processes
      jest.spyOn(manager, 'initProvider').mockImplementation((s) => {
        s.provider = {
          kill: jest.fn(),
          handleCommand: jest.fn(() => false),
          constructor: {
            getCommands: () => [],
            clearSessionState: jest.fn(),
            name: 'ClaudeProvider'
          },
          startProcess: jest.fn(),
          getMetadata: jest.fn(() => 'test metadata')
        };
        return s.provider;
      });

      // Set initial mock provider
      session.provider = {
        kill: jest.fn(),
        handleCommand: jest.fn(() => false),
        constructor: {
          getCommands: () => [],
          clearSessionState: jest.fn(),
          name: 'ClaudeProvider'
        },
        startProcess: jest.fn(),
        getMetadata: jest.fn(() => 'test metadata')
      };
    });

    it('returns false for non-slash text', () => {
      expect(manager.handleSlashCommand(session.sessionId, 'hello world')).toBe(false);
    });

    it('returns false for non-existent session', () => {
      expect(manager.handleSlashCommand('nonexistent', '/help')).toBe(false);
    });

    it('handles /help command', () => {
      const result = manager.handleSlashCommand(session.sessionId, '/help');
      expect(result).toBe(true);

      const msg = ws.getLastMessage('system_message');
      expect(msg).not.toBeNull();
      expect(msg.message).toMatch(/\/clear/);
      expect(msg.message).toMatch(/\/help/);
    });

    it('handles /clear command', () => {
      session.messages = [{ role: 'user', content: 'hi' }];
      session.stats.inputTokens = 100;
      const originalKill = session.provider.kill;

      const result = manager.handleSlashCommand(session.sessionId, '/clear');
      expect(result).toBe(true);
      expect(session.messages).toEqual([]);
      expect(session.stats.inputTokens).toBe(0);
      expect(originalKill).toHaveBeenCalled();
      expect(manager.initProvider).toHaveBeenCalledWith(session);
    });

    it('handles /zsh command', () => {
      const result = manager.handleSlashCommand(session.sessionId, '/zsh');
      expect(result).toBe(true);

      const msg = ws.getLastMessage('terminal_request');
      expect(msg).not.toBeNull();
      expect(msg.command).toBe('shell');
    });

    it('handles /bash command as shell', () => {
      const result = manager.handleSlashCommand(session.sessionId, '/bash');
      expect(result).toBe(true);

      const msg = ws.getLastMessage('terminal_request');
      expect(msg.command).toBe('shell');
    });

    it('handles /claude command', () => {
      const result = manager.handleSlashCommand(session.sessionId, '/claude');
      expect(result).toBe(true);

      const msg = ws.getLastMessage('terminal_request');
      expect(msg.command).toBe('claude');
    });

    it('delegates unrecognized commands to provider', () => {
      session.provider.handleCommand.mockReturnValue(true);

      const result = manager.handleSlashCommand(session.sessionId, '/compact');
      expect(result).toBe(true);
      expect(session.provider.handleCommand).toHaveBeenCalledWith(
        'compact', [], expect.any(Function), '/compact'
      );
    });

    it('returns false when provider does not handle command', () => {
      session.provider.handleCommand.mockReturnValue(false);

      const result = manager.handleSlashCommand(session.sessionId, '/unknown');
      expect(result).toBe(false);
    });

    it('handles commands with arguments', () => {
      session.provider.handleCommand.mockReturnValue(true);

      manager.handleSlashCommand(session.sessionId, '/model opus');
      expect(session.provider.handleCommand).toHaveBeenCalledWith(
        'model', ['opus'], expect.any(Function), '/model opus'
      );
    });

    it('handles transfer command from provider', () => {
      session.provider.handleCommand.mockReturnValue({
        handled: true,
        transfer: {
          claudeSessionId: 'sess-123',
          model: 'haiku',
          customArgs: ['--flag']
        }
      });

      const result = manager.handleSlashCommand(session.sessionId, '/transfer-cli');
      expect(result).toBe(true);
      expect(session.transferred).toBe(true);
      expect(session.provider).toBeNull();

      const termReq = ws.getLastMessage('terminal_request');
      expect(termReq.command).toBe('claude');
      expect(termReq.args).toContain('--resume');
      expect(termReq.args).toContain('sess-123');
    });
  });

  describe('createSession', () => {
    let manager, ws, sessionStore;

    beforeEach(() => {
      ws = new MockWebSocket();
      sessionStore = {
        save: jest.fn(),
        load: jest.fn(),
        delete: jest.fn(),
        loadAll: jest.fn(() => [])
      };
      manager = createTestManager({ sessionStore });

      jest.spyOn(manager, 'initProvider').mockImplementation((s) => {
        s.provider = {
          kill: jest.fn(),
          startProcess: jest.fn(),
          getMetadata: jest.fn(() => 'Claude haiku • /tmp')
        };
        return s.provider;
      });
    });

    it('creates a session and sends session_created', () => {
      const sessionId = manager.createSession(ws, '/tmp/project');

      expect(sessionId).toBeDefined();
      expect(manager.sessions.has(sessionId)).toBe(true);

      const session = manager.sessions.get(sessionId);
      expect(session.directory).toBe('/tmp/project');
      expect(session.model).toBe('haiku');

      const msg = ws.getLastMessage('session_created');
      expect(msg).not.toBeNull();
      expect(msg.sessionId).toBe(sessionId);
    });

    it('uses project model and path when projectId provided', () => {
      const projects = new Map();
      projects.set('proj-1', { model: 'opus', path: '/projects/myapp' });
      manager.projects = projects;

      const sessionId = manager.createSession(ws, '/tmp/default', 'proj-1');

      const session = manager.sessions.get(sessionId);
      expect(session.model).toBe('opus');
      expect(session.directory).toBe('/projects/myapp');
      expect(session.projectId).toBe('proj-1');
    });

    it('initializes provider for new session', () => {
      const sessionId = manager.createSession(ws, '/tmp');
      const session = manager.sessions.get(sessionId);

      expect(manager.initProvider).toHaveBeenCalledWith(session);
      expect(session.provider).not.toBeNull();
    });

    it('sets up saveHistory function', () => {
      const sessionId = manager.createSession(ws, '/tmp');
      const session = manager.sessions.get(sessionId);

      session.saveHistory();
      expect(sessionStore.save).toHaveBeenCalledWith(session);
    });
  });

  describe('joinSession', () => {
    let manager, ws, sessionStore;

    beforeEach(() => {
      ws = new MockWebSocket();
      sessionStore = {
        save: jest.fn(),
        load: jest.fn(),
        delete: jest.fn(),
        loadAll: jest.fn(() => [])
      };
      manager = createTestManager({ sessionStore });

      jest.spyOn(manager, 'initProvider').mockImplementation((s) => {
        s.provider = {
          kill: jest.fn(),
          startProcess: jest.fn(),
          getMetadata: jest.fn(() => 'test metadata')
        };
        return s.provider;
      });
    });

    it('joins an existing in-memory session', () => {
      // Pre-populate a session
      const existing = createMockSession({ sessionId: 'existing-1' });
      existing.provider = {
        kill: jest.fn(),
        getMetadata: jest.fn(() => 'existing metadata')
      };
      manager.sessions.set('existing-1', existing);

      const result = manager.joinSession(ws, 'existing-1');

      expect(result).toBe('existing-1');
      expect(existing.ws).toBe(ws);

      const msg = ws.getLastMessage('session_joined');
      expect(msg).not.toBeNull();
      expect(msg.sessionId).toBe('existing-1');
    });

    it('restores session from store if not in memory', () => {
      sessionStore.load.mockReturnValue({
        sessionId: 'saved-1',
        model: 'sonnet',
        directory: '/tmp',
        messages: [{ role: 'user', content: 'hi' }],
        stats: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }
      });

      const result = manager.joinSession(ws, 'saved-1');

      expect(result).toBe('saved-1');
      expect(manager.sessions.has('saved-1')).toBe(true);
      expect(manager.initProvider).toHaveBeenCalled();

      const joinMsg = ws.getLastMessage('session_joined');
      expect(joinMsg.history).toHaveLength(1);
    });

    it('sends error for nonexistent session', () => {
      sessionStore.load.mockReturnValue(null);

      const result = manager.joinSession(ws, 'no-such-session');

      expect(result).toBeNull();
      const errMsg = ws.getLastMessage('error');
      expect(errMsg.message).toMatch(/Session not found/);
    });

    it('sends stats_update after joining', () => {
      const existing = createMockSession({ sessionId: 'sess-1' });
      existing.provider = { getMetadata: jest.fn(() => 'meta') };
      existing.stats.inputTokens = 500;
      manager.sessions.set('sess-1', existing);

      manager.joinSession(ws, 'sess-1');

      const statsMsg = ws.getLastMessage('stats_update');
      expect(statsMsg).not.toBeNull();
      expect(statsMsg.stats.inputTokens).toBe(500);
    });
  });

  describe('sendMessage', () => {
    let manager, ws, session, sessionStore;

    beforeEach(() => {
      ws = new MockWebSocket();
      sessionStore = { save: jest.fn(), load: jest.fn(), delete: jest.fn(), loadAll: jest.fn(() => []) };
      session = createMockSession({ ws });
      session.provider = {
        kill: jest.fn(),
        sendMessage: jest.fn(),
        handleCommand: jest.fn(() => false)
      };
      const sessions = new Map();
      sessions.set(session.sessionId, session);

      manager = createTestManager({ sessions, sessionStore });
    });

    it('saves user message and delegates to provider', () => {
      manager.sendMessage(session.sessionId, 'hello');

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('hello');
      expect(sessionStore.save).toHaveBeenCalledWith(session);
      expect(session.provider.sendMessage).toHaveBeenCalledWith('hello', []);
    });

    it('passes files to provider', () => {
      const files = [{ name: 'test.js', content: 'code', type: 'text' }];
      manager.sendMessage(session.sessionId, 'review this', files);

      expect(session.provider.sendMessage).toHaveBeenCalledWith('review this', files);
      expect(session.messages[0].files).toEqual(files);
    });

    it('does nothing for nonexistent session', () => {
      manager.sendMessage('no-such-session', 'hello');
      expect(sessionStore.save).not.toHaveBeenCalled();
    });

    it('intercepts slash commands instead of sending to provider', () => {
      jest.spyOn(manager, 'handleSlashCommand').mockReturnValue(true);

      manager.sendMessage(session.sessionId, '/help');

      expect(session.provider.sendMessage).not.toHaveBeenCalled();
      expect(session.messages).toHaveLength(0);
    });

    it('blocks messages on transferred sessions', () => {
      session.transferred = true;

      manager.sendMessage(session.sessionId, 'hello');

      expect(session.provider.sendMessage).not.toHaveBeenCalled();
      const errMsg = ws.getLastMessage('error');
      expect(errMsg.message).toMatch(/transferred/);
    });
  });

  describe('endSession', () => {
    let manager, sessionStore;

    beforeEach(() => {
      sessionStore = { save: jest.fn(), load: jest.fn(), delete: jest.fn(), loadAll: jest.fn(() => []) };
      manager = createTestManager({ sessionStore });
    });

    it('kills provider, saves, and removes session', () => {
      const session = createMockSession({ sessionId: 'sess-1' });
      session.provider = { kill: jest.fn() };
      manager.sessions.set('sess-1', session);

      manager.endSession('sess-1');

      expect(session.provider.kill).toHaveBeenCalled();
      expect(sessionStore.save).toHaveBeenCalledWith(session);
      expect(manager.sessions.has('sess-1')).toBe(false);
    });

    it('handles session without provider', () => {
      const session = createMockSession({ sessionId: 'sess-1' });
      session.provider = null;
      manager.sessions.set('sess-1', session);

      expect(() => manager.endSession('sess-1')).not.toThrow();
      expect(manager.sessions.has('sess-1')).toBe(false);
    });

    it('does nothing for nonexistent session', () => {
      expect(() => manager.endSession('no-such')).not.toThrow();
    });
  });

  describe('deleteSession', () => {
    let manager, ws, sessionStore;

    beforeEach(() => {
      ws = new MockWebSocket();
      sessionStore = { save: jest.fn(), load: jest.fn(), delete: jest.fn(), loadAll: jest.fn(() => []) };
      manager = createTestManager({ sessionStore });
    });

    it('kills provider, deletes from store and memory, sends session_ended', () => {
      const session = createMockSession({ sessionId: 'sess-1' });
      session.provider = { kill: jest.fn() };
      manager.sessions.set('sess-1', session);

      manager.deleteSession('sess-1', ws);

      expect(session.provider.kill).toHaveBeenCalled();
      expect(sessionStore.delete).toHaveBeenCalledWith('sess-1');
      expect(manager.sessions.has('sess-1')).toBe(false);

      const msg = ws.getLastMessage('session_ended');
      expect(msg.sessionId).toBe('sess-1');
    });

    it('sends session_ended even if session not in memory', () => {
      manager.deleteSession('nonexistent', ws);

      const msg = ws.getLastMessage('session_ended');
      expect(msg.sessionId).toBe('nonexistent');
    });
  });

  describe('restoreSavedSessions', () => {
    it('loads all sessions from store into memory', () => {
      const sessionStore = {
        save: jest.fn(),
        load: jest.fn(),
        delete: jest.fn(),
        loadAll: jest.fn(() => [
          { sessionId: 's1', model: 'haiku', directory: '/tmp', messages: [], stats: {} },
          { sessionId: 's2', model: 'opus', directory: '/tmp', messages: [], stats: {} }
        ])
      };
      const manager = createTestManager({ sessionStore });

      const count = manager.restoreSavedSessions();

      expect(count).toBe(2);
      expect(manager.sessions.has('s1')).toBe(true);
      expect(manager.sessions.has('s2')).toBe(true);
    });

    it('restored sessions have no active provider', () => {
      const sessionStore = {
        save: jest.fn(),
        load: jest.fn(),
        delete: jest.fn(),
        loadAll: jest.fn(() => [
          { sessionId: 's1', model: 'haiku', directory: '/tmp', messages: [], stats: {} }
        ])
      };
      const manager = createTestManager({ sessionStore });
      manager.restoreSavedSessions();

      const session = manager.sessions.get('s1');
      expect(session.provider).toBeNull();
      expect(session.processing).toBe(false);
    });

    it('returns 0 when no saved sessions', () => {
      const manager = createTestManager();
      expect(manager.restoreSavedSessions()).toBe(0);
    });
  });
});
