const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChiefOfStaff } = require('../../chief-of-staff');
const actions = require('../../chief-of-staff-actions');

const { CosTurn, canonical, validateStartFields, resolveProjectArg, handleCall, internalHandler } = actions;
const PREFIX = 'mcp__relay__';
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';

describe('canonical', () => {
  it('ignores key order at every depth and keeps array order', () => {
    expect(canonical({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(canonical({ a: { c: 'x', d: [1, 2] }, b: 1 }));
    expect(canonical({ a: [1, 2] })).not.toBe(canonical({ a: [2, 1] }));
  });
});

describe('CosTurn.claim', () => {
  const settled = (p) => p.then(() => 'resolved', (e) => e.code);

  it('resolves a claim recorded before it and one recorded after it', async () => {
    const turn = new CosTurn({ personText: 'hi' });
    turn.record({ toolUseId: 'u1', name: `${PREFIX}cos_propose_send`, input: { text: 'a', sessionId: 's1' } });
    await expect(turn.claim(`${PREFIX}cos_propose_send`, { sessionId: 's1', text: 'a' })).resolves.toMatchObject({ toolUseId: 'u1' });
    const later = turn.claim(`${PREFIX}cos_propose_send`, { sessionId: 's2', text: 'b' });
    turn.record({ toolUseId: 'u2', name: `${PREFIX}cos_propose_send`, input: { sessionId: 's2', text: 'b' } });
    await expect(later).resolves.toMatchObject({ toolUseId: 'u2' });
  });

  it.each([
    ['a different tool name', `${PREFIX}cos_propose_start`, { text: 'a' }],
    ['different input', `${PREFIX}cos_propose_send`, { text: 'changed' }],
  ])('does not match %s: the claim rejects as unverified_call when the turn settles', async (_what, name, args) => {
    const turn = new CosTurn({ personText: 'hi' });
    turn.record({ toolUseId: 'u1', name: `${PREFIX}cos_propose_send`, input: { text: 'a' } });
    const claim = settled(turn.claim(name, args));
    turn.settle();
    expect(await claim).toBe('unverified_call');
  });

  it('lets one tool_use satisfy one claim only', async () => {
    const turn = new CosTurn({ personText: 'hi' });
    turn.record({ toolUseId: 'u1', name: 'n', input: { a: 1 } });
    await turn.claim('n', { a: 1 });
    const second = settled(turn.claim('n', { a: 1 }));
    turn.settle();
    expect(await second).toBe('unverified_call');
  });

  it('records a repeated toolUseId once, and nothing after the turn settled', async () => {
    const turn = new CosTurn({ personText: 'hi' });
    turn.record({ toolUseId: 'u1', name: 'Read', input: {} });
    turn.record({ toolUseId: 'u1', name: 'Read', input: {} });
    expect(turn.toolCalls).toHaveLength(1);
    turn.settle();
    turn.record({ toolUseId: 'u2', name: 'Read', input: {} });
    expect(turn.toolCalls).toHaveLength(1);
    expect(await settled(turn.claim('Read', {}))).toBe('resolved'); // an already-recorded call still claims
    expect(await settled(turn.claim('Bash', {}))).toBe('unverified_call'); // a claim after settle rejects at once
  });

  it('readTools lists reading tools only', () => {
    const turn = new CosTurn({ personText: 'hi' });
    turn.record({ toolUseId: 'u1', name: 'Read', input: {} });
    turn.record({ toolUseId: 'u2', name: `${PREFIX}cos_propose_send`, input: {} });
    turn.record({ toolUseId: 'u3', name: `${PREFIX}cos_list_sessions`, input: {} });
    expect(turn.readTools).toEqual(['Read', `${PREFIX}cos_list_sessions`]);
  });
});

describe('validateStartFields', () => {
  const ok = (over) => validateStartFields({ prompt: 'go', ...over }, 'haiku');
  const bad = (over) => validateStartFields({ prompt: 'go', ...over }, 'haiku').error;

  it('defaults mode to headless, model to the given default, folder to empty, and trims the prompt', () => {
    expect(ok({ prompt: '  go  ' }).value).toEqual({ prompt: 'go', folder: '', model: 'haiku', mode: 'headless' });
  });

  it('keeps what the caller gave', () => {
    expect(ok({ folder: 'src/lib', model: 'opus', mode: 'terminal' }).value).toEqual({ prompt: 'go', folder: 'src/lib', model: 'opus', mode: 'terminal' });
  });

  it.each([
    ['empty', ''], ['whitespace only', ' \n\t'], ['missing', undefined], ['not a string', 7], ['8001 characters', 'x'.repeat(8001)],
  ])('refuses a prompt that is %s, naming prompt', (_what, prompt) => {
    const r = validateStartFields({ prompt }, 'haiku');
    expect(r.error).toMatchObject({ status: 400, code: 'invalid_args' });
    expect(r.error.message).toMatch(/^prompt/);
  });

  it('accepts a prompt of exactly 8000 characters after trim', () => {
    expect(ok({ prompt: ` ${'x'.repeat(8000)} ` }).value.prompt).toHaveLength(8000);
  });

  it.each([['absolute', '/etc'], ['a .. segment', '../x'], ['a nested .. segment', 'a/../b'], ['a backslash .. segment', 'a\\..\\b'], ['home', '~/x']])(
    'refuses a folder that is %s, naming folder', (_what, folder) => {
      expect(bad({ folder })).toMatchObject({ status: 400, code: 'invalid_args' });
      expect(bad({ folder }).message).toMatch(/^folder/);
    });

  it('refuses a mode outside headless and terminal, naming mode', () => {
    expect(bad({ mode: 'gui' })).toMatchObject({ status: 400, code: 'invalid_args' });
    expect(bad({ mode: 'gui' }).message).toMatch(/^mode/);
  });
});

describe('resolveProjectArg', () => {
  const many = Array.from({ length: 25 }, (_v, i) => ({ id: `n${i}`, name: `Name${i}` }));
  const projects = [
    { id: 'p1', name: 'Acme' }, { id: 'p2', name: 'Beta' }, { id: 'p3', name: 'beta' },
    { id: 'h1', name: 'Remote', hostId: 'hx' }, ...many,
  ];
  const resolve = (ref) => resolveProjectArg(() => projects, ref);

  it('finds a project by exact id, and by exact name in any case', () => {
    expect(resolve('p1').value.id).toBe('p1');
    expect(resolve('aCMe').value.id).toBe('p1');
  });

  it.each([['empty', ''], ['missing', undefined]])('a %s project is invalid_args', (_what, ref) => {
    expect(resolve(ref).error).toMatchObject({ status: 400, code: 'invalid_args' });
  });

  it('an unknown project is 404 listing at most 20 names', () => {
    const { error } = resolve('Nope');
    expect(error).toMatchObject({ status: 404, code: 'unknown_project' });
    expect(error.message).toContain('Acme');
    expect(error.message).not.toContain('Name19');
    expect(error.message).not.toContain('Remote');
  });

  it('two projects with the same name in any case are 409 ambiguous', () => {
    expect(resolve('beta').error).toMatchObject({ status: 409, code: 'ambiguous_project' });
  });

  it('a project on a host is 403, by id and by name', () => {
    expect(resolve('h1').error).toMatchObject({ status: 403, code: 'project_on_host' });
    expect(resolve('remote').error).toMatchObject({ status: 403, code: 'project_on_host' });
  });
});

describe('/internal/cos', () => {
  const dirs = [];
  let h;

  // A ChiefOfStaff whose person model holds each turn open until release(), so a test can
  // fire tool_use events and calls while the turn is in flight.
  async function setup({ settings } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-act-'));
    dirs.push(dir);
    h = { dir, calls: [], toolUse: null, release: null, turnStarted: null };
    const rows = [{ id: 's1', name: 'Agent s1', projectId: 'p1', model: 'haiku', headless: true, attention: { state: 'idle', since: '2026-10-05T10:00:00.000Z' } }];
    const sockets = [];
    const transport = {
      fetch: jest.fn(async (method, p, body) => {
        h.calls.push({ method, path: p, body });
        if (method === 'GET' && p === '/api/sessions') return { status: 200, data: { sessions: rows } };
        if (method === 'POST' && p === '/api/chief-of-staff/sessions') return { status: 201, data: { sessionId: 'new1', name: body.prompt, mode: body.mode } };
        return { status: 404, data: {} };
      }),
      createWebSocket: () => { const ws = new EventEmitter(); ws.close = () => {}; sockets.push(ws); return ws; },
    };
    let personOpts = null;
    const person = {
      sessionId: 'ms1',
      projectId: 'p1',
      close: async () => {},
      turn: async () => {
        h.turnStarted();
        await new Promise((r) => { h.release = r; });
        return { text: fence({ reply: 'ok', send: null }), modelId: 'm' };
      },
    };
    h.cos = new ChiefOfStaff({
      relayTransport: transport,
      createModel: (o) => {
        if (o.kind !== 'person') return { sessionId: 'wk', projectId: 'p1', turn: async () => ({ text: '' }), close: async () => {} };
        personOpts = o;
        return person;
      },
      dataDir: dir,
      settings: { model: 'haiku', projectId: 'p1', ...(settings || {}) },
      listProjects: () => [{ id: 'p1', name: 'Acme', path: dir }, { id: 'h1', name: 'Remote', path: dir, hostId: 'hx' }],
      resolveProject: (id) => (id === 'p1' ? { id, name: 'Acme' } : null),
    });
    h.cos.start();
    if (!settings || settings.enabled !== false) {
      sockets[0].emit('open');
      while (!h.cos.roster.has('s1')) await new Promise((r) => setImmediate(r));
      h.fire = (name, input, id) => personOpts.onToolUse({ sessionId: 'ms1', toolUseId: id || `u${Math.random()}`, name, input });
    }
    return h;
  }

  // Starts a person turn and resolves once the model is holding it.
  async function beginTurn(text) {
    const started = new Promise((r) => { h.turnStarted = r; });
    h.cos.submitPerson(text);
    await started;
  }
  const call = (tool, args, projectId = 'p1') => handleCall(h.cos, { tool, args, meta: { project_id: projectId } });
  const finishTurn = async () => { h.release(); while (h.cos._turn) await new Promise((r) => setImmediate(r)); };

  afterEach(async () => {
    // Let the held turn finish so its writes land before the folder goes.
    if (h && h.release) h.release();
    while (h && h.cos._inFlight) await new Promise((r) => setImmediate(r));
    await h?.cos.stop();
    for (const d of dirs.splice(0)) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
    h = null;
  });

  it('an unknown tool is 400 before anything else; a known tool while off is 409 off', async () => {
    await setup({ settings: { enabled: false } });
    expect((await handleCall(h.cos, { tool: 'rm_rf', args: {}, meta: {} })).body).toMatchObject({ ok: false, error: 'unknown_tool' });
    expect(await handleCall(h.cos, { tool: 'cos_list_sessions', args: {}, meta: { project_id: 'p1' } })).toMatchObject({ status: 409, body: { error: 'off' } });
  });

  it('a call from another project is 403 not_cos_session, even with a turn in flight', async () => {
    await setup();
    await beginTurn('hello');
    h.fire(`${PREFIX}cos_list_sessions`, {});
    expect(await call('cos_list_sessions', {}, 'p-other')).toMatchObject({ status: 403, body: { error: 'not_cos_session' } });
    expect(await handleCall(h.cos, { tool: 'cos_list_sessions', args: {}, meta: {} })).toMatchObject({ status: 403, body: { error: 'not_cos_session' } });
  });

  it('a call with no person turn in flight is 409 no_turn', async () => {
    await setup();
    expect(await call('cos_list_sessions', {})).toMatchObject({ status: 409, body: { error: 'no_turn' } });
  });

  it('a call the model never made is 403 unverified_call once the turn ends', async () => {
    await setup();
    await beginTurn('hello');
    h.fire(`${PREFIX}cos_list_sessions`, {}); // a different call from the one made below
    const pending = call('cos_propose_send', { sessionId: 's1', text: 'hi' });
    await finishTurn();
    expect(await pending).toMatchObject({ status: 403, body: { ok: false, error: 'unverified_call' } });
  });

  it('matches the model call whatever the key order of its input', async () => {
    await setup();
    await beginTurn('hello');
    h.fire(`${PREFIX}cos_propose_start`, { prompt: 'go', project: 'Acme' });
    const out = await call('cos_propose_start', { project: 'Acme', prompt: 'go' });
    expect(out).toMatchObject({ status: 200, body: { ok: true, result: { status: 'started' } } });
  });

  it.each([
    ['an empty prompt', { project: 'Acme', prompt: ' ' }, 400, 'invalid_args', /prompt/],
    ['a folder with ..', { project: 'Acme', prompt: 'go', folder: '../x' }, 400, 'invalid_args', /folder/],
    ['an unknown project', { project: 'Nope', prompt: 'go' }, 404, 'unknown_project', /Acme/],
    ['a host project', { project: 'Remote', prompt: 'go' }, 403, 'project_on_host', /host/],
    ['a bad mode', { project: 'Acme', prompt: 'go', mode: 'gui' }, 400, 'invalid_args', /mode/],
  ])('cos_propose_start with %s is refused before anything starts', async (_what, args, status, code, msg) => {
    await setup();
    await beginTurn('hello');
    h.fire(`${PREFIX}cos_propose_start`, args);
    const out = await call('cos_propose_start', args);
    expect(out).toMatchObject({ status, body: { ok: false, error: code } });
    expect(out.body.message).toMatch(msg);
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('cos_propose_send to a session outside the roster is 404 unknown_session', async () => {
    await setup();
    await beginTurn('hello');
    h.fire(`${PREFIX}cos_propose_send`, { sessionId: 'ghost', text: 'hi' });
    expect(await call('cos_propose_send', { sessionId: 'ghost', text: 'hi' })).toMatchObject({ status: 404, body: { error: 'unknown_session' } });
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('after a read, a start card carries the defaults: headless, the Chief of Staff model, no folder', async () => {
    await setup();
    await beginTurn('please do something');
    h.fire('Read', { file_path: 'notes.txt' });
    const args = { project: 'acme', prompt: 'composed from a file' };
    h.fire(`${PREFIX}cos_propose_start`, args);
    const out = await call('cos_propose_start', args);
    expect(out.body.result).toMatchObject({ status: 'card' });
    const post = h.cos.posts.find((p) => p.id === out.body.result.cardId);
    expect(post).toMatchObject({ kind: 'start_card', card: { state: 'pending', mode: 'headless', model: 'haiku', folder: '', prompt: 'composed from a file', project: { id: 'p1', name: 'Acme' }, why: 'read_not_verbatim' } });
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('internalHandler', () => {
  const res = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const req = (remote, secret) => ({ socket: { remoteAddress: remote }, headers: { 'x-eve-internal': secret }, body: { tool: 'rm_rf', args: {}, meta: {} } });
  const cos = { settings: { enabled: true } };

  it('a non-loopback peer is 403 forbidden, before the secret is looked at', async () => {
    const r = res();
    await internalHandler(cos, 'sekret')(req('203.0.113.9', 'sekret'), r);
    expect(r.code).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it.each([['wrong', 'nope'], ['missing', undefined]])('a %s secret is 401 unauthorized', async (_what, secret) => {
    const r = res();
    await internalHandler(cos, 'sekret')(req('127.0.0.1', secret), r);
    expect(r.code).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('a loopback peer with the secret reaches the call checks (an unknown tool is 400)', async () => {
    const r = res();
    await internalHandler(cos, 'sekret')(req('127.0.0.1', 'sekret'), r);
    expect(r.code).toBe(400);
    expect(r.body.error).toBe('unknown_tool');
  });
});
