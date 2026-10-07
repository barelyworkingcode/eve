const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChiefOfStaff, resolveChiefOfStaffSettings } = require('../../chief-of-staff');

const FILE = { enabled: true, model: 'haiku', projectId: 'pf', dailyModelCalls: 50 };
const RELAY_SET = { projectId: 'pr', model: 'sonnet', dailyModelCalls: 10 };
const configured = (extra = {}) => ({ status: 200, data: { configured: true, ...RELAY_SET, ...extra } });
const KEEP = { settings: null, source: null };
const NOT_SET = { status: 200, data: { configured: false } };

describe('resolveChiefOfStaffSettings', () => {
  it.each([
    ['2xx configured:true replaces the three values and reports relay', configured(), { settings: { ...FILE, ...RELAY_SET }, source: 'relay' }],
    ['2xx configured:false uses the file', NOT_SET, { settings: FILE, source: 'settings.json' }],
    ['404 (an older relay) uses the file', { status: 404, data: null }, { settings: FILE, source: 'settings.json' }],
    ['a 500 keeps what was in use', { status: 500, data: {} }, KEEP],
    ['a 401 keeps what was in use', { status: 401, data: {} }, KEEP],
    ['a network error keeps what was in use', { error: 'ECONNREFUSED' }, KEEP],
    ['a null body keeps what was in use', { status: 200, data: null }, KEEP],
    ['a text body keeps what was in use', { status: 200, data: 'oops' }, KEEP],
    ['a body without configured keeps what was in use', { status: 200, data: {} }, KEEP],
  ])('%s', (_what, answer, expected) => {
    expect(resolveChiefOfStaffSettings(FILE, 'settings.json', answer, { warn: jest.fn() })).toEqual(expected);
  });

  it('reports the defaults as the source when the file has no block', () => {
    expect(resolveChiefOfStaffSettings(FILE, 'defaults', NOT_SET, null)).toEqual({ settings: FILE, source: 'defaults' });
  });

  it('takes enabled from the file even when relay is set', () => {
    const off = { ...FILE, enabled: false };
    expect(resolveChiefOfStaffSettings(off, 'settings.json', configured(), null).settings).toEqual({ ...off, ...RELAY_SET });
  });

  it('uses the default for a bad relay value, keeps the good ones, and warns with a relay: prefix', () => {
    const log = { warn: jest.fn() };
    const out = resolveChiefOfStaffSettings(FILE, 'settings.json', configured({ model: '', dailyModelCalls: 0 }), log);
    expect(out).toEqual({ settings: { ...FILE, projectId: 'pr', model: 'sonnet', dailyModelCalls: 100 }, source: 'relay' });
    const lines = log.warn.mock.calls.map((c) => c[0]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('relay: chiefOfStaff.'))).toBe(true);
    expect(lines.some((l) => l.includes('chiefOfStaff.model'))).toBe(true);
    expect(lines.some((l) => l.includes('chiefOfStaff.dailyModelCalls'))).toBe(true);
  });
});

// ChiefOfStaff through its constructor options. readRelayConfig returns promises the test settles by hand.
const dirs = [];
let cos;
afterEach(async () => {
  await cos?.stop();
  cos = null;
  for (const d of dirs.splice(0)) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
});

// Real fs I/O is not driven by fake timers; yield to it until `ok` holds.
async function eventually(ok) {
  for (let i = 0; i < 500; i++) {
    if (await ok()) return;
    await fs.promises.stat(os.tmpdir());
  }
  throw new Error('condition never held');
}

