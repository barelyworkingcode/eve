const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChiefOfStaff, parseChiefOfStaffSettings } = require('../../chief-of-staff');

const wsFrame = (o) => Buffer.from(JSON.stringify(o));
const reply = (o) => 'ok\n```json\n' + JSON.stringify(o) + '\n```';

function makeHarness({ sessions, settings, model, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cos-unit-'));
  const h = { dir, list: sessions || [], sockets: [], calls: [], post: { status: 202, data: { sessionId: 's1' } } };
  h.transport = {
    fetch: jest.fn(async (method, p, body, opts) => {
      h.calls.push({ method, path: p, body, opts });
      if (method === 'GET' && p === '/api/sessions') return { status: 200, data: { sessions: h.list } };
      if (method === 'POST' && p === '/api/chief-of-staff/messages') return h.post;
      return { status: 404, data: {} };
    }),
    createWebSocket: jest.fn((p, opts) => {
      const ws = new EventEmitter();
      ws.close = jest.fn(() => ws.emit('close'));
      ws.opts = opts;
      h.sockets.push(ws);
      return ws;
    }),
  };
  h.model = model || { turn: jest.fn(async () => ({ text: '', modelId: 'claude-haiku-4-5-20251001' })) };
  h.cos = new ChiefOfStaff({
    relayTransport: h.transport,
    model: h.model,
    dataDir: dir,
    settings: { model: 'haiku', ...(settings || {}) },
    listProjects: () => [{ id: 'p1', name: 'Acme', path: '/tmp/acme' }],
    resolveProject: (id) => (id === 'p1' ? { id, name: 'Acme' } : null),
  });
  h.listCalls = () => h.calls.filter((c) => c.path === '/api/sessions').length;
  h.sends = () => h.calls.filter((c) => c.method === 'POST');
  h.emit = (frame) => h.sockets[h.sockets.length - 1].emit('message', wsFrame(frame));
  h.tick = (ms) => jest.advanceTimersByTimeAsync(ms);
  h.start = async () => {
    h.cos.start();
    h.sockets[h.sockets.length - 1].emit('open');
    await h.tick(0);
  };
  h.alerts = () => h.cos.posts.filter((p) => p.kind === 'alert');
  h.frames = [];
  h.sub = { send: (j) => h.frames.push(JSON.parse(j)), readyState: 1, once: () => {} };
  return h;
}

const row = (id, state, extra = {}) => ({ id, name: `Agent ${id}`, projectId: 'p1', model: 'claude-haiku-4-5-20251001', headless: false, attention: state ? { state, since: '2026-01-01T00:00:00.000Z' } : undefined, ...extra });

// Real fs I/O is not driven by fake timers; yield to it until `ok` holds.
async function eventually(ok) {
  for (let i = 0; i < 500; i++) {
    if (await ok()) return;
    await fs.promises.stat(os.tmpdir());
  }
  throw new Error('condition never held');
}
const readJson = async (f) => { try { return JSON.parse(await fs.promises.readFile(f, 'utf8')); } catch { return null; } };

const dirs = [];
let h;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  h?.cos.stop();
  for (const d of dirs.splice(0)) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  h = null;
});
function setup(opts) { h = makeHarness(opts); dirs.push(h.dir); return h; }

