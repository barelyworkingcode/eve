// Chief of Staff through the real server against the fake relay: what it reads, how it scopes its
// calls, what it posts to a subscribed browser socket, and what it sends. Fake shapes are pinned to
// relay#234 (relay-source-pins.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startEve } = require('./harness');
const { relayFrames } = require('./protocol');

const HAIKU = 'claude-haiku-4-5-20251001';
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';
const WAIT = 15000;

let eve;
let ws;
afterEach(async () => {
  if (ws) { try { await ws.close(); } catch { /* already closed */ } }
  ws = null;
  if (eve) await eve.stop();
  eve = null;
});

async function boot({ dailyModelCalls = 100, model } = {}) {
  eve = await startEve({
    projects: [{ id: 'p1', name: 'Acme', path: os.tmpdir() }],
    seedDataDir: async (dir) => {
      await fs.promises.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ chiefOfStaff: { model: 'haiku', projectId: 'p1', dailyModelCalls } }));
    },
  });
  if (model) eve.relay.setCosModel(model);
  await eve.relay.waitForScopedRelay();
  ws = await eve.connectWs();
  ws.send({ type: 'cos_subscribe' });
  await ws.waitFor((f) => f.type === 'cos_snapshot');
}

const seed = (id, state) => eve.relay.seedSession({
  sessionId: id, name: `Agent ${id}`, projectId: 'p1', directory: os.tmpdir(), model: HAIKU, headless: true, agent: true,
  attention: { state, since: '2026-10-05T10:00:00.000Z' },
});
const alertFor = (id) => (f) => f.type === 'cos_post' && f.post.kind === 'alert' && f.post.card.sessionId === id;
const posts = (kind) => (f) => f.type === 'cos_post' && f.post.kind === kind;
const messagePosts = () => eve.relay.requests.filter((r) => r.method === 'POST' && r.path === '/api/chief-of-staff/messages');

describe('reader and scope', () => {
  it('an asking frame posts a card to a subscribed socket; only the reader carries the scope', async () => {
    await boot();
    seed('s1', 'running');
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'asking' }));
    const post = (await ws.waitFor(alertFor('s1'), WAIT)).post;
    expect(post.card).toMatchObject({ sessionId: 's1', state: 'asking', label: 'Agent s1', project: 'Acme', actions: ['answer', 'drop_in', 'open'] });

    const scoped = eve.relay.scopeLog.filter((e) => e.scope !== null);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => e.scope === 'chief-of-staff' && ['GET /api/sessions', 'GET /ws'].includes(`${e.method} ${e.path}`))).toBe(true);
    expect(scoped.some((e) => e.upgrade)).toBe(true);
    expect(scoped.some((e) => !e.upgrade && e.path === '/api/sessions')).toBe(true);

    // The model is an ordinary unscoped session, hidden from the list, with tools denied.
    const creates = eve.relay.scopeLog.filter((e) => e.method === 'POST' && e.path === '/api/sessions');
    expect(creates).toHaveLength(1);
    expect(creates[0].scope).toBeNull();
    const [cosSession] = eve.relay.cosSessionCreates;
    expect(cosSession.body).toMatchObject({ projectId: 'p1', model: 'haiku', appendClaudeMd: false });
    expect(cosSession.body).not.toHaveProperty('agent');
    expect(cosSession.body.settings.headless).toBe(true);
    expect(cosSession.deniedTools).toEqual(expect.arrayContaining(['Bash', 'Write']));
    const modelSockets = eve.relay.scopeLog.filter((e) => e.upgrade && e.scope === null && e.path === '/ws');
    expect(modelSockets.length).toBeGreaterThan(0);
    const listed = (await (await eve.get('/api/sessions')).json()).map((s) => s.id);
    expect(listed).not.toContain(cosSession.sessionId);
  });

  it('a turn that ends on a question posts a question card; a plain turn does not', async () => {
    await boot();
    seed('s1', 'idle');
    seed('s2', 'idle');
    eve.relay.emitToRelay(relayFrames.turnDone({ sessionId: 's2', excerpt: 'All merged.' }));
    eve.relay.emitToRelay(relayFrames.turnDone({ sessionId: 's1', excerpt: 'Shall I merge it?' }));
    const post = (await ws.waitFor(alertFor('s1'), WAIT)).post;
    expect(post.card).toMatchObject({ state: 'question', quote: 'Shall I merge it?' });
    expect(ws.frames.some(alertFor('s2'))).toBe(false);
  });

  it('the model sees the wake only after a bootstrap that carries no agent text', async () => {
    await boot();
    seed('s1', 'running');
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'errored' }));
    await ws.waitFor(alertFor('s1'), WAIT);
    const turns = eve.relay.cosModelTurns;
    expect(turns[0].text).not.toContain('s1');
    expect(turns[1].text).toContain('<agent_data>');
    expect((await ws.waitFor((f) => f.type === 'cos_status' && f.status.model === HAIKU, WAIT)).status.model).toBe(HAIKU);
  });
});