function build({ file = FILE, fileSource = 'settings.json', projects } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-cfg-'));
  dirs.push(dir);
  const h = { pending: [], infos: [], warns: [], projects: projects || [{ id: 'pf', name: 'File', path: '/tmp/f' }], sockets: [], sessionListCalls: 0 };
  h.readRelayConfig = jest.fn(() => new Promise((resolve, reject) => h.pending.push({ resolve, reject })));
  h.refreshProjects = jest.fn(async () => {});
  h.model = { turn: jest.fn(async () => ({ text: 'ok', modelId: 'claude-haiku-4-5-20251001' })) };
  h.log = { info: (m) => h.infos.push(m), warn: (m) => h.warns.push(m), error: () => {}, debug: () => {} };
  h.transport = {
    fetch: jest.fn(async (method, p) => {
      if (method === 'GET' && p === '/api/sessions') { h.sessionListCalls++; return { status: 200, data: { sessions: [] } }; }
      return { status: 404, data: {} };
    }),
    createWebSocket: jest.fn(() => {
      const ws = new EventEmitter();
      ws.close = jest.fn(() => ws.emit('close'));
      h.sockets.push(ws);
      return ws;
    }),
  };
  cos = new ChiefOfStaff({
    relayTransport: h.transport,
    model: h.model,
    dataDir: dir,
    log: h.log,
    settings: file,
    fileSource,
    listProjects: () => h.projects,
    resolveProject: () => null,
    readRelayConfig: h.readRelayConfig,
    refreshProjects: h.refreshProjects,
  });
  h.cos = cos;
  // Settles the oldest unanswered relay read and waits until a later one exists or the infos settle.
  h.answer = async (value) => {
    await eventually(() => h.pending.length > 0);
    const p = h.pending.shift();
    if (value instanceof Error) p.reject(value); else p.resolve(value);
  };
  // Starts, settles the first read and waits for its log line, so the next turn makes a read of its own.
  h.begin = async (value) => {
    cos.start();
    await h.answer(value);
    await eventually(() => h.infos.length + h.warns.length > 0);
    await fs.promises.stat(os.tmpdir());
  };
  // Sends a person message and waits for the model turn it causes; answers the turn's relay read first.
  h.turn = async (value, n) => {
    cos.submitPerson('hello');
    await h.answer(value);
    await eventually(() => h.model.turn.mock.calls.length >= n);
    return h.model.turn.mock.calls[n - 1];
  };
  return h;
}

const CONFIG_LINE = /^Chief of Staff config from /;
const configLines = (h) => h.infos.filter((l) => CONFIG_LINE.test(l));

beforeEach(() => jest.useFakeTimers());

describe('the setting follows relay at each model turn', () => {
  it('a turn uses the project and model relay holds now, with no restart', async () => {
    const h = build();
    await h.begin(NOT_SET);
    const [, first] = await h.turn(NOT_SET, 1);
    expect(first).toMatchObject({ projectId: 'pf', model: 'haiku' });
    h.projects.push({ id: 'pr', name: 'Relay', path: '/tmp/r' });
    const [, second] = await h.turn(configured(), 2);
    expect(second).toMatchObject({ projectId: 'pr', model: 'sonnet' });
  });

  it('while relay does not answer, the next turn keeps the setting it last used', async () => {
    const h = build({ projects: [{ id: 'pr', name: 'Relay', path: '/tmp/r' }] });
    await h.begin(configured());
    await h.turn({ status: 503, data: {} }, 1);
    expect(h.model.turn.mock.calls[0][1]).toMatchObject({ projectId: 'pr', model: 'sonnet' });
    await h.turn({ error: 'ECONNREFUSED' }, 2);
    expect(h.model.turn.mock.calls[1][1]).toMatchObject({ projectId: 'pr', model: 'sonnet' });
  });

  it('when relay is no longer set, the turn returns to the file settings', async () => {
    const h = build({ projects: [{ id: 'pr', name: 'Relay', path: '/tmp/r' }, { id: 'pf', name: 'File', path: '/tmp/f' }] });
    await h.begin(configured());
    const [, call] = await h.turn(NOT_SET, 1);
    expect(call).toMatchObject({ projectId: 'pf', model: 'haiku' });
  });
});

