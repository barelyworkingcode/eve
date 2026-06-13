const ModuleInvoker = require('../../module-invoker');

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(cond, n = 30) {
  for (let i = 0; i < n; i++) { if (cond()) return; await tick(); }
  throw new Error('condition not met in time');
}

// Fake per-connection RelayClient: captures the module-session handler so the
// test can feed relay frames back through it, and records outbound calls.
function makeRelay(browserWs) {
  const state = { handler: null, framesToBrowser: [], messages: [] };
  const relay = {
    browserWs,
    registerModuleSession: jest.fn((sid, h) => { state.handler = h; }),
    unregisterModuleSession: jest.fn(),
    joinSession: jest.fn(),
    sendMessage: jest.fn((text, files, sid) => state.messages.push({ text, files, sid })),
    stopGeneration: jest.fn(),
    sendToBrowser: jest.fn((f) => state.framesToBrowser.push(f)),
    _state: state,
    _feed: (msg) => state.handler(msg),
  };
  return relay;
}

function makeInvoker(overrides = {}) {
  const relayTransport = {
    fetch: jest.fn((method) => (method === 'POST'
      ? Promise.resolve({ status: 200, data: { sessionId: 'sess-1' } })
      : Promise.resolve({ status: 200, data: {} }))), // DELETE
  };
  const moduleService = {
    getModule: jest.fn().mockResolvedValue({ displayName: 'Demo', model: '', permissions: { files: ['ctx.txt'], tools: [] } }),
    isFilePermitted: jest.fn((manifest, f) => (manifest.permissions.files || []).includes(f)),
  };
  const fileService = { readFile: jest.fn().mockResolvedValue({ content: 'CTX' }) };
  const resolveProject = jest.fn((id) => (id === 'p1' ? { id: 'p1', path: '/proj', allowedModels: ['default-model'] } : null));
  const deps = { relayTransport, moduleService, fileService, resolveProject, log: null, ...overrides };
  return { invoker: new ModuleInvoker(deps), ...deps };
}

const browserWs = () => ({ readyState: 1, send: jest.fn() });