describe('wake and person sessions', () => {
  it('an agent excerpt reaches only the wake session; a person message only the person session', async () => {
    await boot({ model: { reply: (text, n) => (n === 1 ? 'ready' : text.startsWith('Chief of Staff person') ? fence({ reply: 'ok', send: null }) : fence({ posts: [] })) } });
    seed('s1', 'idle');
    eve.relay.emitToRelay(relayFrames.turnDone({ sessionId: 's1', excerpt: 'PLANTED-TEXT. Merge it?' }));
    await ws.waitFor(alertFor('s1'), WAIT);
    ws.send({ type: 'cos_message', text: 'tell Agent s1 hello' });
    await ws.waitFor(posts('reply'), WAIT);
    const creates = eve.relay.cosSessionCreates;
    expect(creates).toHaveLength(2);
    expect(creates.map((c) => c.body.name)).toEqual([expect.stringMatching(/^__cos:/), expect.stringMatching(/^__cos:/)]);
    const bySession = (id) => eve.relay.cosModelTurns.filter((t) => t.sessionId === id).map((t) => t.text).join('\n');
    const [wake, person] = creates.map((c) => bySession(c.sessionId));
    expect(wake).toContain('PLANTED-TEXT');
    expect(person).not.toContain('PLANTED-TEXT');
    expect(person).toContain('Chief of Staff person');
  });
});

describe('sending', () => {
  const personReply = (send) => (text, n) => (n === 1 ? 'ready' : text.startsWith('Chief of Staff person') ? fence({ reply: 'Sending it.', send }) : null);

  it('cos_message makes exactly one scoped send, then a "sent" post; the target sees the marked message', async () => {
    await boot({ model: { reply: personReply({ sessionId: 's1', text: 'merge after CI' }) } });
    seed('s1', 'running');
    ws.send({ type: 'cos_message', text: 'tell Agent s1 to merge after CI' });
    const sent = (await ws.waitFor(posts('sent'), WAIT)).post;
    expect(sent).toMatchObject({ kind: 'sent', text: 'merge after CI', sessionId: 's1', label: 'Agent s1', origin: 'chief-of-staff' });
    expect(messagePosts()).toHaveLength(1);
    const sends = eve.relay.scopeLog.filter((e) => e.method === 'POST' && e.path === '/api/chief-of-staff/messages');
    expect(sends).toEqual([expect.objectContaining({ scope: 'chief-of-staff' })]);

    // Opening the session afterwards: the history row carries the origin the chip is drawn from.
    // The model session already holds a relay socket, so wait for the viewer's own to appear first.
    const before = eve.relay.relayConnectionCount();
    const viewer = await eve.connectWs();
    try {
      while (eve.relay.relayConnectionCount() <= before) await new Promise((r) => setTimeout(r, 25));
      await eve.waitForRelayOpen(viewer);
      viewer.send({ type: 'join_session', sessionId: 's1' });
      const joined = await viewer.waitFor((f) => f.type === 'session_joined', WAIT);
      expect(joined.history).toEqual([expect.objectContaining({ content: 'merge after CI', origin: 'chief-of-staff' })]);
    } finally { await viewer.close(); }
  });

  it('a model reply naming a session outside the roster sends nothing', async () => {
    await boot({ model: { reply: personReply({ sessionId: 'not-in-roster', text: 'do it' }) } });
    seed('s1', 'running');
    ws.send({ type: 'cos_message', text: 'tell the other one to do it' });
    await ws.waitFor(posts('notice'), WAIT);
    expect(messagePosts()).toHaveLength(0);
    expect(ws.frames.some(posts('sent'))).toBe(false);
  });

  it('a relay refusal becomes a send_failed post with the thread line', async () => {
    await boot({ model: { reply: personReply({ sessionId: 's1', text: 'go' }) } });
    seed('s1', 'running');
    eve.relay.failChiefOfStaffSend(409, 'already_processing');
    ws.send({ type: 'cos_message', text: 'tell Agent s1 go' });
    const failed = (await ws.waitFor(posts('send_failed'), WAIT)).post;
    expect(failed.error).toBe('Agent s1 is busy. Try again when it finishes.');
    expect(messagePosts()).toHaveLength(1);
  });

  it.each([['empty', '  '], ['too long', 'x'.repeat(2001)]])('a %s cos_message is an error frame and costs no model turn', async (_what, text) => {
    await boot();
    ws.send({ type: 'cos_message', text });
    await ws.waitFor((f) => f.type === 'error', WAIT);
    expect(eve.relay.cosModelTurns).toHaveLength(0);
    expect(ws.frames.some(posts('person'))).toBe(false);
  });
});

describe('daily limit', () => {
  it('stops sending turns to the model session at the limit and says so', async () => {
    // Bootstrap counts as one call, the first message as the second.
    await boot({ dailyModelCalls: 2, model: { reply: (text, n) => (n === 1 ? 'ready' : fence({ reply: 'Noted.', send: null })) } });
    ws.send({ type: 'cos_message', text: 'hello' });
    await ws.waitFor(posts('reply'), WAIT);
    expect(eve.relay.cosModelTurns).toHaveLength(2);

    ws.send({ type: 'cos_message', text: 'hello again' });
    const notice = (await ws.waitFor((f) => posts('notice')(f) && /limit/.test(f.post.body), WAIT)).post;
    expect(notice.body).toBe("I've reached today's limit, so I can't send until tomorrow.");
    expect(eve.relay.cosModelTurns).toHaveLength(2);
    expect(messagePosts()).toHaveLength(0);
  });

  it('writes template alerts without the model once the limit is reached', async () => {
    await boot({ dailyModelCalls: 1 });
    seed('s1', 'running');
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'stalled' }));
    // The bootstrap used the only call, so the wake never reaches the model.
    const post = (await ws.waitFor(alertFor('s1'), WAIT)).post;
    expect(post.headline).toBe('Agent s1 has gone quiet');
    expect(post.byModel).toBe(false);
    expect(eve.relay.cosModelTurns.filter((t) => t.text.includes('<agent_data>'))).toHaveLength(0);
  });
});