describe('the log names the source', () => {
  it('logs once per change, with the override suffix only when relay beats a settings.json block', async () => {
    const h = build({ projects: [{ id: 'pr', name: 'Relay', path: '/tmp/r' }] });
    await h.begin(configured());
    expect(configLines(h)).toEqual(['Chief of Staff config from relay: project pr, model sonnet, 10 calls a day (overrides settings.json)']);

    await h.turn(configured(), 1);
    await h.turn(configured(), 2);
    expect(configLines(h)).toHaveLength(1);

    await h.turn(configured({ model: 'opus' }), 3);
    expect(configLines(h)).toHaveLength(2);
    expect(configLines(h)[1]).toBe('Chief of Staff config from relay: project pr, model opus, 10 calls a day (overrides settings.json)');
  });

  it.each([
    ['settings.json', 'Chief of Staff config from settings.json: project pf, model haiku, 50 calls a day'],
    ['defaults', 'Chief of Staff config from defaults: project pf, model haiku, 50 calls a day'],
  ])('names %s with no suffix when relay holds nothing', async (fileSource, line) => {
    const h = build({ fileSource });
    cos.start();
    await h.answer(NOT_SET);
    await eventually(() => configLines(h).length === 1);
    expect(configLines(h)).toEqual([line]);
  });

  it('says "automatic" when no project is chosen, and omits the suffix when the file has no block', async () => {
    const h = build({ file: { ...FILE, projectId: null }, fileSource: 'defaults' });
    cos.start();
    await h.answer(configured({ projectId: null }));
    await eventually(() => configLines(h).length === 1);
    expect(configLines(h)).toEqual(['Chief of Staff config from relay: project automatic, model sonnet, 10 calls a day']);
  });

  it('warns once per outage, again after relay has answered in between', async () => {
    const h = build();
    await h.begin({ status: 503, data: {} });
    expect(h.warns[0]).toBe("Chief of Staff config: relay didn't answer (503); keeping settings.json");

    await h.turn({ error: 'ECONNREFUSED' }, 1);
    await h.turn(new Error('socket hang up'), 2);
    expect(h.warns.filter((w) => w.includes("relay didn't answer"))).toHaveLength(1);

    await h.turn(NOT_SET, 3);
    await h.turn({ status: 502, data: {} }, 4);
    const outages = h.warns.filter((w) => w.includes("relay didn't answer"));
    expect(outages).toHaveLength(2);
    expect(outages[1]).toBe("Chief of Staff config: relay didn't answer (502); keeping settings.json");
  });
});

describe('refreshes run one at a time', () => {
  it('a turn that arrives while a read is in flight shares it instead of starting another', async () => {
    const h = build();
    cos.start();
    await eventually(() => h.pending.length === 1);
    const listed = h.sessionListCalls;
    cos.submitPerson('hello');
    // The turn fetches the roster before it reaches the settings read; wait for that, then let it settle.
    await eventually(() => h.sessionListCalls > listed);
    await fs.promises.stat(os.tmpdir());
    await h.answer(NOT_SET);
    await eventually(() => h.model.turn.mock.calls.length === 1);
    expect(h.readRelayConfig).toHaveBeenCalledTimes(1);
  });
});

describe('the project list', () => {
  it('refreshes before the turn when relay names a project the list lacks', async () => {
    const h = build();
    h.refreshProjects.mockImplementation(async () => { h.projects.push({ id: 'pr', name: 'Relay', path: '/tmp/r' }); });
    cos.start();
    await h.answer(configured());
    await eventually(() => h.refreshProjects.mock.calls.length === 1);
    const [, call] = await h.turn(configured(), 1);
    expect(call).toMatchObject({ projectId: 'pr' });
    expect(h.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the project is unchanged and already listed', async () => {
    const h = build();
    cos.start();
    await h.answer(configured({ projectId: 'pf' }));
    await h.turn(configured({ projectId: 'pf' }), 1);
    expect(h.refreshProjects).not.toHaveBeenCalled();
  });

  it('a failing refresh does not stop the turn, which reports that no project can run it', async () => {
    const h = build();
    h.refreshProjects.mockRejectedValue(new Error('relay down'));
    await h.begin(configured());
    cos.submitPerson('hello');
    await h.answer(configured());
    await eventually(() => cos.posts.some((p) => p.kind === 'notice'));
    expect(cos.posts.find((p) => p.kind === 'notice').body)
      .toBe("No project can run me, so I can't send. Pick one in relay's Settings, under Projects > Chief of Staff.");
    expect(h.model.turn).not.toHaveBeenCalled();
  });
});
