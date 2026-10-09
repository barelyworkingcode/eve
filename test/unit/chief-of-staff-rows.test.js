// eve#274: row notes for the agent rail. Line 3 of a rail row is a note per session, set when a
// turn ends idle and sent to subscribers as cos_row_note. Driven through the relay frames the
// scoped reader delivers, with fake timers for the quiet window.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChiefOfStaff } = require('../../chief-of-staff');

const reply = (o) => 'ok\n```json\n' + JSON.stringify(o) + '\n```';
const frame = (o) => Buffer.from(JSON.stringify(o));
const row = (id, state, extra = {}) => ({ id, name: `Agent ${id}`, projectId: 'p1', model: 'haiku', headless: true, attention: { state, since: '2026-01-01T00:00:00.000Z' }, ...extra });
const dataRegion = (text) => JSON.parse(/<agent_data>\n([\s\S]*)\n<\/agent_data>/.exec(text)[1]);
const kindOf = (text) => (/^Chief of Staff (\w+)/.exec(text) || [])[1];
const today = () => new Date().toLocaleDateString('en-CA');

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

// The row model writes `Line for <id>` for every agent in the prompt's data region, unless
// `rowReply` is given. The wake model writes a headline per agent when `wakeHeadlines` is set.
// `summaries` maps sessionId -> finished summary.
function setup({ sessions, settings, state, summaries = {}, rowReply, wakeHeadlines = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-rows-'));
  dirs.push(dir);
  if (state) fs.writeFileSync(path.join(dir, 'chief-of-staff-state.json'), JSON.stringify(state));
  h = { list: sessions, sockets: [], frames: [], log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
  h.model = {
    turn: jest.fn(async (text) => {
      const kind = kindOf(text);
      if (kind === 'row') {
        if (rowReply) return { text: rowReply, modelId: 'm' };
        return { text: reply({ rows: dataRegion(text).map((e) => ({ sessionId: e.sessionId, line: `Line for ${e.sessionId}` })) }), modelId: 'm' };
      }
      if (kind === 'finished') {
        return { text: reply({ posts: Object.entries(summaries).map(([sessionId, summary]) => ({ sessionId, summary })) }), modelId: 'm' };
      }
      if (kind === 'wake' && wakeHeadlines) {
        return { text: reply({ posts: dataRegion(text).map((e) => ({ sessionId: e.sessionId, headline: `Headline ${e.sessionId}`, body: 'Body.' })) }), modelId: 'm' };
      }
      return { text: '', modelId: 'm' };
    }),
  };
  h.transport = {
    fetch: jest.fn(async (method, p) => {
      if (method === 'GET' && p === '/api/sessions') return { status: 200, data: { sessions: h.list } };
      if (method === 'POST' && p === '/api/chief-of-staff/messages') return { status: 202, data: {} };
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
    listProjects: () => [{ id: 'p1', name: 'Acme', path: '/tmp/acme' }],
    resolveProject: (id) => (id === 'p1' ? { id, name: 'Acme' } : null),
  });
  h.emit = (f) => h.sockets[h.sockets.length - 1].emit('message', frame(f));
  h.tick = (ms) => jest.advanceTimersByTimeAsync(ms);
  h.turnEnds = (id, excerpt = 'Merged the branch.') => h.emit({ type: 'turn_done', sessionId: id, excerpt });
  h.state = (id, st) => h.emit({ type: 'session_state', sessionId: id, state: st });
  h.begin = async () => {
    h.cos.start(); h.sockets[0].emit('open'); await h.tick(0);
    h.subscriber = { send: (s) => h.frames.push(JSON.parse(s)) };
    h.cos.subscribe(h.subscriber);
  };
  h.rowTurns = () => h.model.turn.mock.calls.filter((c) => kindOf(c[0]) === 'row');
  h.noteOf = (id) => h.cos.getRowNotes().find((n) => n.sessionId === id);
  h.noteFrames = (id) => h.frames.filter((f) => f.type === 'cos_row_note' && f.sessionId === id);
  h.idle = (id, excerpt) => { h.turnEnds(id, excerpt); h.state(id, 'idle'); };
  // One full row batch for the session: the quiet window passes, then the note leaves pending.
  h.rowBatch = async (id, excerpt) => {
    h.idle(id, excerpt);
    await h.tick(5000);
    await eventually(() => h.noteOf(id).source !== 'pending' && !h.cos.getStatus().busy);
  };
  return h;
}

const rowCallsOnDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'chief-of-staff-state.json'), 'utf8')).rowCalls;

