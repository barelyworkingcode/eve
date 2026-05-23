const SearchSummarizer = require('../../search-summarizer');
const { HIDDEN_SEARCH_PREFIX, MAX_SUMMARY_MATCHES, MAX_SNIPPET_LEN, _buildPrompt } = SearchSummarizer;

describe('SearchSummarizer prompt construction', () => {
  it('caps matches at MAX_SUMMARY_MATCHES and reports the original total', () => {
    const matches = Array.from({ length: MAX_SUMMARY_MATCHES + 25 }, (_, i) => ({
      file: `src/file${i}.js`,
      lineNumber: i + 1,
      lineText: `match line ${i}`,
    }));
    const prompt = _buildPrompt('foo', matches, 'demo');

    expect(prompt).toMatch(/Total matches: 75/);
    expect(prompt).toMatch(/showing first 50/);
    // Count rendered match lines (each starts with "  src/file")
    const rendered = (prompt.match(/^  src\/file/gm) || []).length;
    expect(rendered).toBe(MAX_SUMMARY_MATCHES);
  });

  it('clamps long snippets at MAX_SNIPPET_LEN chars', () => {
    const long = 'x'.repeat(MAX_SNIPPET_LEN + 200);
    const prompt = _buildPrompt('q', [{ file: 'a.js', lineNumber: 1, lineText: long }], 'p');

    const lineRegex = /^  a\.js:1  (.+)$/m;
    const match = prompt.match(lineRegex);
    expect(match).not.toBeNull();
    // Snippet must be at most MAX_SNIPPET_LEN chars + the ellipsis we add.
    expect(match[1].length).toBeLessThanOrEqual(MAX_SNIPPET_LEN + 1);
    expect(match[1].endsWith('…')).toBe(true);
  });

  it('includes the search query and project name', () => {
    const prompt = _buildPrompt('searchProject', [], 'eve');
    expect(prompt).toContain('Project: eve');
    expect(prompt).toContain('Search query: "searchProject"');
    expect(prompt).toMatch(/Total matches: 0/);
  });

  it('survives missing/garbage match fields without crashing', () => {
    const prompt = _buildPrompt('q', [
      { file: undefined, lineNumber: null, lineText: undefined },
      null,
      { file: 'ok.js', lineNumber: 7, lineText: 'snippet' },
    ], 'p');
    expect(prompt).toContain('ok.js:7');
    expect(prompt).not.toMatch(/undefined/);
  });
});

/**
 * Wait until registerModuleSession has been called at least once. The
 * SearchSummarizer awaits an async POST before registering the handler, so
 * a bare `await Promise.resolve()` isn't enough — we need to let the
 * microtask chain unwind.
 */
async function waitForHandler(relayClient, timeoutMs = 200) {
  const t0 = Date.now();
  while (relayClient.registerModuleSession.mock.calls.length === 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error('Timed out waiting for handler registration');
    await new Promise(r => setImmediate(r));
  }
}

