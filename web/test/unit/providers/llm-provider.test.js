const LLMProvider = require('../../../providers/llm-provider');
const { MockWebSocket, createMockSession } = require('../../helpers/mock-session');

describe('LLMProvider', () => {
  describe('sendEvent', () => {
    it('sends normalized event via WebSocket', () => {
      const ws = new MockWebSocket();
      const session = createMockSession({ ws });
      const provider = new LLMProvider(session);

      provider.sendEvent({ type: 'assistant', delta: { text: 'hello' } });

      const messages = ws.getMessages('llm_event');
      expect(messages).toHaveLength(1);
      expect(messages[0].sessionId).toBe('test-session-id');
      expect(messages[0].event.type).toBe('assistant');
    });

    it('does not send when ws is null', () => {
      const session = createMockSession({ ws: null });
      const provider = new LLMProvider(session);

      // Should not throw
      expect(() => {
        provider.sendEvent({ type: 'assistant', delta: { text: 'hello' } });
      }).not.toThrow();
    });

    it('does not send when ws is closed', () => {
      const ws = new MockWebSocket();
      ws.readyState = 3; // CLOSED
      const session = createMockSession({ ws });
      const provider = new LLMProvider(session);

      provider.sendEvent({ type: 'assistant', delta: { text: 'hello' } });

      expect(ws.sentMessages).toHaveLength(0);
    });
  });

  describe('normalizeEvent', () => {
    it('passes events through unchanged by default', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);

      const event = { type: 'result', status: 'success' };
      expect(provider.normalizeEvent(event)).toBe(event);
    });
  });

  describe('abstract methods', () => {
    it('startProcess throws not implemented', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(() => provider.startProcess()).toThrow('Not implemented');
    });

    it('sendMessage throws not implemented', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(() => provider.sendMessage()).toThrow('Not implemented');
    });

    it('handleEvent throws not implemented', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(() => provider.handleEvent()).toThrow('Not implemented');
    });

    it('kill throws not implemented', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(() => provider.kill()).toThrow('Not implemented');
    });

    it('getMetadata throws not implemented', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(() => provider.getMetadata()).toThrow('Not implemented');
    });

    it('static getModels throws not implemented', () => {
      expect(() => LLMProvider.getModels()).toThrow('Not implemented');
    });
  });

  describe('session state defaults', () => {
    it('getSessionState returns null by default', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(provider.getSessionState()).toBeNull();
    });

    it('restoreSessionState does not throw', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(() => provider.restoreSessionState({ some: 'data' })).not.toThrow();
    });

    it('clearSessionState deletes providerState', () => {
      const session = { providerState: { foo: 'bar' } };
      LLMProvider.clearSessionState(session);
      expect(session.providerState).toBeUndefined();
    });
  });

  describe('handleCommand', () => {
    it('returns false by default', () => {
      const session = createMockSession();
      const provider = new LLMProvider(session);
      expect(provider.handleCommand('anything', [], jest.fn(), 'anything')).toBe(false);
    });
  });

  describe('getCommands', () => {
    it('returns empty array by default', () => {
      expect(LLMProvider.getCommands()).toEqual([]);
    });
  });
});
