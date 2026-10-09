// eve#273: an errand (a session the Chief of Staff started or sent to) gets one "finished" post
// when its first turn ends idle. Driven through the relay frames the scoped reader delivers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChiefOfStaff } = require('../../chief-of-staff');

const reply = (o) => 'ok\n```json\n' + JSON.stringify(o) + '\n```';
const frame = (o) => Buffer.from(JSON.stringify(o));
const row = (id, state, extra = {}) => ({ id, name: `Agent ${id}`, projectId: 'p1', model: 'haiku', headless: true, attention: { state, since: '2026-01-01T00:00:00.000Z' }, ...extra });

// Real fs I/O is not driven by fake timers; yield to it until `ok` holds.
async function eventually(ok) {
  for (let i = 0; i < 500; i++) {
    if (await ok()) return;
    await fs.promises.stat(os.tmpdir());
  }
  throw new Error('condition never held');
}

let h;
const dirs = [];
beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  await h?.cos.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  h = null;
});

// `summaries` maps sessionId -> summary the model writes; absent ids get no model post.
function setup({ sessions, settings, projects, summaries = {}, startReply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-fin-'));
  dirs.push(dir);
  h = { list: sessions, sockets: [], log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
  h.model = {
    turn: jest.fn(async (text) => {
      if (!text.startsWith('Chief of Staff finished')) return { text: '', modelId: 'm' };
      const posts = Object.entries(summaries).map(([sessionId, summary]) => ({ sessionId, summary }));
      return { text: reply({ posts }), modelId: 'm' };
    }),
  };
  h.transport = {
    fetch: jest.fn(async (method, p, body) => {
      if (method === 'GET' && p === '/api/sessions') return { status: 200, data: { sessions: h.list } };
      if (method === 'POST' && p === '/api/chief-of-staff/messages') return { status: 202, data: {} };
      if (method === 'POST' && p === '/api/chief-of-staff/sessions') return { status: 201, data: startReply || { sessionId: 'n1', name: 'Build', mode: body.mode } };
      return { status: 404, data: {} };
    }),
    createWebSocket: jest.fn(() => { const ws = new EventEmitter(); ws.close = jest.fn(); h.sockets.push(ws); return ws; }),
  };
  h.cos = new ChiefOfStaff({
    relayTransport: h.transport,
    model: h.model,
    dataDir: dir,
    log: h.log,
    settings: { model: 'sonnet', ...(settings || {}) },
    listProjects: () => projects || [{ id: 'p1', name: 'Acme', path: '/tmp/acme' }],
    resolveProject: (id) => (id === 'p1' ? { id, name: 'Acme' } : null),
  });
  h.emit = (f) => h.sockets[h.sockets.length - 1].emit('message', frame(f));
  h.tick = (ms) => jest.advanceTimersByTimeAsync(ms);
  h.finished = () => h.cos.posts.filter((p) => p.kind === 'finished');
  h.alerts = () => h.cos.posts.filter((p) => p.kind === 'alert');
  h.finishedTurns = () => h.model.turn.mock.calls.filter((c) => c[0].startsWith('Chief of Staff finished'));
  // Resolves once every queued entry has been handled: the alert window, then the pump.
  h.settle = async () => { await h.tick(2100); await eventually(() => !h.cos.getStatus().busy); };
  h.turnEnds = (id, excerpt = 'Merged the branch.') => h.emit({ type: 'turn_done', sessionId: id, excerpt });
  h.state = (id, state) => h.emit({ type: 'session_state', sessionId: id, state });
  h.begin = async () => { h.cos.start(); h.sockets[0].emit('open'); await h.tick(0); };
  return h;
}

const startArgs = (mode = 'headless') => ({ projectId: 'p1', prompt: 'go', model: 'haiku', mode });

describe('one finished post per errand', () => {
  // C4
  it.each([
    ['a send', (cos) => cos._send('s1', 'merge it'), []],
    ['a headless start', (cos) => cos._startSession(startArgs()), [row('n1', 'running', { name: 'Build' })]],
  ])('%s: the first turn that ends idle posts name, project and summary', async (_what, act, extra) => {
    const id = extra.length ? 'n1' : 's1';
    setup({ sessions: [row('s1', 'running'), ...extra], summaries: { [id]: 'It merged the branch.\nTests pass.' } });
    await h.begin();
    await act(h.cos);
    h.turnEnds(id);
    h.state(id, 'idle');
    await eventually(() => h.finished().length === 1);
    expect(h.finished()[0]).toMatchObject({
      sessionId: id, label: id === 's1' ? 'Agent s1' : 'Build', projectName: 'Acme',
      summary: 'It merged the branch.\nTests pass.', source: 'model',
    });
    expect(h.finishedTurns()).toHaveLength(1);
  });

  // C4
  it('an idle before the turn ends posts nothing, and a later turn posts nothing more', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')], summaries: { s1: 'Done.', s2: 'Done.' } });
    await h.begin();
    await h.cos._send('s1', 'merge it');
    await h.cos._send('s2', 'merge it');
    h.state('s1', 'idle'); // idle from Launched, before any turn
    await h.settle();
    expect(h.finished()).toHaveLength(0);

    h.turnEnds('s1');
    h.state('s1', 'idle');
    await eventually(() => h.finished().length === 1);
    h.state('s1', 'running');
    h.turnEnds('s1', 'Second turn.');
    h.state('s1', 'idle');
    // s2's errand is queued behind anything s1 would have queued, so its post closes the window.
    h.turnEnds('s2');
    h.state('s2', 'idle');
    await eventually(() => h.finished().length === 2);
    expect(h.finished().map((p) => p.sessionId)).toEqual(['s1', 's2']);
  });

  // C4
  it('a terminal start is not an errand', async () => {
    setup({ sessions: [row('s1', 'running'), row('n1', 'running', { headless: false })], summaries: { s1: 'Done.', n1: 'Done.' }, startReply: { sessionId: 'n1', name: 'Term', mode: 'terminal' } });
    await h.begin();
    await h.cos._startSession(startArgs('terminal'));
    await h.cos._send('s1', 'go');
    h.turnEnds('n1');
    h.state('n1', 'idle');
    h.turnEnds('s1');
    h.state('s1', 'idle');
    await eventually(() => h.finished().length === 1);
    expect(h.finished().map((p) => p.sessionId)).toEqual(['s1']);
  });

  // C5
  it('a finished entry queued behind a person turn still posts once when the session runs again', async () => {
    setup({ sessions: [row('s1', 'running')], summaries: { s1: 'Done.' } });
    let release;
    const held = new Promise((r) => { release = r; });
    const inner = h.model.turn.getMockImplementation();
    h.model.turn.mockImplementation((text, opts) => (text.startsWith('Chief of Staff person') ? held.then(() => ({ text: 'ok', modelId: 'm' })) : inner(text, opts)));
    await h.begin();
    await h.cos._send('s1', 'go');
    h.cos.submitPerson('hello there');
    await eventually(() => h.model.turn.mock.calls.length === 1); // the person turn is in flight
    h.turnEnds('s1');
    h.state('s1', 'idle');
    h.state('s1', 'running'); // a later send moved the row off idle before the queue drained
    release();
    await eventually(() => h.finished().length === 1);
    await eventually(() => !h.cos.getStatus().busy);
    expect(h.finished().map((p) => p.sessionId)).toEqual(['s1']);
    expect(h.finishedTurns()).toHaveLength(1);
  });

  // C8
  it('a session the Chief of Staff never started or sent to gets no finished post', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')], summaries: { s1: 'Done.', s2: 'Done.' } });
    await h.begin();
    await h.cos._send('s1', 'go');
    h.turnEnds('s2');
    h.state('s2', 'idle');
    h.turnEnds('s1');
    h.state('s1', 'idle');
    await eventually(() => h.finished().length === 1);
    expect(h.finished().map((p) => p.sessionId)).toEqual(['s1']);
  });
});