describe('what makes the thread post', () => {
  it.each([
    ['asking', true], ['errored', true], ['stalled', true],
    ['idle', false], ['running', false], ['starting', false], ['ended', false],
  ])('a session entering %s -> post: %s', async (state, posts) => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state, since: '2026-01-01T00:01:00.000Z' });
    await h.tick(2100);
    expect(h.alerts()).toHaveLength(posts ? 1 : 0);
    if (posts) {
      const card = h.alerts()[0].card;
      expect(card).toMatchObject({ sessionId: 's1', state, label: 'Agent s1', project: 'Acme' });
    }
  });

  it('a turn_done that ends with a question posts, one that does not stays silent', async () => {
    setup({ sessions: [row('s1', 'idle'), row('s2', 'idle')] });
    await h.start();
    h.emit({ type: 'turn_done', sessionId: 's1', excerpt: 'Shall I merge it?', at: '2026-01-01T00:01:00.000Z' });
    h.emit({ type: 'turn_done', sessionId: 's2', excerpt: 'Merged it.', at: '2026-01-01T00:01:00.000Z' });
    await h.tick(2100);
    expect(h.alerts().map((p) => p.card.sessionId)).toEqual(['s1']);
    expect(h.alerts()[0].card).toMatchObject({ state: 'question', quote: 'Shall I merge it?' });
    expect(h.alerts()[0].card.actions).toEqual(['answer', 'drop_in', 'open']);
  });

  it('errored and stalled cards offer no Answer', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'errored' });
    await h.tick(2100);
    expect(h.alerts()[0].card.actions).toEqual(['drop_in', 'open']);
  });

  it('states seen at start or reconnect never post, and a repeat of the same state does not', async () => {
    setup({ sessions: [row('s1', 'asking')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    await h.tick(3000);
    expect(h.cos.posts).toHaveLength(0);

    h.list = [row('s1', 'errored')];
    h.sockets[0].emit('close');
    await h.tick(2100);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].emit('open');
    await h.tick(3000);
    expect(h.cos.posts).toHaveLength(0);
  });

  it('drops a trigger when the session has moved on before the batch runs', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    await h.tick(500);
    h.emit({ type: 'session_state', sessionId: 's1', state: 'running' });
    await h.tick(3000);
    expect(h.cos.posts).toHaveLength(0);
    expect(h.model.turn).not.toHaveBeenCalled();
  });

  it('drops a question when the session is no longer idle at batch time', async () => {
    setup({ sessions: [row('s1', 'idle')] });
    await h.start();
    h.emit({ type: 'turn_done', sessionId: 's1', excerpt: 'Ready?' });
    await h.tick(500);
    h.emit({ type: 'session_state', sessionId: 's1', state: 'running' });
    await h.tick(3000);
    expect(h.cos.posts).toHaveLength(0);
  });

  it('forgets a session that ended', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    h.emit({ type: 'session_ended', sessionId: 's1' });
    await h.tick(3000);
    expect(h.cos.posts).toHaveLength(0);
  });
});