describe('SearchSummarizer.run', () => {
  function makeMocks({ createStatus = 200, createData = { sessionId: 'sess-abc' } } = {}) {
    const transportCalls = [];
    const relayTransport = {
      fetch: jest.fn().mockImplementation((method, path, body) => {
        transportCalls.push({ method, path, body });
        if (method === 'POST' && path === '/api/sessions') {
          return Promise.resolve({ status: createStatus, data: createData });
        }
        if (method === 'DELETE') {
          return Promise.resolve({ status: 200, data: {} });
        }
        return Promise.resolve({ status: 200, data: {} });
      }),
    };
    const browserWs = { readyState: 1, send: jest.fn() };
    const relayClient = {
      browserWs,
      sendToBrowser: jest.fn((p) => browserWs.send(JSON.stringify(p))),
      registerModuleSession: jest.fn(),
      unregisterModuleSession: jest.fn(),
      joinSession: jest.fn(),
      sendMessage: jest.fn(),
      stopGeneration: jest.fn(),
    };
    const resolveProject = jest.fn(() => ({
      id: 'p1', name: 'demo', path: '/projects/demo', allowedModels: ['model-x'],
    }));
    return { relayTransport, relayClient, browserWs, resolveProject, transportCalls };
  }

  it('rejects when projectId is unknown', async () => {
    const { relayTransport, relayClient, browserWs } = makeMocks();
    const svc = new SearchSummarizer({
      relayTransport, resolveProject: () => null, log: null,
    });
    await expect(svc.run({
      requestId: 'r1', projectId: 'bad', query: 'foo', matches: [],
      relayClient, browserWs,
    })).rejects.toThrow('Project not found');
  });

  it('creates a hidden session, joins, sends message, and cleans up on success', async () => {
    const { relayTransport, relayClient, browserWs, resolveProject } = makeMocks();
    const svc = new SearchSummarizer({ relayTransport, resolveProject, log: null });

    const run = svc.run({
      requestId: 'r1', projectId: 'p1', query: 'foo',
      matches: [{ file: 'a.js', lineNumber: 1, lineText: 'foo bar' }],
      model: 'model-x', relayClient, browserWs,
    });

    await waitForHandler(relayClient);

    // POST /api/sessions was called with the search prefix and no mcpToken.
    const createCall = relayTransport.fetch.mock.calls.find(c => c[0] === 'POST' && c[1] === '/api/sessions');
    expect(createCall).toBeDefined();
    const body = createCall[2];
    expect(body.name.startsWith(HIDDEN_SEARCH_PREFIX)).toBe(true);
    expect(body.mcpToken).toBe('');
    expect(body.settings).toBeNull();
    expect(body.model).toBe('model-x');

    // Handler was registered against the new sessionId.
    expect(relayClient.registerModuleSession).toHaveBeenCalledWith('sess-abc', expect.any(Function));
    const handler = relayClient.registerModuleSession.mock.calls[0][1];

    // join_session + send_message dispatched.
    expect(relayClient.joinSession).toHaveBeenCalledWith('sess-abc');
    expect(relayClient.sendMessage).toHaveBeenCalledWith(expect.stringContaining('"foo"'), [], 'sess-abc');

    // Simulate message_complete from relay.
    handler({ type: 'message_complete', sessionId: 'sess-abc' });

    await run;

    // Cleanup: unregister + DELETE.
    expect(relayClient.unregisterModuleSession).toHaveBeenCalledWith('sess-abc');
    const deleteCall = relayTransport.fetch.mock.calls.find(c => c[0] === 'DELETE');
    expect(deleteCall[1]).toBe('/api/sessions/sess-abc');

    // Frames sent to the browser include started + completed.
    const sentTypes = relayClient.sendToBrowser.mock.calls.map(c => c[0].type);
    expect(sentTypes).toContain('search_ai_started');
    expect(sentTypes).toContain('search_ai_completed');
  });

  it('reports search_ai_failed when message_complete carries an error', async () => {
    const { relayTransport, relayClient, browserWs, resolveProject } = makeMocks();
    const svc = new SearchSummarizer({ relayTransport, resolveProject, log: null });

    const run = svc.run({
      requestId: 'r2', projectId: 'p1', query: 'foo', matches: [],
      relayClient, browserWs,
    });
    await waitForHandler(relayClient);
    const handler = relayClient.registerModuleSession.mock.calls[0][1];
    handler({ type: 'message_complete', sessionId: 'sess-abc', error: 'boom' });

    await expect(run).rejects.toThrow('boom');

    const sentTypes = relayClient.sendToBrowser.mock.calls.map(c => c[0].type);
    expect(sentTypes).toContain('search_ai_failed');
    // Session must still be deleted in the finally block.
    const deleteCall = relayTransport.fetch.mock.calls.find(c => c[0] === 'DELETE');
    expect(deleteCall).toBeDefined();
  });

  it('stop() calls relayClient.stopGeneration for the active session', async () => {
    const { relayTransport, relayClient, browserWs, resolveProject } = makeMocks();
    const svc = new SearchSummarizer({ relayTransport, resolveProject, log: null });

    const run = svc.run({
      requestId: 'r3', projectId: 'p1', query: 'foo', matches: [],
      relayClient, browserWs,
    });
    await waitForHandler(relayClient);

    const ok = svc.stop('r3');
    expect(ok).toBe(true);
    expect(relayClient.stopGeneration).toHaveBeenCalledWith('sess-abc');

    // Stop doesn't resolve on its own — settle the run promise so jest exits cleanly.
    const handler = relayClient.registerModuleSession.mock.calls[0][1];
    handler({ type: 'message_complete', sessionId: 'sess-abc' });
    await run;
  });
});
