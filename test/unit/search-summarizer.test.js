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
    const rendered = (prompt.match(/^  src\/file/gm) || []).length;
    expect(rendered).toBe(MAX_SUMMARY_MATCHES);
  });

  it('clamps long snippets at MAX_SNIPPET_LEN chars', () => {
    const long = 'x'.repeat(MAX_SNIPPET_LEN + 200);
    const prompt = _buildPrompt('q', [{ file: 'a.js', lineNumber: 1, lineText: long }], 'p');

    const lineRegex = /^  a\.js:1  (.+)$/m;
    const match = prompt.match(lineRegex);
    expect(match).not.toBeNull();
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

// SearchSummarizer awaits an async POST before registering the handler, so a
// bare `await Promise.resolve()` isn't enough to observe it — poll instead.
async function waitForHandler(relayClient, timeoutMs = 200) {
  const t0 = Date.now();
  while (relayClient.registerHiddenSession.mock.calls.length === 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error('Timed out waiting for handler registration');
    await new Promise(r => setImmediate(r));
  }
}

describe('SearchSummarizer.run', () => {
  // `models` answers GET /api/models: a `{status, data}` reply, or an Error to throw.
  function makeMocks({
    createStatus = 200, createData = { sessionId: 'sess-abc' },
    allowedModels = ['model-x'], models = null,
  } = {}) {
    const transportCalls = [];
    const relayTransport = {
      fetch: jest.fn().mockImplementation((method, path, body) => {
        transportCalls.push({ method, path, body });
        if (method === 'POST' && path === '/api/sessions') {
          return Promise.resolve({ status: createStatus, data: createData });
        }
        if (method === 'GET' && path === '/api/models' && models) {
          return models instanceof Error ? Promise.reject(models) : Promise.resolve(models);
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
      registerHiddenSession: jest.fn(),
      unregisterHiddenSession: jest.fn(),
      joinSession: jest.fn(),
      sendMessage: jest.fn(),
      stopGeneration: jest.fn(),
    };
    const resolveProject = jest.fn(() => ({
      id: 'p1', name: 'demo', path: '/projects/demo', allowedModels,
    }));
    return { relayTransport, relayClient, browserWs, resolveProject, transportCalls };
  }

  const browserFrames = (browserWs) => browserWs.send.mock.calls.map(c => JSON.parse(c[0]));
  const sessionCreates = (relayTransport) => relayTransport.fetch.mock.calls
    .filter(c => c[0] === 'POST' && c[1] === '/api/sessions');
  const discovered = { status: 200, data: { models: [{ value: 'disc-1' }] } };

  it.each([
    ['skips a "*" allowlist entry and uses the discovered model', '', ['*'], 'disc-1'],
    ['uses the discovered model when the allowlist is empty', '', [], 'disc-1'],
    ['treats a whitespace model as blank and uses the allowlist', '   ', ['allowed-1'], 'allowed-1'],
  ])('%s', async (_name, model, allowedModels, expected) => {
    const { relayTransport, relayClient, browserWs, resolveProject } =
      makeMocks({ allowedModels, models: discovered });
    const svc = new SearchSummarizer({ relayTransport, resolveProject, log: null });

    const run = svc.run({
      requestId: 'r5', projectId: 'p1', query: 'foo', matches: [], model, relayClient, browserWs,
    });
    await waitForHandler(relayClient);
    relayClient.registerHiddenSession.mock.calls[0][1]({ type: 'message_complete', sessionId: 'sess-abc' });
    await run;

    const creates = sessionCreates(relayTransport);
    expect(creates).toHaveLength(1);
    expect(creates[0][2].model).toBe(expected);
    const started = browserFrames(browserWs).find(f => f.type === 'search_ai_started');
    expect(started.model).toBe(expected);
  });

  it.each([
    ['/api/models lists nothing', { status: 200, data: {} }],
    ['/api/models answers non-2xx', { status: 502, data: { models: [{ value: 'disc-1' }] } }],
    ['/api/models throws', new Error('relay down')],
  ])('fails with "No model available" and creates no session when %s', async (_name, models) => {
    const { relayTransport, relayClient, browserWs, resolveProject } =
      makeMocks({ allowedModels: [], models });
    const svc = new SearchSummarizer({ relayTransport, resolveProject, log: null });

    const run = svc.run({
      requestId: 'r6', projectId: 'p1', query: 'foo', matches: [], model: '', relayClient, browserWs,
    });
    const outcome = await Promise.race([
      run.then(() => 'resolved', err => err),
      waitForHandler(relayClient).then(() => 'session created', () => 'no session'),
    ]);
    // Settle before asserting so a failed expectation can't leave the run's timer alive.
    if (relayClient.registerHiddenSession.mock.calls.length > 0) {
      relayClient.registerHiddenSession.mock.calls[0][1]({ type: 'message_complete', sessionId: 'sess-abc' });
      await run.catch(() => {});
    }

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toBe('No model available');
    expect(sessionCreates(relayTransport)).toHaveLength(0);
    const failed = browserFrames(browserWs).filter(f => f.type === 'search_ai_failed');
    expect(failed).toEqual([
      { type: 'search_ai_failed', requestId: 'r6', sessionId: null, error: 'No model available' },
    ]);
  });

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

    // No mcpToken: eve never sends a project token, relay brokers it.
    const createCall = relayTransport.fetch.mock.calls.find(c => c[0] === 'POST' && c[1] === '/api/sessions');
    expect(createCall).toBeDefined();
    const body = createCall[2];
    expect(body.name.startsWith(HIDDEN_SEARCH_PREFIX)).toBe(true);
    expect(body).not.toHaveProperty('mcpToken');
    // Hidden sessions get neither chat default: no relay tools, no CLAUDE.md.
    expect(body.settings).toBeNull();
    expect(body.appendClaudeMd).toBe(false);
    expect(body.model).toBe('model-x');

    expect(relayClient.registerHiddenSession).toHaveBeenCalledWith('sess-abc', expect.any(Function));
    const handler = relayClient.registerHiddenSession.mock.calls[0][1];

    expect(relayClient.joinSession).toHaveBeenCalledWith('sess-abc');
    // Registering after the join would let the first frames leak into the user's chat.
    expect(relayClient.registerHiddenSession.mock.invocationCallOrder[0])
      .toBeLessThan(relayClient.joinSession.mock.invocationCallOrder[0]);
    expect(relayClient.sendMessage).toHaveBeenCalledWith(expect.stringContaining('"foo"'), [], 'sess-abc');

    handler({ type: 'message_complete', sessionId: 'sess-abc' });

    await run;

    expect(relayClient.unregisterHiddenSession).toHaveBeenCalledWith('sess-abc');
    const deleteCall = relayTransport.fetch.mock.calls.find(c => c[0] === 'DELETE');
    expect(deleteCall[1]).toBe('/api/sessions/sess-abc');

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
    const handler = relayClient.registerHiddenSession.mock.calls[0][1];
    handler({ type: 'message_complete', sessionId: 'sess-abc', error: 'boom' });

    await expect(run).rejects.toThrow('boom');

    const sentTypes = relayClient.sendToBrowser.mock.calls.map(c => c[0].type);
    expect(sentTypes).toContain('search_ai_failed');
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
    const handler = relayClient.registerHiddenSession.mock.calls[0][1];
    handler({ type: 'message_complete', sessionId: 'sess-abc' });
    await run;
  });

  it('on RELAY_TIMEOUT_MS with no message_complete, stops generation and fails', async () => {
    // Keep setImmediate/queueMicrotask real so waitForHandler's microtask pump
    // (and the awaited session-create POST) can still settle while only the
    // setTimeout clock is faked. test/setup.js force-restores real timers after.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });

    const { relayTransport, relayClient, browserWs, resolveProject } = makeMocks();
    const svc = new SearchSummarizer({ relayTransport, resolveProject, log: null });

    const run = svc.run({
      requestId: 'r4', projectId: 'p1', query: 'foo', matches: [],
      relayClient, browserWs,
    });
    // run() rejects on timeout; attach the assertion now so the rejection is
    // never unhandled while we drive the clock.
    const settled = expect(run).rejects.toThrow(/timed out/i);

    // The session-create POST is awaited before setTimeout is armed; let that
    // microtask chain unwind (handler registration is our proxy for "armed").
    await waitForHandler(relayClient);
    expect(relayClient.stopGeneration).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 1000 + 1);

    await settled;

    // Regression guard against token bleed: generation must be explicitly
    // stopped for the hidden session, not just left to expire.
    expect(relayClient.stopGeneration).toHaveBeenCalledWith('sess-abc');

    const sentTypes = relayClient.sendToBrowser.mock.calls.map(c => c[0].type);
    expect(sentTypes).toContain('search_ai_failed');
    expect(sentTypes).not.toContain('search_ai_completed');
    const failFrame = relayClient.sendToBrowser.mock.calls.map(c => c[0])
      .find(f => f.type === 'search_ai_failed');
    expect(failFrame.error).toMatch(/timed out/i);

    expect(relayClient.unregisterHiddenSession).toHaveBeenCalledWith('sess-abc');
    const deleteCall = relayTransport.fetch.mock.calls.find(c => c[0] === 'DELETE');
    expect(deleteCall[1]).toBe('/api/sessions/sess-abc');
  });
});