describe('an errand that needs the person gets the alert and no finished post', () => {
  // C7
  it.each([
    ['asking after the turn', 'Done.', 'asking'],
    ['stalled after the turn', 'Done.', 'stalled'],
    ['errored after the turn', 'Done.', 'errored'],
    ['asking before the turn ends', null, 'asking'],
    ['stalled before the turn ends', null, 'stalled'],
    ['errored before the turn ends', null, 'errored'],
  ])('%s', async (_what, excerpt, state) => {
    setup({ sessions: [row('s1', 'running')], summaries: { s1: 'Done.' } });
    await h.begin();
    await h.cos._send('s1', 'go');
    if (excerpt) h.turnEnds('s1', excerpt);
    h.state('s1', state);
    await h.settle();
    expect(h.alerts()).toHaveLength(1);
    expect(h.alerts()[0].card).toMatchObject({ sessionId: 's1', state });
    // Recovering and ending a later turn is no longer the errand's turn.
    h.state('s1', 'running');
    h.turnEnds('s1', 'Later.');
    h.state('s1', 'idle');
    await h.settle();
    expect(h.finished()).toHaveLength(0);
  });

  // C7
  it('a turn that ends on a question gets the question alert and no finished post', async () => {
    setup({ sessions: [row('s1', 'running')], summaries: { s1: 'Done.' } });
    await h.begin();
    await h.cos._send('s1', 'go');
    h.turnEnds('s1', 'Shall I merge it?');
    h.state('s1', 'idle');
    await h.settle();
    expect(h.alerts().map((p) => p.card.state)).toEqual(['question']);
    expect(h.finished()).toHaveLength(0);
  });
});

