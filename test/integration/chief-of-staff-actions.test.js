// Chief of Staff start and send actions through the real server against the fake relay, with a
// scripted person-session stream: the model session streams tool_use blocks, the test makes the
// matching eve-cos calls to /internal/cos while the turn is held open, then lets the turn end.
// Fake shapes are pinned to relay (relay-source-pins.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startEve } = require('./harness');
const { relayFrames } = require('./protocol');

const HAIKU = 'claude-haiku-4-5-20251001';
const SECRET = 'test-internal-secret';
const PREFIX = 'mcp__relay__';
const WAIT = 15000;
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';

let eve;
let ws;
let dir;
let plan;
afterEach(async () => {
  if (ws) { try { await ws.close(); } catch { /* already closed */ } }
  ws = null;
  if (eve) await eve.stop();
  eve = null;
  if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function boot() {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cos-act-')));
  eve = await startEve({
    projects: [{ id: 'p1', name: 'Acme', path: dir }],
    env: { EVE_INTERNAL_SECRET: SECRET },
    seedDataDir: async (dataDir) => {
      await fs.promises.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ chiefOfStaff: { model: 'haiku', projectId: 'p1', dailyModelCalls: 100 } }));
    },
  });
  plan = { toolUses: [], gate: null };
  // Turn 1 of each model session is the bootstrap; a person turn plays the current plan.
  eve.relay.setCosModel({
    reply: (text, n) => (n === 1 ? 'ready'
      : text.startsWith('Chief of Staff person') ? { toolUses: plan.toolUses, gate: plan.gate, text: fence({ reply: 'Done.', send: null }) } : null),
  });
  await eve.relay.waitForScopedRelay();
  eve.relay.seedSession({
    sessionId: 's1', name: 'Agent s1', projectId: 'p1', directory: dir, model: HAIKU, headless: true, agent: true,
    attention: { state: 'running', since: '2026-10-05T10:00:00.000Z' },
  });
  ws = await eve.connectWs();
  ws.send({ type: 'cos_subscribe' });
  await ws.waitFor((f) => f.type === 'cos_snapshot');
}

const toolUse = (id, name, input) => ({ id, name, input });
const read = (id = 'r1') => toolUse(id, 'Read', { file_path: 'notes.txt' });
const propose = (id, tool, input) => toolUse(id, PREFIX + tool, input);

