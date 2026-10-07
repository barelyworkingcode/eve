const { EventEmitter } = require('events');
const { ChiefOfStaffModel, PERSON_ALLOWED_TOOLS, BUILTIN_TOOLS } = require('../../chief-of-staff-model');
const { personSystemPrompt, systemPrompt } = require('../../chief-of-staff-prompt');

const OPTS = { projectId: 'p1', directory: '/tmp/acme', model: 'haiku', timeoutMs: 2000 };

// A relay that answers session create, then plays a script on each socket.
// initScripts[i] is what session i reports in system/init: an array of tools,
// or null for no init frame at all.
// apiErrorOn: turn numbers (1 = bootstrap) that end as relay forwards a CLI
// API error: an error-marked message_start, the CLI's synthetic text, and a
// failed message_complete.
// turnScript(n, emit, frame): replaces the default answer for turn n > 1.
function makeRelay({ initScripts = [[]], silentAfterBootstrap = false, apiErrorOn = [], turnScript = null } = {}) {
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
          if (n > 1 && turnScript) { turnScript(n, emit, f); return; }
          if (apiErrorOn.includes(n)) {
            emit({ type: 'llm_event', event: { type: 'assistant', message: { id: `e${n}`, role: 'assistant', content: [] }, error: 'authentication_failed' } });
            emit({ type: 'llm_event', event: { type: 'assistant', index: 0, delta: { type: 'text_delta', text: 'Failed to authenticate: OAuth token revoked.' } } });
            emit({ type: 'message_complete', isError: true, apiErrorStatus: 401 });
            return;
          }
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

// Frames a relay sends on session i's socket outside any scripted turn.
const emitOn = (relay, i, sid, o) => relay.sockets[i].emit('message', Buffer.from(JSON.stringify({ sessionId: sid, ...o })));

const make = (relay, extra = {}) => new ChiefOfStaffModel({ relayTransport: relay.transport, countCall: () => true, ...extra });

describe('launch', () => {
  it('creates a hidden, headless, unlisted session with no tools asked for, on an unscoped socket', async () => {
    const relay = makeRelay();
    const out = await make(relay).turn('hello', OPTS);
    const create = relay.fetches.find((f) => f.method === 'POST' && f.path === '/api/sessions');
    expect(create.body.name).toMatch(/^__cos:[0-9a-f]{12}$/);
    expect(create.body).toMatchObject({ projectId: 'p1', directory: '/tmp/acme', model: 'haiku', appendClaudeMd: false });
    expect(create.body.settings.headless).toBe(true);
    expect(create.body.settings.permissionPolicy.deniedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch', 'mcp__*']));
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
        const f = JSON.parse(json);
        // Queued before the harness send, so the null init lands ahead of message_complete.
        if (f.type === 'send_message' && f.text !== undefined && !relay.nullSent) {
          relay.nullSent = true;
          setImmediate(() => ws.emit('message', Buffer.from(JSON.stringify({ sessionId: 'm1', type: 'llm_event', event: { type: 'system', subtype: 'init', model: 'x', tools: null } }))));
        }
        send(json);
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

describe('API errors', () => {
  it('rejects a turn the CLI ended with an API error, with its code and status, and ends the session', async () => {
    const relay = makeRelay({ apiErrorOn: [2] });
    const model = make(relay);
    const err = await model.turn('AGENT-TEXT', OPTS).catch((e) => e);
    expect(err).toMatchObject({ name: 'ModelError', code: 'authentication_failed', status: 401 });
    expect(err.message).not.toContain('OAuth');
    expect(model.sessionId).toBeNull();
    expect(relay.fetches.some((f) => f.method === 'DELETE' && f.path === '/api/sessions/m1')).toBe(true);
  });

  it('fails the bootstrap on an API error and never sends agent text', async () => {
    const relay = makeRelay({ apiErrorOn: [1] });
    await expect(make(relay).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });
});

// The person session: exactly Read, Grep, Glob and the eve-cos tools.
describe('person session allow-list', () => {
  const person = (extra = {}) => ({ kind: 'person', allowedTools: PERSON_ALLOWED_TOOLS, sessionSettings: { useRelayTools: true, readOnlyProjects: true }, ...extra });
  const creates = (relay) => relay.fetches.filter((f) => f.method === 'POST' && f.path === '/api/sessions');
  const texts = (relay) => relay.sent.filter((f) => f.type === 'send_message');

  it('allows exactly Read, Grep, Glob and the four eve-cos tools', () => {
    expect([...PERSON_ALLOWED_TOOLS].sort()).toEqual([
      'Glob', 'Grep', 'Read',
      'mcp__relay__cos_list_sessions', 'mcp__relay__cos_propose_send',
      'mcp__relay__cos_propose_start', 'mcp__relay__cos_session_status',
    ]);
  });

  it('creates the session with the person prompt, relay settings, and every built-in denied except Read, Grep, Glob and mcp__*', async () => {
    const relay = makeRelay({ initScripts: [PERSON_ALLOWED_TOOLS] });
    await make(relay, person()).turn('hello', OPTS);
    const body = creates(relay)[0].body;
    expect(body.systemPrompt).toBe(personSystemPrompt());
    expect(body.settings).toMatchObject({ headless: true, useRelayTools: true, readOnlyProjects: true });
    const denied = body.settings.permissionPolicy.deniedTools;
    expect([...denied].sort()).toEqual(BUILTIN_TOOLS.filter((t) => !['Read', 'Grep', 'Glob', 'mcp__*'].includes(t)).sort());
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch']));
  });

  it('passes the check on exactly the allowed list, in any order, and then sends the turn', async () => {
    const relay = makeRelay({ initScripts: [[...PERSON_ALLOWED_TOOLS].reverse()] });
    const out = await make(relay, person()).turn('AGENT-TEXT', OPTS);
    expect(creates(relay)).toHaveLength(1);
    expect(out.text).toBe('answer to: AGENT-TEXT');
  });

  it('relaunches once with the extra tool denied, then works', async () => {
    const relay = makeRelay({ initScripts: [[...PERSON_ALLOWED_TOOLS, 'Bash', 'mcp__acme__lookup'], PERSON_ALLOWED_TOOLS] });
    const out = await make(relay, person()).turn('AGENT-TEXT', OPTS);
    expect(creates(relay)).toHaveLength(2);
    const denied = creates(relay)[1].body.settings.permissionPolicy.deniedTools;
    expect(denied).toEqual(expect.arrayContaining(['mcp__acme__lookup', 'Bash']));
    expect(denied).not.toContain('Read');
    expect(out.text).toBe('answer to: AGENT-TEXT');
  });

  it('is off with tools_present when the extra tool is still listed after the relaunch, never sending agent text', async () => {
    const extra = [...PERSON_ALLOWED_TOOLS, 'mcp__acme__lookup'];
    const relay = makeRelay({ initScripts: [extra, extra] });
    const model = make(relay, person());
    await expect(model.turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_present' });
    expect(relay.created).toBe(2);
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
    expect(model.sessionId).toBeNull();
  });

  it('is off with tools_missing, naming each missing tool, and does not relaunch or send agent text', async () => {
    const relay = makeRelay({ initScripts: [['Read', 'Grep', 'Glob']] });
    const model = make(relay, person());
    const err = await model.turn('AGENT-TEXT', OPTS).catch((e) => e);
    expect(err).toMatchObject({ name: 'ModelError', code: 'tools_missing' });
    for (const t of ['mcp__relay__cos_list_sessions', 'mcp__relay__cos_session_status', 'mcp__relay__cos_propose_start', 'mcp__relay__cos_propose_send']) {
      expect(err.message).toContain(t);
    }
    expect(err.message).not.toContain('Read');
    expect(relay.created).toBe(1);
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
    expect(model.sessionId).toBeNull();
    expect(relay.fetches.some((f) => f.method === 'DELETE' && f.path === '/api/sessions/m1')).toBe(true);
  });

  it('a missing built-in is also tools_missing', async () => {
    const relay = makeRelay({ initScripts: [PERSON_ALLOWED_TOOLS.filter((t) => t !== 'Grep')] });
    await expect(make(relay, person()).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_missing', message: expect.stringContaining('Grep') });
  });

  it('a null tool list is tools_unverified, never sending agent text', async () => {
    const relay = makeRelay({ initScripts: [null] });
    await expect(make(relay, person()).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_unverified' });
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });

  it('a later init that differs from the allowed set kills the session', async () => {
    const relay = makeRelay({
      initScripts: [PERSON_ALLOWED_TOOLS],
      turnScript: (n, emit) => {
        emit({ type: 'llm_event', event: { type: 'system', subtype: 'init', model: 'x', tools: [...PERSON_ALLOWED_TOOLS, 'Bash'] } });
        emit({ type: 'message_complete' });
      },
    });
    const model = make(relay, person());
    await expect(model.turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_present' });
    expect(model.sessionId).toBeNull();
    expect(relay.fetches.some((f) => f.method === 'DELETE' && f.path === '/api/sessions/m1')).toBe(true);
  });

  it.each(['session_ended', 'process_exited'])('a %s frame ends the session and the next turn relaunches', async (type) => {
    const relay = makeRelay({ initScripts: [PERSON_ALLOWED_TOOLS, PERSON_ALLOWED_TOOLS] });
    const model = make(relay, person());
    await model.turn('one', OPTS);
    expect(model.sessionId).toBe('m1');
    emitOn(relay, 0, 'm1', { type });
    expect(model.sessionId).toBeNull();
    const out = await model.turn('two', OPTS);
    expect(relay.created).toBe(2);
    expect(model.sessionId).toBe('m2');
    expect(out.text).toBe('answer to: two');
    expect(texts(relay).filter((f) => f.sid === 'm2').map((f) => f.text).pop()).toBe('two');
  });

  it('a closed socket ends the session and the next turn relaunches', async () => {
    const relay = makeRelay({ initScripts: [PERSON_ALLOWED_TOOLS, PERSON_ALLOWED_TOOLS] });
    const model = make(relay, person());
    await model.turn('one', OPTS);
    relay.sockets[0].emit('close');
    expect(model.sessionId).toBeNull();
    await model.turn('two', OPTS);
    expect(relay.created).toBe(2);
  });

  it('returns the text of every message in a tool-using turn, in order', async () => {
    const msg = (id, content) => ({ type: 'llm_event', event: { type: 'assistant', message: { id, role: 'assistant', content } } });
    const relay = makeRelay({
      initScripts: [PERSON_ALLOWED_TOOLS],
      turnScript: (n, emit) => {
        emit(msg('a1', [{ type: 'text', text: 'FIRST-PART' }]));
        emit(msg('a2', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/acme/x' } }]));
        emit(msg('a3', [{ type: 'text', text: 'SECOND-PART' }]));
        emit({ type: 'message_complete' });
      },
    });
    const out = await make(relay, person()).turn('hello', OPTS);
    expect(out.text).toContain('FIRST-PART');
    expect(out.text).toContain('SECOND-PART');
    expect(out.text.indexOf('FIRST-PART')).toBeLessThan(out.text.indexOf('SECOND-PART'));
  });
});

describe('wake session keeps no tools', () => {
  const create = (relay) => relay.fetches.find((f) => f.method === 'POST' && f.path === '/api/sessions').body;

  it('denies Read, Grep, Glob and mcp__*, sets no relay-tool settings, and uses the wake prompt', async () => {
    const relay = makeRelay({ initScripts: [[]] });
    await make(relay, { kind: 'wake' }).turn('hello', OPTS);
    const body = create(relay);
    expect(body.settings.permissionPolicy.deniedTools).toEqual(expect.arrayContaining(['mcp__*', 'Read', 'Grep', 'Glob']));
    expect(body.settings).not.toHaveProperty('useRelayTools');
    expect(body.settings).not.toHaveProperty('readOnlyProjects');
    expect(body.systemPrompt).toBe(systemPrompt());
  });

  it.each(['Read', 'mcp__relay__cos_propose_send'])('listing %s in init is tools_present', async (tool) => {
    const relay = makeRelay({ initScripts: [[tool], [tool]] });
    await expect(make(relay, { kind: 'wake' }).turn('AGENT-TEXT', OPTS)).rejects.toMatchObject({ code: 'tools_present' });
    expect(relay.agentTextSent('AGENT-TEXT')).toBe(false);
  });
});