describe('batching', () => {
  it('coalesces repeats for one session into one post and one model turn', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'errored' });
    await h.tick(300);
    h.emit({ type: 'session_state', sessionId: 's1', state: 'stalled' });
    await h.tick(2100);
    expect(h.model.turn).toHaveBeenCalledTimes(1);
    expect(h.alerts()).toHaveLength(1);
    expect(h.alerts()[0].card.state).toBe('stalled');
  });

  it('waits for 2 s of quiet, not 2 s from the first event', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'errored' });
    await h.tick(1500);
    h.emit({ type: 'session_state', sessionId: 's2', state: 'errored' });
    await h.tick(1500);
    expect(h.model.turn).not.toHaveBeenCalled();
    await h.tick(600);
    expect(h.model.turn).toHaveBeenCalledTimes(1);
    expect(h.alerts()).toHaveLength(2);
  });

  it('runs a batch after 10 s even when events keep arriving', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
    setup({ sessions: ids.map((id) => row(id, 'running')) });
    await h.start();
    for (const id of ids) {
      h.emit({ type: 'session_state', sessionId: id, state: 'errored' });
      await h.tick(1400);
    }
    // 8 events, last at 9.8 s: quiet alone would fire at 11.8 s.
    await h.tick(300);
    expect(h.model.turn).toHaveBeenCalledTimes(1);
  });

  it('puts at most 10 sessions in one model turn', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, '0')}`);
    setup({ sessions: ids.map((id) => row(id, 'running')) });
    await h.start();
    for (const id of ids) h.emit({ type: 'session_state', sessionId: id, state: 'errored' });
    await h.tick(2100);
    await h.tick(2100);
    expect(h.model.turn).toHaveBeenCalledTimes(2);
    const region = (t) => JSON.parse(/<agent_data>\n([\s\S]*)\n<\/agent_data>/.exec(t)[1]);
    expect(region(h.model.turn.mock.calls[0][0])).toHaveLength(10);
    expect(region(h.model.turn.mock.calls[1][0])).toHaveLength(2);
    expect(h.alerts()).toHaveLength(12);
  });

  it('uses a model-written post when the reply parses, and a template when it does not', async () => {
    const model = { turn: jest.fn(async () => ({ text: reply({ posts: [{ sessionId: 's1', headline: 'Board agent needs a yes', body: 'Merge?' }] }), modelId: 'claude-haiku-4-5-20251001' })) };
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')], model });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    h.emit({ type: 'session_state', sessionId: 's2', state: 'errored' });
    await h.tick(2100);
    const byId = Object.fromEntries(h.alerts().map((p) => [p.card.sessionId, p]));
    expect(byId.s1).toMatchObject({ headline: 'Board agent needs a yes', byModel: true });
    expect(byId.s2).toMatchObject({ headline: 'Agent s2 stopped with an error', byModel: false });
    expect(h.cos.getStatus().model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('cos_status', () => {
  it('reports busy while work is queued or in flight, and idle again after', async () => {
    let release;
    const model = { turn: jest.fn(() => new Promise((r) => { release = () => r({ text: '', modelId: 'm' }); })) };
    setup({ sessions: [row('s1', 'running')], model });
    await h.start();
    h.cos.subscribe(h.sub);
    expect(h.frames[0].type).toBe('cos_snapshot');
    expect(h.frames[0].status.busy).toBe(false);

    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    await h.tick(2100);
    const busy = () => h.frames.filter((f) => f.type === 'cos_status').map((f) => f.status.busy);
    expect(busy()).toContain(true);
    expect(busy()[busy().length - 1]).toBe(true);
    release();
    await h.tick(10);
    expect(busy()[busy().length - 1]).toBe(false);
    const posts = h.frames.filter((f) => f.type === 'cos_post');
    expect(posts).toHaveLength(1);
    expect(posts[0].post.card.sessionId).toBe('s1');
  });

  it('counts watching and need-you from the roster', async () => {
    setup({ sessions: [row('s1', 'asking'), row('s2', 'running'), row('s3', 'stalled')] });
    await h.start();
    expect(h.cos.getStatus()).toMatchObject({ watching: 3, needYou: 2, off: null });
  });
});

describe('roster and the scoped reader', () => {
  it('reads and listens only with the chief-of-staff scope', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    expect(h.transport.createWebSocket).toHaveBeenCalledWith('/ws', { scope: 'chief-of-staff' });
    expect(h.calls.filter((c) => c.path === '/api/sessions').every((c) => c.opts.scope === 'chief-of-staff')).toBe(true);
  });

  it('refreshes the list once for an unknown id, at most every 5 s, then drops it', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    expect(h.listCalls()).toBe(1);
    h.list = [row('s1', 'running'), row('s9', 'running')];
    h.emit({ type: 'session_state', sessionId: 's9', state: 'asking' });
    await h.tick(0);
    expect(h.listCalls()).toBe(2);
    await h.tick(2100);
    expect(h.alerts().map((p) => p.card.sessionId)).toEqual(['s9']);

    await h.tick(1000);
    h.emit({ type: 'session_state', sessionId: 'ghost', state: 'asking' });
    await h.tick(1000);
    expect(h.listCalls()).toBe(2);
    await h.tick(4000);
    expect(h.listCalls()).toBe(3);
    await h.tick(5000);
    expect(h.listCalls()).toBe(3);
    expect(h.alerts()).toHaveLength(1);
  });

  it('ignores its own model session', async () => {
    let onSessionId;
    const cos = makeHarness({ sessions: [row('s1', 'running')] });
    dirs.push(cos.dir);
    h = cos;
    h.cos = new ChiefOfStaff({
      relayTransport: h.transport, dataDir: h.dir, settings: { model: 'haiku' },
      listProjects: () => [{ id: 'p1', name: 'Acme', path: '/tmp/acme' }],
      createModel: (o) => { onSessionId = o.onSessionId; return h.model; },
    });
    await h.start();
    onSessionId('own1');
    const before = h.listCalls();
    h.emit({ type: 'session_state', sessionId: 'own1', state: 'asking' });
    await h.tick(3000);
    expect(h.listCalls()).toBe(before);
    expect(h.cos.posts).toHaveLength(0);
  });

  it('reconnects with backoff after the socket closes', async () => {
    setup({ sessions: [] });
    await h.start();
    h.sockets[0].emit('close');
    await h.tick(1900);
    expect(h.sockets).toHaveLength(1);
    await h.tick(200);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].emit('close');
    await h.tick(3900);
    expect(h.sockets).toHaveLength(2);
    await h.tick(200);
    expect(h.sockets).toHaveLength(3);
  });

  it('turns itself off, reading nothing, when disabled in settings', async () => {
    setup({ sessions: [row('s1', 'running')], settings: { enabled: false } });
    h.cos.start();
    expect(h.transport.createWebSocket).not.toHaveBeenCalled();
    expect(h.transport.fetch).not.toHaveBeenCalled();
    expect(h.cos.getStatus().off.reason).toBe('disabled');
  });
});

describe('daily model-call limit', () => {
  // The real model asks countCall() before each send; a fake that does the same.
  function limitedModel(h2) {
    return {
      turn: jest.fn(async () => {
        if (!h2.cos.countCall()) throw Object.assign(new Error('limit'), { code: 'limit' });
        return { text: '', modelId: 'claude-haiku-4-5-20251001' };
      }),
    };
  }

  async function trip(id, state) {
    h.emit({ type: 'session_state', sessionId: id, state });
    await h.tick(2100);
  }

  it('stops calling the model at the limit, posts templates, and says so once', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running'), row('s3', 'running')], settings: { dailyModelCalls: 1 } });
    h.model = limitedModel(h);
    h.cos.model = h.model;
    await h.start();
    await trip('s1', 'errored');
    await trip('s2', 'errored');
    await trip('s3', 'errored');
    expect(h.model.turn).toHaveBeenCalledTimes(1);
    expect(h.alerts()).toHaveLength(3);
    const notices = h.cos.posts.filter((p) => p.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("today's limit of 1 model calls");
    expect(h.cos.getStatus().calls).toEqual({ used: 1, max: 1 });
  });

  it('refuses a person message at the limit without sending anything', async () => {
    setup({ sessions: [row('s1', 'running')], settings: { dailyModelCalls: 1 } });
    h.model = limitedModel(h);
    h.cos.model = h.model;
    await h.start();
    await trip('s1', 'errored');
    h.cos.submitPerson('tell Agent s1 to stop');
    await h.tick(10);
    expect(h.model.turn).toHaveBeenCalledTimes(1);
    expect(h.sends()).toHaveLength(0);
    expect(h.cos.posts[h.cos.posts.length - 1].body).toBe("I've reached today's limit, so I can't send until tomorrow.");
  });

  it('keeps the count across a restart', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')], settings: { dailyModelCalls: 1 } });
    h.model = limitedModel(h);
    h.cos.model = h.model;
    await h.start();
    await trip('s1', 'errored');
    await eventually(async () => (await readJson(path.join(h.dir, 'chief-of-staff-state.json')))?.calls === 1);
    const dir = h.dir;
    expect((await fs.promises.stat(path.join(dir, 'chief-of-staff-state.json'))).mode & 0o777).toBe(0o600);
    h.cos.stop();

    const second = makeHarness({ sessions: [row('s2', 'running')], settings: { dailyModelCalls: 1 }, dataDir: dir });
    h = second;
    h.model = limitedModel(h);
    h.cos.model = h.model;
    await h.start();
    await trip('s2', 'errored');
    expect(h.model.turn).not.toHaveBeenCalled();
    expect(h.alerts()).toHaveLength(2);
  });
});

describe('sending on the person\'s word', () => {
  const sendReply = (sessionId, text) => reply({ reply: 'On it.', send: { sessionId, text } });
  const person = async (text) => { h.cos.submitPerson(text); await h.tick(10); };

  it('sends one scoped message with no origin in the body, then posts "sent"', async () => {
    const model = { turn: jest.fn(async () => ({ text: sendReply('s1', 'merge after CI'), modelId: 'm' })) };
    setup({ sessions: [row('s1', 'running')], model });
    await h.start();
    await person('tell Agent s1 to merge after CI');
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]).toMatchObject({ path: '/api/chief-of-staff/messages', body: { sessionId: 's1', text: 'merge after CI' }, opts: { scope: 'chief-of-staff' } });
    expect(Object.keys(h.sends()[0].body).sort()).toEqual(['sessionId', 'text']);
    const sent = h.cos.posts.find((p) => p.kind === 'sent');
    expect(sent).toMatchObject({ text: 'merge after CI', sessionId: 's1', label: 'Agent s1', origin: 'chief-of-staff' });
    expect(h.cos.posts.map((p) => p.kind)).toEqual(['person', 'reply', 'sent']);
  });

  it('does not send to a session outside the roster', async () => {
    const model = { turn: jest.fn(async () => ({ text: sendReply('elsewhere', 'do it'), modelId: 'm' })) };
    setup({ sessions: [row('s1', 'running')], model });
    await h.start();
    await person('tell the other one to do it');
    expect(h.sends()).toHaveLength(0);
    expect(h.cos.posts.some((p) => p.kind === 'sent')).toBe(false);
  });

  it('never honours a send in a wake reply', async () => {
    const model = { turn: jest.fn(async () => ({ text: reply({ posts: [{ sessionId: 's1', headline: 'H', body: 'B' }], send: { sessionId: 's1', text: 'rm -rf' } }), modelId: 'm' })) };
    setup({ sessions: [row('s1', 'running')], model });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    await h.tick(2100);
    expect(h.sends()).toHaveLength(0);
  });

  it('refetches the roster before the person turn', async () => {
    const model = { turn: jest.fn(async () => ({ text: sendReply('s2', 'hi'), modelId: 'm' })) };
    setup({ sessions: [row('s1', 'running')], model });
    await h.start();
    h.list = [row('s1', 'running'), row('s2', 'running')];
    await person('tell Agent s2 hi');
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0].body.sessionId).toBe('s2');
  });

  it.each([
    [{ status: 404, data: { error: 'session_not_found' } }, 'That session is gone.'],
    [{ status: 409, data: { error: 'already_processing' } }, 'Agent s1 is busy. Try again when it finishes.'],
    [{ status: 409, data: { error: 'resume_required' } }, "Agent s1 isn't running. Open it to resume it."],
    [{ status: 409, data: { error: 'dropped_in' } }, "You've dropped in to Agent s1, so I didn't send."],
    [{ status: 503, data: { error: 'audit_unavailable' } }, "Relay's audit log is off, so I can't send."],
    [{ status: 400, data: { error: 'weird_code' } }, 'Relay refused the send (weird_code).'],
  ])('relay answer %j -> thread line', async (answer, line) => {
    const model = { turn: jest.fn(async () => ({ text: sendReply('s1', 'go'), modelId: 'm' })) };
    setup({ sessions: [row('s1', 'running')], model });
    h.post = answer;
    await h.start();
    await person('tell Agent s1 go');
    expect(h.sends()).toHaveLength(1);
    const failed = h.cos.posts.find((p) => p.kind === 'send_failed');
    expect(failed).toMatchObject({ sessionId: 's1', label: 'Agent s1', error: line });
    expect(h.cos.posts.some((p) => p.kind === 'sent')).toBe(false);
  });

  it('does not retry a failed send', async () => {
    const model = { turn: jest.fn(async () => ({ text: sendReply('s1', 'go'), modelId: 'm' })) };
    setup({ sessions: [row('s1', 'running')], model });
    h.post = { status: 503, data: { error: 'audit_unavailable' } };
    await h.start();
    await person('tell Agent s1 go');
    await h.tick(60000);
    expect(h.sends()).toHaveLength(1);
  });

  it.each(['', '   ', 'x'.repeat(2001)])('rejects a person message of length %#', (text) => {
    setup({ sessions: [] });
    expect(() => h.cos.submitPerson(text)).toThrow();
    expect(h.cos.posts).toHaveLength(0);
  });
});

describe('files', () => {
  it('writes the posts file mode 0600', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.start();
    h.emit({ type: 'session_state', sessionId: 's1', state: 'asking' });
    await h.tick(2100);
    const posts = path.join(h.dir, 'chief-of-staff.jsonl');
    await eventually(async () => {
      try { await fs.promises.stat(posts); return true; } catch { return false; }
    });
    expect((await fs.promises.stat(posts)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse((await fs.promises.readFile(posts, 'utf8')).trim().split('\n')[0]);
    expect(saved).toMatchObject({ v: 1, kind: 'alert' });
    expect(saved.id).toMatch(/^p-[0-9a-f]{12}$/);
  });
});

describe('settings.chiefOfStaff', () => {
  it('uses defaults when absent', () => {
    expect(parseChiefOfStaffSettings(undefined)).toEqual({ enabled: true, model: 'sonnet', projectId: null, dailyModelCalls: 100 });
  });

  it.each([
    [{ enabled: 'no' }, 'enabled'],
    [{ model: 5 }, 'model'],
    [{ projectId: 7 }, 'projectId'],
    [{ dailyModelCalls: 0 }, 'dailyModelCalls'],
    [{ dailyModelCalls: 10001 }, 'dailyModelCalls'],
    [{ dailyModelCalls: 2.5 }, 'dailyModelCalls'],
    [{ dailyModelCalls: '40' }, 'dailyModelCalls'],
  ])('%j warns naming %s and keeps the default', (raw, key) => {
    const log = { warn: jest.fn() };
    const got = parseChiefOfStaffSettings(raw, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain(key);
    expect(got[key]).toEqual(parseChiefOfStaffSettings(undefined)[key]);
  });

  it('accepts valid values', () => {
    expect(parseChiefOfStaffSettings({ enabled: false, model: 'haiku', projectId: 'p1', dailyModelCalls: 40 })).toEqual({ enabled: false, model: 'haiku', projectId: 'p1', dailyModelCalls: 40 });
  });
});
