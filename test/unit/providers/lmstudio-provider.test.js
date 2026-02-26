const path = require('path');
const fs = require('fs');
const { MockWebSocket, createMockSession } = require('../../helpers/mock-session');

// Set data dir before requiring provider
const LMStudioProvider = require('../../../providers/lmstudio-provider');
LMStudioProvider.setDataDir(path.join(__dirname, '..', '..', 'fixtures'));

// Create minimal config fixture
const fixturesDir = path.join(__dirname, '..', '..', 'fixtures');
if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
fs.writeFileSync(path.join(fixturesDir, 'lmstudio-config.json'), JSON.stringify({
  baseUrl: 'http://localhost:1234',
  models: [{ id: 'test-model', label: 'Test' }]
}));

describe('LMStudioProvider SSE handling', () => {
  let provider, session, ws;

  beforeEach(() => {
    ws = new MockWebSocket();
    session = createMockSession({ ws, model: 'test-model' });
    provider = new LMStudioProvider(session);
  });

  function getLlmEvents() {
    return ws.sentMessages.filter(m => m.type === 'llm_event').map(m => m.event);
  }

  describe('tool call events', () => {
    test('tool_call.start buffers without emitting events', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(0);
      expect(provider.currentToolCall).toEqual({ name: null, emitted: false });
    });

    test('tool_call.name emits tool_use immediately for progressive UI', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', {
        type: 'tool_call.name',
        tool_name: 'fs_read',
        provider_info: { type: 'plugin', plugin_id: 'mcp/relay' }
      }, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'assistant',
        content_block: { type: 'tool_use', name: 'fs_read', input: {} }
      });
      expect(provider.currentToolCall.name).toBe('fs_read');
      expect(provider.currentToolCall.emitted).toBe(true);
    });

    test('tool_call.arguments emits tool_use_input to update existing block', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', { type: 'tool_call.name', tool_name: 'fs_read' }, '');
      ws.clear();

      provider._handleSSE('tool_call.arguments', {
        type: 'tool_call.arguments',
        tool: 'fs_read',
        arguments: { file_path: 'todo.md' }
      }, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'assistant',
        content_block: {
          type: 'tool_use_input',
          input: { file_path: 'todo.md' }
        }
      });
    });

    test('tool_call.arguments emits tool_use if name event was skipped', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.arguments', {
        arguments: { file_path: 'todo.md' }
      }, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'assistant',
        content_block: {
          type: 'tool_use',
          name: 'unknown_tool',
          input: { file_path: 'todo.md' }
        }
      });
    });

    test('tool_call.success sends tool_result and clears currentToolCall', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', { type: 'tool_call.name', tool_name: 'fs_read' }, '');
      provider._handleSSE('tool_call.arguments', {
        arguments: { file_path: 'todo.md' }
      }, '');
      ws.clear();

      provider._handleSSE('tool_call.success', {}, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'result',
        subtype: 'tool_result',
        tool: 'fs_read'
      });
      expect(provider.currentToolCall).toBeNull();
    });

    test('tool_call.success handles missing arguments event', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', { type: 'tool_call.name', tool_name: 'fs_read' }, '');

      provider._handleSSE('tool_call.success', {}, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(2);
      // tool_use emitted by name, tool_result by success
      expect(events[0]).toEqual({
        type: 'assistant',
        content_block: { type: 'tool_use', name: 'fs_read', input: {} }
      });
      expect(events[1]).toEqual({
        type: 'result',
        subtype: 'tool_result',
        tool: 'fs_read'
      });
    });

    test('tool_call.failure emits tool_use if not yet emitted then error', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', { type: 'tool_call.name', tool_name: 'fs_read' }, '');

      provider._handleSSE('tool_call.failure', { reason: 'File not found' }, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: 'assistant',
        content_block: { type: 'tool_use', name: 'fs_read', input: {} }
      });
      expect(events[1]).toEqual({
        type: 'result',
        subtype: 'error',
        error: 'File not found'
      });
      expect(provider.currentToolCall).toBeNull();
    });

    test('tool_call.failure after arguments does not double-emit tool_use', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', { type: 'tool_call.name', tool_name: 'fs_read' }, '');
      provider._handleSSE('tool_call.arguments', {
        arguments: { file_path: 'todo.md' }
      }, '');
      ws.clear();

      provider._handleSSE('tool_call.failure', { reason: 'File not found' }, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'result',
        subtype: 'error',
        error: 'File not found'
      });
    });

    test('full tool call sequence produces correct event order', () => {
      provider._handleSSE('tool_call.start', { type: 'tool_call.start' }, '');
      provider._handleSSE('tool_call.name', {
        type: 'tool_call.name',
        tool_name: 'fs_read',
        provider_info: { type: 'plugin', plugin_id: 'mcp/relay' }
      }, '');
      provider._handleSSE('tool_call.arguments', {
        type: 'tool_call.arguments',
        tool: 'fs_read',
        arguments: { file_path: 'todo.md' }
      }, '');
      provider._handleSSE('tool_call.success', {}, '');

      const events = getLlmEvents();
      expect(events).toHaveLength(3);
      expect(events[0].content_block.type).toBe('tool_use');
      expect(events[0].content_block.name).toBe('fs_read');
      expect(events[0].content_block.input).toEqual({});
      expect(events[1].content_block.type).toBe('tool_use_input');
      expect(events[1].content_block.input).toEqual({ file_path: 'todo.md' });
      expect(events[2].subtype).toBe('tool_result');
    });
  });

  describe('chat.end event handling', () => {
    test('extracts response_id from nested data.result (documented format)', () => {
      provider._handleSSE('chat.end', {
        type: 'chat.end',
        result: {
          response_id: 'resp_abc123',
          stats: { input_tokens: 100, total_output_tokens: 50 }
        }
      }, '');

      expect(provider.responseId).toBe('resp_abc123');
    });

    test('extracts stats from nested data.result', () => {
      provider._handleSSE('chat.end', {
        type: 'chat.end',
        result: {
          response_id: 'resp_abc123',
          stats: { input_tokens: 100, total_output_tokens: 50 }
        }
      }, '');

      expect(session.stats.inputTokens).toBe(100);
      expect(session.stats.outputTokens).toBe(50);

      const statsMsg = ws.sentMessages.find(m => m.type === 'stats_update');
      expect(statsMsg).toBeDefined();
      expect(statsMsg.stats.inputTokens).toBe(100);
      expect(statsMsg.stats.outputTokens).toBe(50);
    });

    test('handles flat format for backward compatibility', () => {
      provider._handleSSE('chat.end', {
        type: 'chat.end',
        response_id: 'resp_flat456',
        stats: { input_tokens: 200, total_output_tokens: 75 }
      }, '');

      expect(provider.responseId).toBe('resp_flat456');
      expect(session.stats.inputTokens).toBe(200);
      expect(session.stats.outputTokens).toBe(75);
    });
  });

  describe('ignored events', () => {
    test.each([
      'message.start',
      'message.end'
    ])('%s is silently ignored', (eventType) => {
      provider._handleSSE(eventType, {}, '');
      expect(getLlmEvents()).toHaveLength(0);
    });
  });

  describe('model loading and prompt processing status', () => {
    test('model_load.start sends status event', () => {
      provider._handleSSE('model_load.start', { model: 'qwen2.5-7b' }, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Loading model qwen2.5-7b...' });
    });

    test('model_load.progress sends percentage', () => {
      provider._handleSSE('model_load.progress', { progress: 0.45 }, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Loading model... 45%' });
    });

    test('model_load.end transitions to prompt processing', () => {
      provider._handleSSE('model_load.end', {}, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Processing prompt...' });
    });

    test('prompt_processing.start sends status event', () => {
      provider._handleSSE('prompt_processing.start', {}, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Processing prompt...' });
    });

    test('prompt_processing.progress sends percentage when under 100%', () => {
      provider._handleSSE('prompt_processing.progress', { progress: 0.7 }, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Processing prompt... 70%' });
    });

    test('prompt_processing.progress at 100% transitions to generating status', () => {
      provider._handleSSE('prompt_processing.progress', { progress: 1.0 }, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Generating response...' });
    });

    test('prompt_processing.end transitions to generating status', () => {
      provider._handleSSE('prompt_processing.end', {}, '');
      const events = getLlmEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'system', subtype: 'status', message: 'Generating response...' });
    });
  });
});
