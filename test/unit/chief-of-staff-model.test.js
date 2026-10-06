const { EventEmitter } = require('events');
const { ChiefOfStaffModel } = require('../../chief-of-staff-model');

const OPTS = { projectId: 'p1', directory: '/tmp/acme', model: 'haiku', timeoutMs: 2000 };

// A relay that answers session create, then plays a script on each socket.
// initScripts[i] is what session i reports in system/init: an array of tools,
// or null for no init frame at all.
function makeRelay({ initScripts = [[]], silentAfterBootstrap = false } = {}) {
  const r = { fetches: [], sockets: [], sent: [], created: 0 };
  r.transport = {
    fetch: jest.fn(async (method, path, body, opts) => {
      r.fetches.push({ method, path, body, opts });
      if (method === 'POST' && path === '/api/sessions') {
        r.created += 1;
        return { status: 201, data: { sessionId: `m${r.created}` } };
      }
      return { status: 204, data: null };
    }),
    createWebSocket: jest.fn((path, opts) => {
      const ws = new EventEmitter();
      ws.readyState = 1;
      ws.path = path;
      ws.opts = opts;
      ws.close = jest.fn(() => { ws.readyState = 3; });
      let sid = null;
      let n = 0;
      const emit = (o) => ws.emit('message', Buffer.from(JSON.stringify({ sessionId: sid, ...o })));
      ws.send = (json) => {
        const f = JSON.parse(json);
        r.sent.push({ sid, ...f });
        if (f.type === 'join_session') { sid = f.sessionId; return; }
        if (f.type !== 'send_message') return;
        n += 1;
        const script = initScripts[Number(sid.slice(1)) - 1];
        setImmediate(() => {
          if (n === 1 && script) emit({ type: 'llm_event', event: { type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001', tools: script } });
          if (n > 1 && silentAfterBootstrap) return;
          emit({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: n === 1 ? 'ready' : 'answer to: ' } } });
          if (n > 1) emit({ type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text: f.text } } });
          emit({ type: 'message_complete' });
        });
      };
      r.sockets.push(ws);
      setImmediate(() => ws.emit('open'));
      return ws;
    }),
  };
  r.agentTextSent = (needle) => r.sent.some((f) => f.type === 'send_message' && f.text.includes(needle));
  return r;
}

const make = (relay, extra = {}) => new ChiefOfStaffModel({ relayTransport: relay.transport, countCall: () => true, ...extra });