describe('a turn that ends idle', () => {
  // AC: idle turn end shows a one-line model summary; the summary does not post to the thread
  it('shows the last words at once, then the model line after the quiet window, and posts nothing', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.idle('s1', 'Merged the branch.');
    expect(h.noteOf('s1')).toMatchObject({ sessionId: 's1', kind: 'summary', source: 'pending', text: 'Merged the branch.' });
    expect(h.noteFrames('s1')).toHaveLength(1);

    await h.tick(4999);
    expect(h.rowTurns()).toHaveLength(0);
    await h.tick(1);
    await eventually(() => h.noteOf('s1').source === 'model');
    expect(h.noteOf('s1')).toMatchObject({ kind: 'summary', source: 'model', text: 'Line for s1' });
    expect(h.noteFrames('s1').map((f) => f.source)).toEqual(['pending', 'model']);
    expect(h.rowTurns()).toHaveLength(1);

    await eventually(() => !h.cos.getStatus().busy);
    expect(h.cos.posts).toHaveLength(0);
    expect(h.frames.filter((f) => f.type === 'cos_post')).toHaveLength(0);
    expect(h.log.info.mock.calls.map((c) => c[0])).toContain('Chief of Staff row summary: session s1 source model');
  });

  // AC: one summary per turn end, not per frame
  it('sets no note when the session goes idle without a turn ending', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.state('s1', 'idle');
    await h.tick(6000);
    expect(h.noteOf('s1')).toBeUndefined();
    expect(h.rowTurns()).toHaveLength(0);
  });

  it('drops the wait when the session runs again before the window ends, and the pending note stays', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.idle('s1', 'First turn.');
    h.state('s1', 'running');
    await h.tick(6000);
    expect(h.rowTurns()).toHaveLength(0);
    expect(h.noteOf('s1')).toMatchObject({ source: 'pending', text: 'First turn.' });
  });

  it('a later turn replaces the earlier one in the same batch: one entry per session', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.idle('s1', 'First turn.');
    h.state('s1', 'running');
    h.idle('s1', 'Second turn.');
    await h.tick(5000);
    await eventually(() => h.rowTurns().length === 1);
    const entries = dataRegion(h.rowTurns()[0][0]);
    expect(entries).toHaveLength(1);
    expect(entries[0].excerpt).toBe('Second turn.');
  });

  it('a turn that ends on a question gets the question as its note, no row turn, and keeps it after the question alert', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.idle('s1', 'Shall I merge it?');
    expect(h.noteOf('s1')).toMatchObject({ kind: 'summary', source: 'template', text: 'Shall I merge it?' });
    await h.tick(6000);
    await eventually(() => !h.cos.getStatus().busy);
    expect(h.rowTurns()).toHaveLength(0);
    expect(h.cos.posts.map((p) => p.kind)).toEqual(['alert']);
    expect(h.noteOf('s1')).toMatchObject({ kind: 'summary', source: 'template', text: 'Shall I merge it?' });
  });
});

describe('a session first seen mid-turn', () => {
  // relay emits turn_done before idle; the first list read does not name a session just created.
  it('still gets a pending note and then a model note when running, turn_done and idle arrive before the list names it', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.state('s9', 'running');
    h.turnEnds('s9', 'Merged the branch.');
    h.state('s9', 'idle');
    h.list = [row('s1', 'running'), row('s9', 'idle')]; // the next list read names it
    await h.tick(0); // the first refresh is immediate: it reads the list and replays the held frames
    await eventually(() => h.cos.getStatus().watching === 2 && !h.cos.getStatus().busy); // the refresh read the list and replayed the frames
    expect(h.noteOf('s9')).toMatchObject({ kind: 'summary', source: 'pending', text: 'Merged the branch.' });

    await h.tick(5000);
    await eventually(() => h.rowTurns().length === 1 && !h.cos.getStatus().busy);
    expect(h.noteOf('s9')).toMatchObject({ kind: 'summary', source: 'model', text: 'Line for s9' });
  });
});

