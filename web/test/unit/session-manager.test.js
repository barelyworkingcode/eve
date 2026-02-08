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
  });
});
