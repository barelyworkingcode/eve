const ClaudeProvider = require('../../../providers/claude-provider');
const { createMockSession } = require('../../helpers/mock-session');

// Create a provider instance for testing instance methods without spawning a process
function createTestProvider(sessionOverrides = {}) {
  const session = createMockSession(sessionOverrides);
  // Pass a dummy config to avoid spawning
  const provider = new ClaudeProvider(session, { path: '/nonexistent' });
  return { provider, session };
}

describe('ClaudeProvider', () => {
  describe('parseQuotedArgs', () => {
    let provider;

    beforeEach(() => {
      ({ provider } = createTestProvider());
    });

    it('splits simple whitespace-separated args', () => {
      expect(provider.parseQuotedArgs('--flag value')).toEqual(['--flag', 'value']);
    });

    it('handles double-quoted strings', () => {
      expect(provider.parseQuotedArgs('--system-prompt "Be concise"')).toEqual(['--system-prompt', 'Be concise']);
    });

    it('handles single-quoted strings', () => {
      expect(provider.parseQuotedArgs("--system-prompt 'Be concise'")).toEqual(['--system-prompt', 'Be concise']);
    });

    it('handles mixed quotes', () => {
      expect(provider.parseQuotedArgs(`--a "hello world" --b 'foo bar'`)).toEqual([
        '--a', 'hello world', '--b', 'foo bar'
      ]);
    });

    it('handles empty string', () => {
      expect(provider.parseQuotedArgs('')).toEqual([]);
    });

    it('handles extra whitespace', () => {
      expect(provider.parseQuotedArgs('  --flag   value  ')).toEqual(['--flag', 'value']);
    });

    it('handles quoted string with spaces inside', () => {
      expect(provider.parseQuotedArgs('--prompt "hello   world"')).toEqual(['--prompt', 'hello   world']);
    });

    it('handles single arg with no value', () => {
      expect(provider.parseQuotedArgs('--dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions']);
    });
  });

  describe('removeCustomArg', () => {
    let provider;

    beforeEach(() => {
      ({ provider } = createTestProvider());
    });

    it('removes a flag without value', () => {
      provider.customArgs = ['--dangerously-skip-permissions', '--other'];
      const result = provider.removeCustomArg('--dangerously-skip-permissions');
      expect(result).toBe(true);
      expect(provider.customArgs).toEqual(['--other']);
    });

    it('removes a flag with its value', () => {
      provider.customArgs = ['--max-turns', '5', '--other'];
      const result = provider.removeCustomArg('--max-turns');
      expect(result).toBe(true);
      expect(provider.customArgs).toEqual(['--other']);
    });

    it('removes a flag with multiple values', () => {
      provider.customArgs = ['--system-prompt', 'Be', 'concise', '--other'];
      const result = provider.removeCustomArg('--system-prompt');
      expect(result).toBe(true);
      expect(provider.customArgs).toEqual(['--other']);
    });

    it('returns false when flag not found', () => {
      provider.customArgs = ['--flag', 'value'];
      const result = provider.removeCustomArg('--nonexistent');
      expect(result).toBe(false);
      expect(provider.customArgs).toEqual(['--flag', 'value']);
    });

    it('handles removing last flag', () => {
      provider.customArgs = ['--only-flag'];
      const result = provider.removeCustomArg('--only-flag');
      expect(result).toBe(true);
      expect(provider.customArgs).toEqual([]);
    });

    it('removes flag at end of array with values', () => {
      provider.customArgs = ['--first', '--last', 'val1', 'val2'];
      const result = provider.removeCustomArg('--last');
      expect(result).toBe(true);
      expect(provider.customArgs).toEqual(['--first']);
    });
  });

  describe('formatArgsForDisplay', () => {
    let provider;

    beforeEach(() => {
      ({ provider } = createTestProvider());
    });

    it('formats single flag', () => {
      expect(provider.formatArgsForDisplay(['--flag'])).toBe('--flag');
    });

    it('formats flag with value', () => {
      expect(provider.formatArgsForDisplay(['--max-turns', '5'])).toBe('--max-turns 5');
    });

    it('formats multiple flags', () => {
      const result = provider.formatArgsForDisplay(['--flag1', '--flag2', 'val']);
      expect(result).toBe('--flag1\n--flag2 val');
    });

    it('formats flag with multiple values', () => {
      const result = provider.formatArgsForDisplay(['--system-prompt', 'Be', 'concise']);
      expect(result).toBe('--system-prompt Be concise');
    });

    it('handles empty array', () => {
      expect(provider.formatArgsForDisplay([])).toBe('');
    });
  });

  describe('validateFiles', () => {
    let provider;

    beforeEach(() => {
      ({ provider } = createTestProvider());
    });

    it('returns valid for empty files', () => {
      expect(provider.validateFiles([])).toEqual({ valid: true, files: [] });
    });

    it('returns valid for null files', () => {
      expect(provider.validateFiles(null)).toEqual({ valid: true, files: null });
    });

    it('accepts valid text files', () => {
      const files = [{ name: 'test.js', content: 'console.log("hi")', type: 'text' }];
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(true);
      expect(result.files).toHaveLength(1);
    });

    it('accepts valid image files', () => {
      const base64 = Buffer.from('fake-image-data').toString('base64');
      const files = [{
        name: 'test.png',
        content: `data:image/png;base64,${base64}`,
        type: 'image'
      }];
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(true);
      expect(result.files).toHaveLength(1);
    });

    it('rejects unsupported image types', () => {
      const base64 = Buffer.from('fake-image-data').toString('base64');
      const files = [{
        name: 'test.bmp',
        content: `data:image/bmp;base64,${base64}`,
        type: 'image'
      }];
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Unsupported image type/);
    });

    it('rejects invalid base64 data URL format', () => {
      const files = [{
        name: 'test.png',
        content: 'data:not-valid-format',
        type: 'image'
      }];
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Invalid image format/);
    });

    it('rejects files exceeding individual size limit', () => {
      const largeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB
      const files = [{ name: 'big.txt', content: largeContent, type: 'text' }];
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/too large/);
    });

    it('rejects files exceeding total size limit', () => {
      // Create multiple files that individually pass but together exceed 50MB
      const files = [];
      for (let i = 0; i < 6; i++) {
        files.push({
          name: `file${i}.txt`,
          content: 'x'.repeat(9 * 1024 * 1024), // 9MB each, 54MB total
          type: 'text'
        });
      }
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Total attachment size/);
    });

    it('filters out invalid files but keeps valid ones', () => {
      const base64 = Buffer.from('fake').toString('base64');
      const files = [
        { name: 'good.txt', content: 'hello', type: 'text' },
        { name: 'bad.bmp', content: `data:image/bmp;base64,${base64}`, type: 'image' }
      ];
      const result = provider.validateFiles(files);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('getModels', () => {
    it('returns array of model objects', () => {
      const models = ClaudeProvider.getModels();
      expect(models).toBeInstanceOf(Array);
      expect(models.length).toBeGreaterThan(0);
    });

    it('each model has value, label, and group', () => {
      for (const model of ClaudeProvider.getModels()) {
        expect(model).toHaveProperty('value');
        expect(model).toHaveProperty('label');
        expect(model).toHaveProperty('group', 'Claude');
      }
    });

    it('includes haiku, sonnet, and opus', () => {
      const values = ClaudeProvider.getModels().map(m => m.value);
      expect(values).toContain('haiku');
      expect(values).toContain('sonnet');
      expect(values).toContain('opus');
    });
  });

  describe('handleEvent', () => {
    let provider, session;

    beforeEach(() => {
      ({ provider, session } = createTestProvider());
    });

    it('captures session ID from system init event', () => {
      provider.handleEvent({ type: 'system', subtype: 'init', session_id: 'sess-abc' });

      expect(provider.claudeSessionId).toBe('sess-abc');
      expect(session.saveHistory).toHaveBeenCalled();
    });

    it('ignores system events without init subtype', () => {
      provider.handleEvent({ type: 'system', subtype: 'other' });
      expect(provider.claudeSessionId).toBeNull();
    });

    it('starts tracking assistant message on assistant event with message', () => {
      provider.handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] }
      });

      expect(provider.currentAssistantMessage).not.toBeNull();
      expect(provider.currentAssistantMessage.role).toBe('assistant');
      expect(provider.currentAssistantMessage.content).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('accumulates text deltas into current assistant message', () => {
      // Start a message
      provider.handleEvent({
        type: 'assistant',
        message: { content: [] }
      });

      // Send text deltas
      provider.handleEvent({ type: 'assistant', delta: { type: 'text_delta', text: 'Hello' } });
      provider.handleEvent({ type: 'assistant', delta: { type: 'text_delta', text: ' world' } });

      const textBlock = provider.currentAssistantMessage.content.find(b => b.type === 'text');
      expect(textBlock.text).toBe('Hello world');
    });

    it('adds tool use blocks from deltas', () => {
      provider.handleEvent({
        type: 'assistant',
        message: { content: [] }
      });

      const toolUse = { type: 'tool_use', name: 'read_file', input: { path: '/tmp' } };
      provider.handleEvent({ type: 'assistant', delta: toolUse });

      expect(provider.currentAssistantMessage.content).toContainEqual(toolUse);
    });

    it('ignores deltas when no current assistant message', () => {
      // No crash when delta arrives without a prior message event
      expect(() => {
        provider.handleEvent({ type: 'assistant', delta: { type: 'text_delta', text: 'stray' } });
      }).not.toThrow();
    });

    it('updates stats from result event with usage', () => {
      provider.handleEvent({
        type: 'result',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5
        },
        total_cost_usd: 0.003
      });

      expect(session.stats.inputTokens).toBe(100);
      expect(session.stats.outputTokens).toBe(50);
      expect(session.stats.cacheReadTokens).toBe(10);
      expect(session.stats.cacheCreationTokens).toBe(5);
      expect(session.stats.costUsd).toBe(0.003);

      const statsMsg = session.ws.getLastMessage('stats_update');
      expect(statsMsg).not.toBeNull();
      expect(statsMsg.stats.inputTokens).toBe(100);
    });

    it('accumulates stats across multiple result events', () => {
      provider.handleEvent({
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 }
      });
      provider.handleEvent({
        type: 'result',
        usage: { input_tokens: 200, output_tokens: 75 }
      });

      expect(session.stats.inputTokens).toBe(300);
      expect(session.stats.outputTokens).toBe(125);
    });

    it('saves assistant message to history on result', () => {
      provider.handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response' }] }
      });
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

    it('sends system_message for result with direct text and no assistant message', () => {
      provider.handleEvent({ type: 'result', result: 'Invalid command' });

      const msg = session.ws.getLastMessage('system_message');
      expect(msg).not.toBeNull();
      expect(msg.message).toBe('Invalid command');
    });

    it('does not send system_message for result when assistant message exists', () => {
      provider.handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'real response' }] }
      });
      provider.handleEvent({ type: 'result', result: 'some text' });

      const sysMsgs = session.ws.getMessages('system_message');
      expect(sysMsgs).toHaveLength(0);
    });

    it('handles user event with local-command-stdout', () => {
      session.processing = true;

      provider.handleEvent({
        type: 'user',
        message: {
          content: 'prefix<local-command-stdout>command output here</local-command-stdout>suffix'
        }
      });

      const sysMsg = session.ws.getLastMessage('system_message');
      expect(sysMsg.message).toBe('command output here');
      expect(session.processing).toBe(false);

      const completeMsg = session.ws.getLastMessage('message_complete');
      expect(completeMsg).not.toBeNull();
    });

    it('handles user event with array content (tool_result) without crashing', () => {
      const spy = jest.spyOn(provider, 'sendEvent');

      const event = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'result text' }
          ]
        }
      };

      expect(() => provider.handleEvent(event)).not.toThrow();
      // Should still forward the event via sendEvent
      expect(spy).toHaveBeenCalledWith(event);
      // Should not send system_message (no local-command-stdout match)
      const sysMsg = session.ws.getLastMessage('system_message');
      expect(sysMsg).toBeNull();
    });

    it('forwards all events via sendEvent', () => {
      const spy = jest.spyOn(provider, 'sendEvent');
      const event = { type: 'result' };

      provider.handleEvent(event);
      expect(spy).toHaveBeenCalledWith(event);
    });
  });

  describe('processLine', () => {
    let provider, session;

    beforeEach(() => {
      ({ provider, session } = createTestProvider());
    });

    it('sends raw_output for non-JSON lines', () => {
      provider.processLine('not valid json');

      const msg = session.ws.getLastMessage('raw_output');
      expect(msg).not.toBeNull();
      expect(msg.text).toBe('not valid json');
    });

    it('does not send raw_output when handleEvent throws', () => {
      jest.spyOn(provider, 'handleEvent').mockImplementation(() => {
        throw new Error('simulated crash');
      });

      const validJson = JSON.stringify({ type: 'assistant', message: { content: [] } });
      provider.processLine(validJson);

      const rawMsgs = session.ws.getMessages('raw_output');
      expect(rawMsgs).toHaveLength(0);
    });

    it('logs error to console when handleEvent throws', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(provider, 'handleEvent').mockImplementation(() => {
        throw new Error('simulated crash');
      });

      const validJson = JSON.stringify({ type: 'user', message: { content: [] } });
      provider.processLine(validJson);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Claude] handleEvent error:',
        'simulated crash',
        'event type:',
        'user'
      );
      consoleSpy.mockRestore();
    });
  });

  describe('handleCommand', () => {
    let provider, session;

    beforeEach(() => {
      ({ provider, session } = createTestProvider());
    });

    it('shows current model with /model and no args', () => {
      const messages = [];
      const send = (msg) => messages.push(msg);

      provider.handleCommand('model', [], send, '/model');

      expect(messages[0]).toMatch(/Current model/);
      expect(messages[0]).toMatch(/haiku/);
    });

    it('rejects invalid model names', () => {
      const messages = [];
      const send = (msg) => messages.push(msg);

      provider.handleCommand('model', ['invalid-model'], send, '/model invalid-model');

      expect(messages[0]).toMatch(/Invalid model/);
    });

    it('shows transfer error when no session ID', () => {
      const messages = [];
      const send = (msg) => messages.push(msg);

      provider.handleCommand('transfer-cli', [], send, '/transfer-cli');

      expect(messages[0]).toMatch(/No active Claude session/);
    });

    it('returns transfer object when session ID exists', () => {
      provider.claudeSessionId = 'sess-123';
      provider.customArgs = ['--flag'];

      const result = provider.handleCommand('transfer-cli', [], jest.fn(), '/transfer-cli');

      expect(result.transfer.claudeSessionId).toBe('sess-123');
      expect(result.transfer.customArgs).toEqual(['--flag']);
    });

    it('returns false for unhandled commands', () => {
      const result = provider.handleCommand('compact', [], jest.fn(), '/compact');
      expect(result).toBe(false);
    });
  });

  describe('session state round-trip', () => {
    it('persists and restores claudeSessionId', () => {
      const { provider } = createTestProvider();
      provider.claudeSessionId = 'abc-123';
      provider.customArgs = ['--max-turns', '5'];

      const state = provider.getSessionState();
      expect(state.claudeSessionId).toBe('abc-123');
      expect(state.customArgs).toEqual(['--max-turns', '5']);

      // Create a new provider and restore state
      const { provider: provider2 } = createTestProvider({ providerState: state });
      expect(provider2.claudeSessionId).toBe('abc-123');
      expect(provider2.customArgs).toEqual(['--max-turns', '5']);
    });

    it('handles null state gracefully', () => {
      const { provider } = createTestProvider({ providerState: null });
      expect(provider.claudeSessionId).toBeNull();
      expect(provider.customArgs).toEqual([]);
    });

    it('handles empty customArgs', () => {
      const { provider } = createTestProvider();
      const state = provider.getSessionState();
      expect(state.customArgs).toEqual([]);
    });
  });
});