describe('launch', () => {
  it('creates a hidden, headless, unlisted session with no tools asked for, on an unscoped socket', async () => {
    const relay = makeRelay();
    const out = await make(relay).turn('hello', OPTS);
    const create = relay.fetches.find((f) => f.method === 'POST' && f.path === '/api/sessions');
    expect(create.body.name).toMatch(/^__cos:[0-9a-f]{12}$/);
    expect(create.body).toMatchObject({ projectId: 'p1', directory: '/tmp/acme', model: 'haiku', appendClaudeMd: false });
    expect(create.body.settings.headless).toBe(true);
    expect(create.body.settings.permissionPolicy.deniedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch']));
    expect(create.body).not.toHaveProperty('agent');
    expect(create.body.settings).not.toHaveProperty('useRelayTools');
    expect(create.body).not.toHaveProperty('useRelayTools');
    expect(create.opts?.scope).toBeUndefined();
    expect(relay.sockets[0].path).toBe('/ws');
    expect(relay.sockets[0].opts?.scope).toBeUndefined();
    expect(out).toEqual({ text: 'answer to: hello', modelId: 'claude-haiku-4-5-20251001' });
  });

  it('deletes the previous run\'s session before launching', async () => {
    const relay = makeRelay();
    await make(relay, { previousSessionId: 'old1' }).turn('hello', OPTS);
    const i = relay.fetches.findIndex((f) => f.method === 'DELETE' && f.path === '/api/sessions/old1');
    const j = relay.fetches.findIndex((f) => f.method === 'POST' && f.path === '/api/sessions');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(j);
  });

  it('reports a failed create as launch_failed', async () => {
    const relay = makeRelay();
    relay.transport.fetch.mockImplementation(async () => ({ status: 500, data: { error: 'boom' } }));
    await expect(make(relay).turn('hello', OPTS)).rejects.toMatchObject({ code: 'launch_failed' });
  });
});

describe('fail-closed tool check', () => {
  it('sends agent text only after a bootstrap that carries none', async () => {
    const relay = makeRelay();
    await make(relay).turn('AGENT-TEXT', OPTS);
    const messages = relay.sent.filter((f) => f.type === 'send_message');
    expect(messages).toHaveLength(2);
    expect(messages[0].text).not.toContain('AGENT-TEXT');
    expect(messages[1].text).toBe('AGENT-TEXT');
  });

  it('relaunches once denying the tools it listed, and then works', async () => {
    const relay = makeRelay({ initScripts: [['Bash', 'mcp__acme__lookup'], []] });
    const out = await make(relay).turn('AGENT-TEXT', OPTS);
    const creates = relay.fetches.filter((f) => f.method === 'POST' && f.path === '/api/sessions');
    expect(creates).toHaveLength(2);
    expect(creates[1].body.settings.permissionPolicy.deniedTools).toContain('mcp__acme__lookup');
    expect(relay.fetches.some((f) => f.method === 'DELETE' && f.path === '/api/sessions/m1')).toBe(true);
    expect(out.text).toBe('answer to: AGENT-TEXT');
  });

  it('gives up with tools_present when tools remain after the relaunch, never sending agent text', async () => {
    const relay = makeRelay({ initScripts: [['mcp__acme__lookup'], ['mcp__acme__lookup']] });
    await expect(make(relay).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_present' });
    expect(relay.created).toBe(2);
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });

  it('treats "tools": null as unverified, never sending agent text', async () => {
    // relay's pi and codex providers report a null list: unknown, not empty.
    const relay = makeRelay({ initScripts: [null] });
    const wsFactory = relay.transport.createWebSocket;
    relay.transport.createWebSocket = jest.fn((path, opts) => {
      const ws = wsFactory(path, opts);
      const send = ws.send;
      ws.send = (json) => {
        send(json);
        const f = JSON.parse(json);
        if (f.type === 'send_message' && f.text !== undefined && !relay.nullSent) {
          relay.nullSent = true;
          setImmediate(() => ws.emit('message', Buffer.from(JSON.stringify({ sessionId: 'm1', type: 'llm_event', event: { type: 'system', subtype: 'init', model: 'x', tools: null } }))));
        }
      };
      return ws;
    });
    await expect(make(relay).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_unverified' });
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });

  it('gives up with tools_unverified when no tool list is ever reported, never sending agent text', async () => {
    const relay = makeRelay({ initScripts: [null] });
    await expect(make(relay).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_unverified' });
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });
});

describe('daily limit and timeout', () => {
  it('sends nothing when countCall says no', async () => {
    const relay = makeRelay();
    const m = new ChiefOfStaffModel({ relayTransport: relay.transport, countCall: () => false });
    await expect(m.turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'limit' });
    expect(relay.sent.filter((f) => f.type === 'send_message')).toHaveLength(0);
  });

  it('counts the bootstrap and every turn', async () => {
    const relay = makeRelay();
    const countCall = jest.fn(() => true);
    const m = new ChiefOfStaffModel({ relayTransport: relay.transport, countCall });
    await m.turn('one', OPTS);
    await m.turn('two', OPTS);
    expect(countCall).toHaveBeenCalledTimes(3);
  });

  it('refuses a turn when the limit hits after bootstrap, and sends no agent text', async () => {
    const relay = makeRelay();
    let n = 0;
    const m = new ChiefOfStaffModel({ relayTransport: relay.transport, countCall: () => ++n <= 1 });
    await expect(m.turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'limit' });
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });

  it('stops generation and rejects with timeout when the model never finishes', async () => {
    const relay = makeRelay({ silentAfterBootstrap: true });
    await expect(make(relay).turn('hello', { ...OPTS, timeoutMs: 60 })).rejects.toMatchObject({ code: 'timeout' });
    expect(relay.sent.some((f) => f.type === 'stop_generation')).toBe(true);
  });
});