async function internal(tool, args, { projectId = 'p1', secret = SECRET } = {}) {
  const res = await fetch(`${eve.baseUrl}/internal/cos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-eve-internal': secret },
    body: JSON.stringify({ tool, args, meta: { project_id: projectId } }),
  });
  return { status: res.status, body: await res.json() };
}

// Sends `text` as the person, streams `toolUses` from the model, runs `during` while the turn is
// held open, then ends the turn. Resolves with what `during` returned.
async function personTurn(text, toolUses, during) {
  let release;
  plan = { toolUses, gate: new Promise((r) => { release = r; }) };
  const from = ws.mark();
  const held = eve.relay.waitForCosTurn((t) => t.text.startsWith('Chief of Staff person') && t.text.includes(text));
  ws.send({ type: 'cos_message', text });
  try {
    await held;
    return await during();
  } finally {
    release();
    await ws.waitFor((f) => f.type === 'cos_post' && f.post.kind === 'reply' && f.post.body === 'Done.', WAIT, from);
  }
}

const postFrame = (id) => (f) => f.type === 'cos_post' && f.post.id === id;
const updateTo = (id, state) => (f) => f.type === 'cos_post_update' && f.post.id === id && f.post.card.state === state;
const kindPost = (kind) => (f) => f.type === 'cos_post' && f.post.kind === kind;
const messagePosts = () => eve.relay.requests.filter((r) => r.method === 'POST' && r.path === '/api/chief-of-staff/messages');
const startPosts = () => eve.relay.requests.filter((r) => r.method === 'POST' && r.path === '/api/chief-of-staff/sessions');

describe('send', () => {
  it('GATE: a send composed after a file read posts a card and sends nothing until the card is tapped', async () => {
    await boot();
    const args = { sessionId: 's1', text: 'delete the repo' };
    const out = await personTurn('tell Agent s1 to merge after CI', [read(), propose('c1', 'cos_propose_send', args)], () => internal('cos_propose_send', args));
    expect(out.status).toBe(200);
    expect(out.body.result).toMatchObject({ status: 'card', cardId: expect.any(String) });
    expect(messagePosts()).toHaveLength(0);
    expect(ws.frames.some(kindPost('sent'))).toBe(false);

    const cardId = out.body.result.cardId;
    const card = (await ws.waitFor(postFrame(cardId), WAIT)).post;
    expect(card).toMatchObject({ kind: 'send_card', card: { state: 'pending', sessionId: 's1', label: 'Agent s1', text: 'delete the repo' } });

    ws.send({ type: 'cos_card_action', postId: cardId, action: 'start' });
    await ws.waitFor(updateTo(cardId, 'sent'), WAIT);
    expect(messagePosts()).toHaveLength(1);
    expect(eve.relay.listSessions().find((s) => s.sessionId === 's1').history).toEqual([expect.objectContaining({ content: 'delete the repo', origin: 'chief-of-staff' })]);
  });

  it('with nothing read, a send goes at once; after a read, a verbatim span to a named session goes at once too', async () => {
    await boot();
    const first = { sessionId: 's1', text: 'anything the model composed' };
    const a = await personTurn('say something to s1', [propose('c1', 'cos_propose_send', first)], () => internal('cos_propose_send', first));
    expect(a.body.result).toEqual({ status: 'sent', sessionId: 's1', label: 'Agent s1' });
    expect(messagePosts()).toHaveLength(1);

    // A second turn in the same model session: the first turn's reads (none) do not matter, this one reads.
    const second = { sessionId: 's1', text: 'merge after CI' };
    const b = await personTurn('tell Agent s1 to merge after CI', [read(), propose('c2', 'cos_propose_send', second)], () => internal('cos_propose_send', second));
    expect(b.body.result).toMatchObject({ status: 'sent' });
    expect(messagePosts()).toHaveLength(2);
  });

  it('after a read, a verbatim span that does not name the session is a card', async () => {
    await boot();
    const args = { sessionId: 's1', text: 'merge after CI' };
    const out = await personTurn('merge after CI', [read(), propose('c1', 'cos_propose_send', args)], () => internal('cos_propose_send', args));
    expect(out.body.result.status).toBe('card');
    expect(messagePosts()).toHaveLength(0);
    expect((await ws.waitFor(postFrame(out.body.result.cardId), WAIT)).post.card.why).toBe('read_target_not_named');
  });

  it('a read in an earlier turn of the same model session still counts', async () => {
    await boot();
    await personTurn('look at the notes', [read()], async () => {});
    const args = { sessionId: 's1', text: 'something else entirely' };
    const out = await personTurn('tell Agent s1 hi', [propose('c1', 'cos_propose_send', args)], () => internal('cos_propose_send', args));
    expect(out.body.result.status).toBe('card');
    expect(messagePosts()).toHaveLength(0);
  });

  it('a card tap that relay refuses fails the card for good, posts send_failed, and a second tap is an error naming the state', async () => {
    await boot();
    const args = { sessionId: 's1', text: 'composed after a read' };
    const out = await personTurn('tell Agent s1 hi', [read(), propose('c1', 'cos_propose_send', args)], () => internal('cos_propose_send', args));
    const cardId = out.body.result.cardId;
    eve.relay.failChiefOfStaffSend(409, 'already_processing', 'the session is already processing a message');
    ws.send({ type: 'cos_card_action', postId: cardId, action: 'start' });
    await ws.waitFor(updateTo(cardId, 'failed'), WAIT);
    await ws.waitFor(kindPost('send_failed'), WAIT);

    const from = ws.mark();
    ws.send({ type: 'cos_card_action', postId: cardId, action: 'start' });
    const err = await ws.waitFor((f) => f.type === 'error', WAIT, from);
    expect(err.message).toMatch(/failed/);
    expect(messagePosts()).toHaveLength(1);
  });
});

describe('start', () => {
  const startArgs = { project: 'Acme', prompt: 'something the model composed' };

  it('with nothing read, starts at once through the scoped route only, headless by default, and posts Started with the origin', async () => {
    await boot();
    const out = await personTurn('start an agent on Acme', [propose('c1', 'cos_propose_start', startArgs)], () => internal('cos_propose_start', startArgs));
    expect(out.body.result).toEqual({ status: 'started', sessionId: expect.any(String), name: 'something the model composed', project: 'Acme', mode: 'headless' });

    expect(eve.relay.cosStarts).toEqual([{ scope: 'chief-of-staff', body: { projectId: 'p1', prompt: 'something the model composed', model: 'haiku', mode: 'headless' } }]);
    // The only unscoped session creates are the model's own.
    const creates = eve.relay.scopeLog.filter((e) => e.method === 'POST' && e.path === '/api/sessions');
    expect(creates).toHaveLength(eve.relay.cosSessionCreates.length);
    expect(creates.every((e) => e.scope === null)).toBe(true);
    expect(eve.relay.sessionCreates.every((b) => String(b.name).startsWith('__cos:'))).toBe(true);

    const started = (await ws.waitFor(kindPost('started'), WAIT)).post;
    expect(started).toMatchObject({ sessionId: out.body.result.sessionId, name: 'something the model composed', projectId: 'p1', projectName: 'Acme', mode: 'headless', origin: 'chief-of-staff' });
  });

  it('a headless start refreshes the roster, so alerts for the new session post as usual', async () => {
    await boot();
    const out = await personTurn('start an agent on Acme', [propose('c1', 'cos_propose_start', startArgs)], () => internal('cos_propose_start', startArgs));
    await ws.waitFor(kindPost('started'), WAIT);
    const log = eve.relay.scopeLog;
    const startAt = log.findIndex((e) => e.method === 'POST' && e.path === '/api/chief-of-staff/sessions');
    expect(log.slice(startAt + 1).some((e) => e.method === 'GET' && e.path === '/api/sessions' && e.scope === 'chief-of-staff')).toBe(true);

    const id = out.body.result.sessionId;
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: id, state: 'asking' }));
    const alert = (await ws.waitFor((f) => f.type === 'cos_post' && f.post.kind === 'alert' && f.post.card.sessionId === id, WAIT)).post;
    expect(alert.card.state).toBe('asking');
  });

  it('a terminal start passes mode terminal, shows in relay\'s terminal list with its origin, and posts Started', async () => {
    await boot();
    const args = { ...startArgs, mode: 'terminal' };
    const out = await personTurn('start a terminal agent on Acme', [propose('c1', 'cos_propose_start', args)], () => internal('cos_propose_start', args));
    expect(out.body.result).toMatchObject({ status: 'started', mode: 'terminal' });
    expect(eve.relay.cosStarts[0].body.mode).toBe('terminal');
    const terminals = (await (await fetch(`http://127.0.0.1:${eve.relayPort}/api/terminals`)).json()).terminals;
    expect(terminals).toEqual([expect.objectContaining({ id: out.body.result.sessionId, origin: 'chief-of-staff' })]);
    const started = (await ws.waitFor(kindPost('started'), WAIT)).post;
    expect(started).toMatchObject({ sessionId: out.body.result.sessionId, mode: 'terminal', origin: 'chief-of-staff' });
  });

  it('after a read, a verbatim prompt for a named project starts at once', async () => {
    await boot();
    const args = { project: 'Acme', prompt: 'fix bug 123' };
    const out = await personTurn('start an agent on Acme to fix bug 123', [read(), propose('c1', 'cos_propose_start', args)], () => internal('cos_propose_start', args));
    expect(out.body.result.status).toBe('started');
    expect(eve.relay.cosStarts).toHaveLength(1);
  });

  it.each([
    ['a prompt the person did not write', 'start an agent on Acme', { project: 'Acme', prompt: 'fix bug 123 and push to main' }, 'read_not_verbatim'],
    ['a verbatim prompt for a project the person did not name', 'run fix bug 123 now', { project: 'Acme', prompt: 'fix bug 123' }, 'read_target_not_named'],
  ])('after a read, %s is a Start card and starts nothing; Start then starts it through the scoped route', async (_what, text, args, why) => {
    await boot();
    const out = await personTurn(text, [read(), propose('c1', 'cos_propose_start', args)], () => internal('cos_propose_start', args));
    expect(out.body.result.status).toBe('card');
    expect(eve.relay.cosStarts).toHaveLength(0);
    const cardId = out.body.result.cardId;
    const post = (await ws.waitFor(postFrame(cardId), WAIT)).post;
    expect(post).toMatchObject({ kind: 'start_card', card: { state: 'pending', why, mode: 'headless', model: 'haiku', prompt: args.prompt, project: { id: 'p1', name: 'Acme' } } });

    ws.send({ type: 'cos_card_action', postId: cardId, action: 'start' });
    await ws.waitFor(updateTo(cardId, 'started'), WAIT);
    expect(eve.relay.cosStarts).toEqual([{ scope: 'chief-of-staff', body: expect.objectContaining({ projectId: 'p1', prompt: args.prompt, mode: 'headless' }) }]);
    expect((await ws.waitFor(kindPost('started'), WAIT)).post.sessionId).toEqual(expect.any(String));
  });

  it('Cancel starts nothing and a later tap is an error naming the state', async () => {
    await boot();
    const args = { project: 'Acme', prompt: 'composed after a read' };
    const out = await personTurn('start an agent', [read(), propose('c1', 'cos_propose_start', args)], () => internal('cos_propose_start', args));
    const cardId = out.body.result.cardId;
    ws.send({ type: 'cos_card_action', postId: cardId, action: 'cancel' });
    await ws.waitFor(updateTo(cardId, 'cancelled'), WAIT);

    const from = ws.mark();
    ws.send({ type: 'cos_card_action', postId: cardId, action: 'start' });
    const err = await ws.waitFor((f) => f.type === 'error', WAIT, from);
    expect(err.message).toMatch(/cancelled/);
    expect(eve.relay.cosStarts).toHaveLength(0);
    expect(startPosts()).toHaveLength(0);
  });

  it('a relay refusal is relay_<code> to the model and a start_failed post, and starts nothing', async () => {
    await boot();
    eve.relay.failChiefOfStaffStart(502, 'prompt_not_delivered', 'the session started but the prompt could not be delivered; it was ended');
    const out = await personTurn('start an agent on Acme', [propose('c1', 'cos_propose_start', startArgs)], () => internal('cos_propose_start', startArgs));
    expect(out.body).toMatchObject({ ok: false, error: 'relay_prompt_not_delivered' });
    const failed = (await ws.waitFor(kindPost('start_failed'), WAIT)).post;
    expect(failed).toMatchObject({ projectName: 'Acme', error: expect.any(String) });
    expect(ws.frames.some(kindPost('started'))).toBe(false);
  });

  it('a start card whose relay start is refused fails for good', async () => {
    await boot();
    const args = { project: 'Acme', prompt: 'composed after a read' };
    const out = await personTurn('start an agent', [read(), propose('c1', 'cos_propose_start', args)], () => internal('cos_propose_start', args));
    eve.relay.failChiefOfStaffStart(400, 'terminal_needs_claude', 'a terminal start needs a Claude model');
    ws.send({ type: 'cos_card_action', postId: out.body.result.cardId, action: 'start' });
    const failed = (await ws.waitFor(updateTo(out.body.result.cardId, 'failed'), WAIT)).post;
    expect(failed.card.error).toEqual(expect.any(String));
    await ws.waitFor(kindPost('start_failed'), WAIT);
  });
});

