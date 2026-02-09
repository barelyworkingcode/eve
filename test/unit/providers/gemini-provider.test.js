const GeminiProvider = require('../../../providers/gemini-provider');
const { createMockSession } = require('../../helpers/mock-session');

function createTestProvider(sessionOverrides = {}) {
  const session = createMockSession({ model: 'gemini-2.0-flash', ...sessionOverrides });
  const provider = new GeminiProvider(session, { path: '/nonexistent' });
  return { provider, session };
}

describe('GeminiProvider', () => {
  describe('normalizeEvent', () => {
    let provider;

    beforeEach(() => {
      ({ provider } = createTestProvider());
    });

    it('transforms streaming message to Claude-like format', () => {
      const event = {
        type: 'message',
        role: 'assistant',
        content: 'Hello world',
        delta: true
      };

      const normalized = provider.normalizeEvent(event);
      expect(normalized).toEqual({
        type: 'assistant',
        delta: { type: 'text_delta', text: 'Hello world' }
      });
    });

    it('handles empty content in streaming message', () => {
      const event = { type: 'message', role: 'assistant', delta: true };

      const normalized = provider.normalizeEvent(event);
      expect(normalized.delta.text).toBe('');
    });

    it('passes through non-message events unchanged', () => {
      const event = { type: 'result', stats: { input_tokens: 10 } };
      expect(provider.normalizeEvent(event)).toBe(event);
    });

    it('passes through non-assistant messages unchanged', () => {
      const event = { type: 'message', role: 'user', content: 'hi' };
      expect(provider.normalizeEvent(event)).toBe(event);
    });

    it('passes through non-delta messages unchanged', () => {
      const event = { type: 'message', role: 'assistant', content: 'full message' };
      expect(provider.normalizeEvent(event)).toBe(event);
    });
  });

  describe('handleEvent', () => {
    let provider, session;

    beforeEach(() => {
      ({ provider, session } = createTestProvider());
    });

    it('starts tracking assistant message on first assistant event', () => {
      provider.handleEvent({
        type: 'assistant',
        delta: { type: 'text_delta', text: 'Hello' }
      });

      expect(provider.currentAssistantMessage).not.toBeNull();
      expect(provider.currentAssistantMessage.role).toBe('assistant');
    });

    it('accumulates text deltas', () => {
      provider.handleEvent({ type: 'assistant', delta: { type: 'text_delta', text: 'Hello' } });
      provider.handleEvent({ type: 'assistant', delta: { type: 'text_delta', text: ' world' } });

      const text = provider.currentAssistantMessage.content[0].text;
      expect(text).toBe('Hello world');
    });

    it('captures session ID from init event', () => {
      provider.handleEvent({ type: 'init', session_id: 'gem-session-1' });
      expect(provider.geminiSessionId).toBe('gem-session-1');
    });

    it('tracks stats from result event', () => {
      provider.handleEvent({
        type: 'result',
        stats: { input_tokens: 100, output_tokens: 50 }
      });

      expect(session.stats.inputTokens).toBe(100);
      expect(session.stats.outputTokens).toBe(50);
      expect(session.stats.costUsd).toBeGreaterThan(0);

      const statsMsg = session.ws.getLastMessage('stats_update');
      expect(statsMsg).not.toBeNull();
    });

    it('saves assistant message on result', () => {
      provider.handleEvent({ type: 'assistant', delta: { type: 'text_delta', text: 'response' } });
      provider.handleEvent({ type: 'result' });

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].content[0].text).toBe('response');
      expect(provider.currentAssistantMessage).toBeNull();
      expect(session.saveHistory).toHaveBeenCalled();
    });

    it('sends message_complete on result', () => {
      session.processing = true;
      provider.handleEvent({ type: 'result' });

      expect(session.processing).toBe(false);
      const msg = session.ws.getLastMessage('message_complete');
      expect(msg).not.toBeNull();
    });

    it('forwards events via sendEvent', () => {
      const spy = jest.spyOn(provider, 'sendEvent');
      const event = { type: 'result' };
      provider.handleEvent(event);
      expect(spy).toHaveBeenCalledWith(event);
    });
  });

  describe('handleCommand', () => {
    let provider, session;

    beforeEach(() => {
      ({ provider, session } = createTestProvider());
    });

    it('shows current model with /model and no args', () => {
      const messages = [];
      provider.handleCommand('model', [], msg => messages.push(msg), '/model');

      expect(messages[0]).toMatch(/Current model/);
      expect(messages[0]).toMatch(/gemini-2.0-flash/);
    });

    it('rejects invalid model names', () => {
      const messages = [];
      provider.handleCommand('model', ['bad-model'], msg => messages.push(msg), '/model bad-model');

      expect(messages[0]).toMatch(/Invalid model/);
    });

    it('switches to valid model', () => {
      const messages = [];
      provider.handleCommand('model', ['gemini-2.0-flash-lite'], msg => messages.push(msg), '/model gemini-2.0-flash-lite');

      expect(session.model).toBe('gemini-2.0-flash-lite');
      expect(messages[0]).toMatch(/Model changed/);
    });

    it('returns false for unhandled commands', () => {
      expect(provider.handleCommand('unknown', [], jest.fn(), '/unknown')).toBe(false);
    });
  });

  describe('getModels', () => {
    it('returns array with gemini models', () => {
      const models = GeminiProvider.getModels();
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.group).toBe('Gemini');
        expect(model).toHaveProperty('value');
        expect(model).toHaveProperty('label');
      }
    });
  });
});