describe('the quiet window', () => {
  // The contract's ROW_QUIET_MS 5000 and ROW_MAX_WAIT_MS 30000.
  it('waits 5s after the newest turn, so two turns 4s apart go in one batch', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')] });
    await h.begin();
    h.idle('s1');
    await h.tick(4000);
    h.idle('s2');
    await h.tick(4999);
    expect(h.rowTurns()).toHaveLength(0);
    await h.tick(1);
    await eventually(() => h.rowTurns().length === 1);
    expect(dataRegion(h.rowTurns()[0][0]).map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('never waits past 30s after the oldest turn, however busy the others are', async () => {
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    setup({ sessions: ids.map((id) => row(id, 'running')) });
    await h.begin();
    h.idle('s1');
    for (const id of ids.slice(1)) { await h.tick(4000); h.idle(id); } // newest turn at 28s
    await h.tick(1999);
    expect(h.rowTurns()).toHaveLength(0);
    await h.tick(1);
    await eventually(() => h.rowTurns().length === 1);
    expect(dataRegion(h.rowTurns()[0][0])).toHaveLength(8);
  });

  it('takes at most 10 sessions in a batch, oldest first, and the rest in the next', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, '0')}`);
    setup({ sessions: ids.map((id) => row(id, 'running')) });
    await h.begin();
    for (const id of ids) { h.idle(id); await h.tick(10); }
    await h.tick(5000);
    await eventually(() => h.rowTurns().length === 2 && !h.cos.getStatus().busy);
    expect(dataRegion(h.rowTurns()[0][0]).map((e) => e.sessionId)).toEqual(ids.slice(0, 10));
    expect(dataRegion(h.rowTurns()[1][0]).map((e) => e.sessionId)).toEqual(ids.slice(10));
  });
});

describe('pump order', () => {
  it('runs the person turn, then the alert, then finished, then rows; rows never delay the rest', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running'), row('s3', 'running')] });
    let release;
    const held = new Promise((r) => { release = r; });
    const inner = h.model.turn.getMockImplementation();
    h.model.turn.mockImplementation((text, opts) => (kindOf(text) === 'person' ? held.then(() => ({ text: 'ok', modelId: 'm' })) : inner(text, opts)));
    await h.begin();
    await h.cos._send('s3', 'go'); // s3 becomes an errand
    h.cos.submitPerson('hello there');
    await eventually(() => h.model.turn.mock.calls.length === 1); // the person turn is in flight
    h.idle('s1');
    h.state('s2', 'errored');
    h.idle('s3');
    await h.tick(6000); // every queue is ready; the held turn is the only thing in the way
    release();
    await eventually(() => h.rowTurns().length === 1 && !h.cos.getStatus().busy);
    expect(h.model.turn.mock.calls.map((c) => kindOf(c[0]))).toEqual(['person', 'wake', 'finished', 'row']);
  });
});

describe('errands', () => {
  // AC: an errand costs one call: the finished summary is its row line
  it('an errand that goes idle shows pending, then the finished summary as its line, with no row turn', async () => {
    setup({ sessions: [row('s1', 'running')], summaries: { s1: 'It merged the branch.' } });
    await h.begin();
    await h.cos._send('s1', 'merge it');
    h.idle('s1', 'Merged the branch and tagged it.');
    expect(h.noteFrames('s1')[0]).toMatchObject({ kind: 'summary', source: 'pending', text: 'Merged the branch and tagged it.' });
    await eventually(() => h.noteOf('s1').source !== 'pending');
    expect(h.noteOf('s1')).toMatchObject({ kind: 'summary', source: 'model', text: 'It merged the branch.' });
    await h.tick(6000);
    await eventually(() => !h.cos.getStatus().busy);
    expect(h.rowTurns()).toHaveLength(0);
    expect(h.model.turn.mock.calls.map((c) => kindOf(c[0]))).toEqual(['finished']);
  });
});

describe('alert notes', () => {
  it.each([
    ['asking', true, 'model'],
    ['errored', true, 'model'],
    ['stalled', true, 'model'],
    ['errored', false, 'template'],
  ])('a session that goes %s gets a kind alert note (model headline: %s)', async (st, wakeHeadlines, source) => {
    setup({ sessions: [row('s1', 'running')], wakeHeadlines });
    await h.begin();
    h.state('s1', st);
    await h.tick(2100);
    await eventually(() => h.noteOf('s1') && !h.cos.getStatus().busy);
    const note = h.noteOf('s1');
    expect(note).toMatchObject({ kind: 'alert', source });
    expect(note.text.length).toBeGreaterThan(0);
    expect(note.text.length).toBeLessThanOrEqual(160);
    expect(note.text).not.toMatch(/\n/);
    if (wakeHeadlines) expect(note.text).toBe('Headline s1');
  });
});

describe('daily limits', () => {
  // AC: at the daily limit the row shows the agent's last words
  it('at the global limit the note is the template: no model turn, no thread notice', async () => {
    setup({ sessions: [row('s1', 'running')], settings: { dailyModelCalls: 1 } });
    await h.begin();
    expect(h.cos.countCall()).toBe(true); // the day's only call is spent
    h.idle('s1', 'Merged the branch and tagged it.');
    await h.tick(5000);
    await eventually(() => h.noteOf('s1').source === 'template' && !h.cos.getStatus().busy);
    expect(h.noteOf('s1')).toMatchObject({ kind: 'summary', source: 'template', text: 'Merged the branch and tagged it.' });
    expect(h.model.turn).not.toHaveBeenCalled();
    expect(h.cos.posts).toHaveLength(0);
    expect(h.frames.filter((f) => f.type === 'cos_post')).toHaveLength(0);
  });

  it('the rail spends half the day: dailyModelCalls 4 gives two model batches, then templates, and the cap line once', async () => {
    setup({ sessions: ['s1', 's2', 's3', 's4'].map((id) => row(id, 'running')), settings: { dailyModelCalls: 4 } });
    await h.begin();
    for (const id of ['s1', 's2', 's3', 's4']) await h.rowBatch(id, `Words of ${id}.`);
    expect(h.rowTurns()).toHaveLength(2);
    expect(['s1', 's2', 's3', 's4'].map((id) => h.noteOf(id).source)).toEqual(['model', 'model', 'template', 'template']);
    expect(h.noteOf('s3').text).toBe('Words of s3.');
    const cap = h.log.info.mock.calls.map((c) => c[0]).filter((m) => /row summaries reached/.test(m));
    expect(cap).toEqual(["Chief of Staff row summaries reached today's cap of 2 model calls; rows show last words until tomorrow"]);
    expect(h.cos.posts).toHaveLength(0);
    await eventually(() => rowCallsOnDisk(path.dirname(h.cos.stateFile)) === 2);
  });

  it('rowCalls survives a restart: a state file with one row call spent leaves one model batch', async () => {
    setup({ sessions: ['s1', 's2'].map((id) => row(id, 'running')), settings: { dailyModelCalls: 4 }, state: { day: today(), calls: 0, rowCalls: 1 } });
    await h.begin();
    await h.rowBatch('s1');
    await h.rowBatch('s2');
    expect([h.noteOf('s1').source, h.noteOf('s2').source]).toEqual(['model', 'template']);
  });

  it('rowCalls resets when the day rolls', async () => {
    setup({ sessions: ['s1', 's2'].map((id) => row(id, 'running')), settings: { dailyModelCalls: 4 }, state: { day: '2000-01-01', calls: 3, rowCalls: 2 } });
    await h.begin();
    await h.rowBatch('s1');
    await h.rowBatch('s2');
    expect([h.noteOf('s1').source, h.noteOf('s2').source]).toEqual(['model', 'model']);
  });

  it('a reply nobody can parse falls back to the template for that session', async () => {
    setup({ sessions: [row('s1', 'running')], rowReply: 'no json here' });
    await h.begin();
    await h.rowBatch('s1', 'Merged it.');
    expect(h.noteOf('s1')).toMatchObject({ source: 'template', text: 'Merged it.' });
    expect(h.log.info.mock.calls.map((c) => c[0])).toContain('Chief of Staff row summary: session s1 source template');
  });
});

describe('removal and snapshot', () => {
  it('session_ended drops the note and the wait, and the snapshot no longer lists it', async () => {
    setup({ sessions: [row('s1', 'running'), row('s2', 'running')] });
    await h.begin();
    h.idle('s1', 'One.');
    h.idle('s2', 'Two.');
    h.emit({ type: 'session_ended', sessionId: 's1' });
    expect(h.noteOf('s1')).toBeUndefined();
    await h.tick(5000);
    await eventually(() => h.rowTurns().length === 1);
    expect(dataRegion(h.rowTurns()[0][0]).map((e) => e.sessionId)).toEqual(['s2']);
    expect(h.cos.getSnapshot().rowNotes.map((n) => n.sessionId)).toEqual(['s2']);
  });

  it('a new subscriber gets every note in its cos_snapshot', async () => {
    setup({ sessions: [row('s1', 'running')] });
    await h.begin();
    h.idle('s1', 'Merged the branch.');
    const late = [];
    h.cos.subscribe({ send: (s) => late.push(JSON.parse(s)) });
    expect(late[0].type).toBe('cos_snapshot');
    expect(late[0].rowNotes).toEqual([expect.objectContaining({ sessionId: 's1', text: 'Merged the branch.', kind: 'summary', source: 'pending' })]);
    expect(typeof late[0].rowNotes[0].at).toBe('string');
  });

  it('a note over 160 characters leaves as one line of at most 160', async () => {
    setup({ sessions: [row('s1', 'running')], rowReply: reply({ rows: [{ sessionId: 's1', line: `a${'b'.repeat(400)}` }] }) });
    await h.begin();
    await h.rowBatch('s1');
    expect(h.noteOf('s1').source).toBe('model');
    expect(h.noteOf('s1').text.length).toBeLessThanOrEqual(160);
  });
});