describe('ModuleInvoker', () => {
  describe('invoke — streaming happy path', () => {
    it('accumulates assistant text, parses JSON for a schema, and tears the session down', async () => {
      const { invoker, relayTransport } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);

      const p = invoker.invoke({
        requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'do it',
        files: ['ctx.txt'], schema: { type: 'object' }, relayClient: relay, browserWs: ws,
      });

      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);
      expect(relay._state.framesToBrowser[0]).toMatchObject({ type: 'module_ai_started', requestId: 'rq', sessionId: 'sess-1' });
      expect(relay.joinSession).toHaveBeenCalledWith('sess-1');

      relay._feed({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: '{"ok":' } } });
      relay._feed({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: 'true}' } } });
      relay._feed({ type: 'message_complete' });

      const out = await p;
      expect(out).toMatchObject({ result: { ok: true }, rawText: '{"ok":true}', sessionId: 'sess-1' });
      // The streamed event was forwarded to the browser.
      expect(relay._state.framesToBrowser.some(f => f.type === 'module_ai_event')).toBe(true);
      // finally: unregister + DELETE the ephemeral session + drop from active.
      expect(relay.unregisterModuleSession).toHaveBeenCalledWith('sess-1');
      expect(relayTransport.fetch).toHaveBeenCalledWith('DELETE', '/api/sessions/sess-1');
      expect(invoker.active.has('rq')).toBe(false);
    });

    it('returns raw text (not parsed) when no schema is given', async () => {
      const { invoker } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);
      const p = invoker.invoke({ requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'hi', files: [], relayClient: relay, browserWs: ws });
      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);
      relay._feed({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: 'plain answer' } } });
      relay._feed({ type: 'message_complete' });
      const out = await p;
      expect(out.result).toBe('plain answer');
    });

    it('strips ```json fences before parsing schema output', async () => {
      const { invoker } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);
      const p = invoker.invoke({ requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'hi', files: [], schema: {}, relayClient: relay, browserWs: ws });
      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);
      relay._feed({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: '```json\n{"a":1}\n```' } } });
      relay._feed({ type: 'message_complete' });
      expect((await p).result).toEqual({ a: 1 });
    });
  });

  describe('load-bearing invariants', () => {
    it('names the hidden session with the __module: prefix', async () => {
      const { invoker, relayTransport } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);
      const p = invoker.invoke({ requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'hi', files: [], relayClient: relay, browserWs: ws });
      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);

      const post = relayTransport.fetch.mock.calls.find(c => c[0] === 'POST');
      expect(post[2].name).toMatch(/^__module:demo:/);
      expect(post[2].name.startsWith(ModuleInvoker.HIDDEN_SESSION_PREFIX)).toBe(true);

      relay._feed({ type: 'message_complete' });
      await p;
    });
  });

  describe('validation (throws before any session is created)', () => {
    const cases = [
      ['requestId required', { projectId: 'p1', moduleName: 'demo', prompt: 'x' }],
      ['projectId and moduleName required', { requestId: 'r', moduleName: 'demo', prompt: 'x' }],
      ['prompt required', { requestId: 'r', projectId: 'p1', moduleName: 'demo' }],
      ['relayClient required', { requestId: 'r', projectId: 'p1', moduleName: 'demo', prompt: 'x' }],
    ];
    it.each(cases)('rejects (%s) and never POSTs a session', async (msg, args) => {
      const { invoker, relayTransport } = makeInvoker();
      const full = { relayClient: makeRelay(browserWs()), ...args };
      if (msg === 'relayClient required') full.relayClient = undefined;
      await expect(invoker.invoke(full)).rejects.toThrow(msg);
      expect(relayTransport.fetch).not.toHaveBeenCalled();
    });

    it('rejects an unknown project', async () => {
      const { invoker, relayTransport } = makeInvoker();
      await expect(invoker.invoke({ requestId: 'r', projectId: 'ghost', moduleName: 'demo', prompt: 'x', relayClient: makeRelay(browserWs()) }))
        .rejects.toThrow('Project not found');
      expect(relayTransport.fetch).not.toHaveBeenCalled();
    });

    it('rejects files outside the module permissions and exposes deniedFiles', async () => {
      const { invoker, relayTransport } = makeInvoker();
      const promise = invoker.invoke({ requestId: 'r', projectId: 'p1', moduleName: 'demo', prompt: 'x', files: ['secret.txt'], relayClient: makeRelay(browserWs()) });
      await expect(promise).rejects.toThrow(/Permission denied for files: secret\.txt/);
      expect(relayTransport.fetch).not.toHaveBeenCalled();
    });

    it('refuses tools when the project has no id (relay cannot broker a token)', async () => {
      const { invoker, moduleService, resolveProject, relayTransport } = makeInvoker();
      moduleService.getModule.mockResolvedValue({ displayName: 'D', permissions: { files: [], tools: ['Read'] } });
      resolveProject.mockReturnValue({ path: '/proj' }); // no id
      await expect(invoker.invoke({ requestId: 'r', projectId: 'p1', moduleName: 'demo', prompt: 'x', files: [], relayClient: makeRelay(browserWs()) }))
        .rejects.toThrow(/no project context/);
      expect(relayTransport.fetch).not.toHaveBeenCalled();
    });
  });

  describe('failure paths still clean up', () => {
    it('rejects on a message_complete carrying an error, then unregisters and deletes', async () => {
      const { invoker, relayTransport } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);
      const p = invoker.invoke({ requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'x', files: [], relayClient: relay, browserWs: ws });
      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);
      relay._feed({ type: 'message_complete', error: 'model failed' });
      await expect(p).rejects.toThrow('model failed');
      expect(relay.unregisterModuleSession).toHaveBeenCalledWith('sess-1');
      expect(relayTransport.fetch).toHaveBeenCalledWith('DELETE', '/api/sessions/sess-1');
    });

    it('rejects on a relay error frame', async () => {
      const { invoker } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);
      const p = invoker.invoke({ requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'x', files: [], relayClient: relay, browserWs: ws });
      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);
      relay._feed({ type: 'error', message: 'boom' });
      await expect(p).rejects.toThrow('boom');
    });

    it('rejects (and never registers a handler) when the hidden session cannot be created', async () => {
      const { invoker, relayTransport } = makeInvoker();
      relayTransport.fetch.mockResolvedValueOnce({ status: 500, data: { error: 'relay down' } }); // POST fails
      const relay = makeRelay(browserWs());
      await expect(invoker.invoke({ requestId: 'r', projectId: 'p1', moduleName: 'demo', prompt: 'x', files: [], relayClient: relay }))
        .rejects.toThrow('relay down');
      expect(relay.registerModuleSession).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('sends stop_generation for an active request and is idempotent for unknown ids', async () => {
      const { invoker } = makeInvoker();
      const ws = browserWs();
      const relay = makeRelay(ws);
      const p = invoker.invoke({ requestId: 'rq', projectId: 'p1', moduleName: 'demo', prompt: 'x', files: [], relayClient: relay, browserWs: ws });
      await waitFor(() => relay.registerModuleSession.mock.calls.length > 0);

      expect(invoker.stop('rq')).toBe(true);
      expect(relay.stopGeneration).toHaveBeenCalledWith('sess-1');
      expect(invoker.stop('does-not-exist')).toBe(false);

      relay._feed({ type: 'message_complete' });
      await p;
    });
  });
});