describe('models', () => {
  const finishAfterSend = async () => {
    await h.begin();
    await h.cos._send('s1', 'go');
    h.turnEnds('s1');
    h.state('s1', 'idle');
    await eventually(() => h.finished().length === 1);
  };
  const modelOf = (call) => call[1].model;

  // C1
  it('the finished turn and an alert turn run on summaryModel', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')], settings: { model: 'sonnet', summaryModel: 'haiku-x' }, summaries: { s1: 'Done.' } });
    await finishAfterSend();
    h.state('s2', 'errored');
    await h.settle();
    expect(h.model.turn.mock.calls.map(modelOf)).toEqual(['haiku-x', 'haiku-x']);
  });

  // C2
  it('summaryModel defaults to haiku when the setting is absent', async () => {
    setup({ sessions: [row('s1', 'running')], settings: { model: 'sonnet' }, summaries: { s1: 'Done.' } });
    await finishAfterSend();
    expect(modelOf(h.finishedTurns()[0])).toBe('haiku');
  });

  // C3
  it('a person turn keeps using model', async () => {
    setup({ sessions: [row('s1', 'running')], settings: { model: 'sonnet', summaryModel: 'haiku-x' } });
    await h.begin();
    h.cos.submitPerson('hello there');
    await eventually(() => h.model.turn.mock.calls.length > 0 && !h.cos.getStatus().busy);
    expect(h.model.turn.mock.calls[0][0].startsWith('Chief of Staff person')).toBe(true);
    expect(modelOf(h.model.turn.mock.calls[0])).toBe('sonnet');
  });

  // C1
  it('a project that does not allow summaryModel runs wake turns on model and warns once', async () => {
    setup({
      sessions: [row('s1', 'running'), row('s2', 'running')], settings: { model: 'sonnet', summaryModel: 'haiku-x' },
      projects: [{ id: 'p1', name: 'Acme', path: '/tmp/acme', allowedModels: ['sonnet'] }], summaries: { s1: 'Done.' },
    });
    await finishAfterSend();
    h.state('s2', 'errored');
    await h.settle();
    expect(h.model.turn.mock.calls.map(modelOf)).toEqual(['sonnet', 'sonnet']);
    const warns = h.log.warn.mock.calls.map((c) => c[0]).filter((m) => /summary model/.test(m));
    expect(warns).toEqual(['Chief of Staff summary model haiku-x is not allowed in Acme; wake turns use sonnet']);
  });
});

describe('daily model-call limit', () => {
  // C9
  it('at the limit the finished post is a template of the last words and no model turn runs', async () => {
    setup({ sessions: [row('s1', 'running')], settings: { dailyModelCalls: 1 } });
    h.model.turn.mockImplementation(async () => {
      if (!h.cos.countCall()) throw Object.assign(new Error('limit'), { code: 'limit' });
      return { text: '', modelId: 'm' };
    });
    await h.begin();
    expect(h.cos.countCall()).toBe(true); // the day's only call is spent
    await h.cos._send('s1', 'go');
    h.turnEnds('s1', 'Merged the branch and tagged it.');
    h.state('s1', 'idle');
    await eventually(() => h.finished().length === 1);
    expect(h.model.turn).not.toHaveBeenCalled();
    expect(h.finished()[0]).toMatchObject({ source: 'template', summary: 'Merged the branch and tagged it.' });
  });
});

describe('the finished log line', () => {
  const SECRET = 'EXCERPT-SECRET-7731';
  // C10
  it.each([
    ['model', { 'abcdefgh-1234': `Summary ${SECRET}` }],
    ['template', {}],
  ])('writes one line with the id prefix and source %s, and no text from the agent', async (source, summaries) => {
    setup({ sessions: [row('abcdefgh-1234', 'running')], summaries });
    await h.begin();
    await h.cos._send('abcdefgh-1234', 'go');
    h.turnEnds('abcdefgh-1234', `All done ${SECRET}`);
    h.state('abcdefgh-1234', 'idle');
    await eventually(() => h.finished().length === 1);
    expect(h.finished()[0].source).toBe(source);
    const lines = h.log.info.mock.calls.map((c) => c[0]).filter((m) => /finished post/.test(m));
    expect(lines).toEqual([`Chief of Staff finished post: session abcdefgh source ${source}`]);
    const everything = [...h.log.info.mock.calls, ...h.log.warn.mock.calls, ...h.log.error.mock.calls].flat().join('\n');
    expect(everything).not.toContain(SECRET);
  });
});
