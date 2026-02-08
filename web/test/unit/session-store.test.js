const os = require('os');
const fs = require('fs');
const path = require('path');
const SessionStore = require('../../session-store');

describe('SessionStore', () => {
  let store;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-test-'));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSession(overrides = {}) {
    return {
      sessionId: 'sess-1',
      projectId: null,
      directory: '/home/user/project',
      model: 'haiku',
      createdAt: '2025-01-01T00:00:00.000Z',
      messages: [],
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0
      },
      providerState: null,
      ...overrides
    };
  }

  describe('save and load round-trip', () => {
    it('saves and loads a session', () => {
      const session = makeSession();
      store.save(session);

      const loaded = store.load('sess-1');
      expect(loaded).not.toBeNull();
      expect(loaded.sessionId).toBe('sess-1');
      expect(loaded.model).toBe('haiku');
      expect(loaded.directory).toBe('/home/user/project');
    });

    it('preserves messages and stats', () => {
      const session = makeSession({
        messages: [{ role: 'user', content: 'hello' }],
        stats: { inputTokens: 50, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 }
      });
      store.save(session);

      const loaded = store.load('sess-1');
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0].content).toBe('hello');
      expect(loaded.stats.inputTokens).toBe(50);
      expect(loaded.stats.costUsd).toBe(0.01);
    });

    it('preserves name field', () => {
      const session = makeSession({ name: 'My Custom Name' });
      store.save(session);

      const loaded = store.load('sess-1');
      expect(loaded.name).toBe('My Custom Name');
    });

    it('saves null name when not set', () => {
      const session = makeSession();
      store.save(session);

      const loaded = store.load('sess-1');
      expect(loaded.name).toBeNull();
    });

    it('includes name in loadAll results', () => {
      store.save(makeSession({ sessionId: 'sess-1', name: 'Named' }));
      store.save(makeSession({ sessionId: 'sess-2' }));

      const all = store.loadAll();
      const named = all.find(s => s.sessionId === 'sess-1');
      const unnamed = all.find(s => s.sessionId === 'sess-2');
      expect(named.name).toBe('Named');
      expect(unnamed.name).toBeNull();
    });

    it('preserves providerState', () => {
      const session = makeSession({
        providerState: { claudeSessionId: 'abc', customArgs: ['--flag'] }
      });
      store.save(session);

      const loaded = store.load('sess-1');
      expect(loaded.providerState.claudeSessionId).toBe('abc');
      expect(loaded.providerState.customArgs).toEqual(['--flag']);
    });
  });

  describe('load', () => {
    it('returns null for nonexistent session', () => {
      expect(store.load('nonexistent')).toBeNull();
    });

    it('returns null for corrupt JSON file', () => {
      const filePath = path.join(tmpDir, 'sessions', 'corrupt.json');
      fs.writeFileSync(filePath, '{invalid json!!!', 'utf8');

      expect(store.load('corrupt')).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes a saved session', () => {
      const session = makeSession();
      store.save(session);
      expect(store.load('sess-1')).not.toBeNull();

      store.delete('sess-1');
      expect(store.load('sess-1')).toBeNull();
    });

    it('does not throw when deleting nonexistent session', () => {
      expect(() => store.delete('nonexistent')).not.toThrow();
    });
  });

  describe('loadAll', () => {
    it('returns all saved sessions', () => {
      store.save(makeSession({ sessionId: 'sess-1' }));
      store.save(makeSession({ sessionId: 'sess-2', model: 'sonnet' }));

      const all = store.loadAll();
      expect(all).toHaveLength(2);

      const ids = all.map(s => s.sessionId).sort();
      expect(ids).toEqual(['sess-1', 'sess-2']);
    });

    it('returns empty array when no sessions', () => {
      expect(store.loadAll()).toEqual([]);
    });

    it('skips corrupt JSON files gracefully', () => {
      store.save(makeSession({ sessionId: 'good' }));
      // Write a corrupt file
      const corruptPath = path.join(tmpDir, 'sessions', 'bad.json');
      fs.writeFileSync(corruptPath, 'not json', 'utf8');

      const all = store.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].sessionId).toBe('good');
    });
  });
});
