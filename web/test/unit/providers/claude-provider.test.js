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