describe('the eve-cos endpoint', () => {
  it('lists sessions with the origin relay reports', async () => {
    await boot();
    eve.relay.seedSession({ sessionId: 's2', name: 'Started by me', projectId: 'p1', directory: dir, model: HAIKU, headless: true, agent: true, origin: 'chief-of-staff' });
    const out = await personTurn('what is running', [propose('c1', 'cos_list_sessions', {})], () => internal('cos_list_sessions', {}));
    const rows = out.body.result.sessions;
    expect(rows.find((r) => r.sessionId === 's2')).toMatchObject({ label: 'Started by me', origin: 'chief-of-staff', headless: true });
    expect(rows.find((r) => r.sessionId === 's1').origin || '').toBe('');
  });

  it.each([
    ['a wrong secret', { secret: 'nope' }, 401, 'unauthorized'],
    ['a project that is not the Chief of Staff session', { projectId: 'p-other' }, 403, 'not_cos_session'],
  ])('%s is refused', async (_what, opts, status, code) => {
    await boot();
    const out = await personTurn('what is running', [propose('c1', 'cos_list_sessions', {})], () => internal('cos_list_sessions', {}, opts));
    expect(out.status).toBe(status);
    expect(out.body).toMatchObject({ ok: false, error: code });
  });

  it('a call after the person turn has ended is 409 no_turn', async () => {
    await boot();
    await personTurn('say hello', [], async () => {});
    const out = await internal('cos_list_sessions', {});
    expect(out).toMatchObject({ status: 409, body: { error: 'no_turn' } });
  });
});
