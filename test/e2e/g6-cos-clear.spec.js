const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// /clear in the Chief of Staff thread. Its completion signal is the cos_snapshot that follows the
// clear: the empty-thread line, or the kept card alone on screen. File and log reads come after it.
// Posts are seeded as `{ v: 1, id, at, kind, byModel, ... }` (docs/api.md). fakerelay's model has no
// tools, so a person turn never keeps a session; a wake turn does, and an asking agent starts one.
// Eve's process runs with TZ=UTC, so its local day is the UTC date.

const HOUR = 3600 * 1000;
const ARCHIVE = 'chief-of-staff-archive.jsonl';
const STATE = 'chief-of-staff-state.json';
const EMPTY = "Nothing yet. I'll post here when an agent needs you.";
const REFUSED = "A delegation is active, so I didn't clear the thread. Stop it on the bar first, then type /clear again.";
const NOT_ARCHIVED = "I couldn't archive the thread, so I didn't clear it. Try again.";
const LIMIT = "I've reached today's limit, so I can't send until tomorrow.";

const MODEL_ID = 's_cos_model';
const PERSON_ID = 's_cos_person';

function cosWorld({ calls = 20, modelSessions = false } = {}) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: calls };
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
  w.sessions = [
    { id: 's_ledger', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' }] },
    { id: 's_review', project_id: 'p_acme', name: 'Review', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'second question' }, { role: 'assistant', text: 'second answer' }] },
    { id: 's_hold', project_id: 'p_acme', name: 'Hold', model: 'acme-ask', state: 'idle', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] },
    { id: 's_hold2', project_id: 'p_acme', name: 'Hold two', model: 'acme-ask', state: 'idle', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] },
  ];
  if (modelSessions) {
    for (const id of [MODEL_ID, PERSON_ID]) {
      w.sessions.push({ id, project_id: 'p_acme', name: `__cos:${id}`, model: 'haiku', state: 'idle', messages: [] });
    }
  }
  return w;
}

const today = () => new Date().toISOString().slice(0, 10);

// The state file eve keeps, naming both Chief of Staff model sessions.
function stateFile({ calls = 0, withSessions = true } = {}) {
  return JSON.stringify({
    day: today(),
    calls,
    rowCalls: 0,
    modelSessionId: withSessions ? MODEL_ID : null,
    personSessionId: withSessions ? PERSON_ID : null,
    limitNoticeDay: null,
  });
}

let seq = 0;
function post(kind, fields) {
  seq += 1;
  return { v: 1, id: `c_clear_${seq}`, at: new Date(Date.now() - (100 - seq) * 60000).toISOString(), kind, byModel: false, ...fields };
}

const person = (text) => post('person', { text });
const reply = (text) => post('reply', { text, byModel: true });
const notice = (text) => post('notice', { text });
const sendCard = (id, text) => ({
  ...post('send_card', { byModel: true }),
  id,
  card: { state: 'pending', sessionId: 's_ledger', label: 'Ledger', text, why: 'read_not_verbatim', turnId: 't_1', error: null },
});

const jsonl = (posts) => posts.map((p) => JSON.stringify(p)).join('\n') + '\n';

// The file eve keeps while a delegation is active (docs/design-chief-of-staff.md, State).
const LEDGER = { sessionId: 's_ledger', label: 'Ledger', project: 'Acme' };
const REVIEW = { sessionId: 's_review', label: 'Review', project: 'Acme' };

function activeDelegation(until) {
  const card = {
    state: 'active',
    delegationId: 'd_c_active',
    instruction: "I'm AFK, continue until ready to merge to main",
    rules: [{ kind: 'continue', sessions: [LEDGER, REVIEW], approveIssues: [], buildFromDev: false }],
    windowHours: 8,
    maxActions: 50,
    verifyRuns: 2,
    approvedAt: new Date(until - 8 * HOUR).toISOString(),
    until: new Date(until).toISOString(),
    endedAt: null,
    endReason: null,
    actions: 0,
    turnId: 't_1',
    error: null,
  };
  const delegationPost = { v: 1, id: 'c_active', at: new Date().toISOString(), kind: 'delegation_card', byModel: true, card };
  const sessions = {};
  for (const s of [LEDGER, REVIEW]) sessions[s.sessionId] = { ready: false, report: '', waiting: null, actions: 0 };
  const state = JSON.stringify({
    v: 1,
    delegationId: card.delegationId,
    postId: delegationPost.id,
    instruction: card.instruction,
    rules: card.rules,
    windowHours: card.windowHours,
    maxActions: card.maxActions,
    verifyRuns: card.verifyRuns,
    until: card.until,
    approvedAt: card.approvedAt,
    actions: 0,
    sessions,
    log: [],
  });
  return { post: delegationPost, state };
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

// The simple door: type the command and press Return.
async function typeClear(page) {
  const box = page.getByRole('textbox', { name: 'Tell an agent' });
  await box.fill('/clear');
  await box.press('Enter');
}

// Opens an agent from Today and sends it a message. It then waits on a permission prompt, and the
// modal covers this page, so the thread is read from another browser.
async function holdThread(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill('run it from testbox');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'Permission Request' })).toBeVisible();
}

const archiveLines = async (eve) => {
  const text = await eve.dataFile(ARCHIVE);
  return text === null ? [] : text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};

const cosSessionIds = async (relay) => (await relay.json('ctl', 'state', '--json')).sessions
  .filter((s) => String(s.name).startsWith('__cos:')).map((s) => s.id).sort();

test.describe('clearing with both model sessions known', () => {
  const posts = [person('older question'), reply('older answer')];
  test.use({
    world: cosWorld({ modelSessions: true }),
    eveFiles: { 'chief-of-staff.jsonl': jsonl(posts), [STATE]: stateFile() },
  });

  test('both Chief of Staff model sessions end and are deleted on relay @G6.103', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText('older answer', { exact: true })).toBeVisible();
    const since = relay.mark();
    await typeClear(page);
    await Promise.all([MODEL_ID, PERSON_ID].map((id) => relay.waitForEvent('session.delete', { since, match: (l) => l.session_id === id })));
    await expect(page.getByText(EMPTY)).toBeVisible();

    for (const id of [MODEL_ID, PERSON_ID]) {
      const deletes = (await relay.logs({ event: 'session.delete', since })).filter((l) => l.session_id === id);
      expect(deletes).toHaveLength(1);
    }
    expect(await cosSessionIds(relay)).toEqual([]);
    const state = JSON.parse(await eve.dataFile(STATE));
    expect(state.modelSessionId).toBeNull();
    expect(state.personSessionId).toBeNull();
  });

  test('the clear sends nothing to an agent and makes no model call @G6.103', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText('older answer', { exact: true })).toBeVisible();
    const since = relay.mark();
    await typeClear(page);
    await expect(page.getByText(EMPTY)).toBeVisible();
    expect(await relay.logs({ event: 'chat.turn', since })).toHaveLength(0);
    expect(await relay.logs({ event: 'chief_of_staff.send', since })).toHaveLength(0);
    expect(await relay.logs({ event: 'session.launch', since })).toHaveLength(0);
  });
});

test.describe('the next turn after a clear', () => {
  test.use({ world: cosWorld() });

  test('starts a fresh session that is not the one before the clear @G6.103', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdThread(page, 'Hold');
    const other = await eve.openAnother('/');
    await openCos(other);
    await expect(other.getByRole('heading', { name: 'Hold is asking you something' })).toBeVisible();
    const before = await cosSessionIds(relay);
    expect(before).toHaveLength(1);
    const [wake] = before;

    const since = relay.mark();
    await typeClear(other);
    await relay.waitForEvent('session.delete', { since, match: (l) => l.session_id === wake });
    await expect(other.getByText(EMPTY)).toBeVisible();
    expect(await cosSessionIds(relay)).toEqual([]);

    const second = await eve.openAnother('/');
    await holdThread(second, 'Hold two');
    await expect(other.getByRole('heading', { name: 'Hold two is asking you something' })).toBeVisible();
    const after = await cosSessionIds(relay);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(wake);
  });
});

test.describe('the archive', () => {
  const seeded = [
    { v: 1, clearedAt: '2026-01-01T00:00:00.000Z', post: person('archived long ago') },
    { v: 1, clearedAt: '2026-01-01T00:00:00.000Z', post: reply('answered long ago') },
  ];
  const posts = [person('older question'), reply('older answer'), notice('older notice')];
  test.use({
    world: cosWorld(),
    eveFiles: { 'chief-of-staff.jsonl': jsonl(posts), [ARCHIVE]: jsonl(seeded) },
  });

  test('old posts leave the screen and are kept in the archive @G6.103', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page, 'Hold');
    const other = await eve.openAnother('/');
    await openCos(other);
    await expect(other.getByRole('heading', { name: 'Hold is asking you something' })).toBeVisible();
    for (const text of ['older question', 'older answer', 'older notice']) {
      await expect(other.getByText(text, { exact: true })).toBeVisible();
    }

    const before = await eve.dataFile(ARCHIVE);
    await typeClear(other);
    await expect(other.getByText(EMPTY)).toBeVisible();
    for (const text of ['older question', 'older answer', 'older notice']) {
      await expect(other.getByText(text, { exact: true })).toHaveCount(0);
    }
    await expect(other.getByRole('heading', { name: 'Hold is asking you something' })).toHaveCount(0);

    // Append only: what was there stays first, then one line per archived post, oldest first.
    const after = await eve.dataFile(ARCHIVE);
    expect(after.startsWith(before)).toBe(true);
    const lines = await archiveLines(eve);
    expect(lines.slice(0, 2)).toEqual(seeded);
    const added = lines.slice(2);
    expect(added).toHaveLength(4);
    for (const line of added) {
      expect(line.v).toBe(1);
      expect(Number.isNaN(Date.parse(line.clearedAt))).toBe(false);
    }
    expect(added.slice(0, 3).map((l) => l.post.id)).toEqual(posts.map((p) => p.id));
    expect(added[3].post.kind).toBe('alert');
  });
});

test.describe('a card still waiting on a tap', () => {
  const CARD = 'status please';
  const posts = [person('older question'), notice('older notice'), sendCard('c_card', CARD)];
  test.use({
    world: cosWorld(),
    eveFiles: { 'chief-of-staff.jsonl': jsonl(posts) },
  });

  test('stays after the clear and acts on one tap @G6.103', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article').filter({ hasText: CARD });
    await expect(card).toBeVisible();
    await expect(page.getByText('older question', { exact: true })).toBeVisible();

    await typeClear(page);
    // The card alone is left: the older lines go, and the empty line does not show.
    await expect(page.getByText('older question', { exact: true })).toHaveCount(0);
    await expect(page.getByText('older notice', { exact: true })).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect(page.getByText(EMPTY)).toHaveCount(0);

    const since = relay.mark();
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await relay.waitForEvent('chief_of_staff.send', { since });
    await expect(card.getByText('Sent', { exact: true })).toBeVisible();
    expect(await relay.logs({ event: 'chief_of_staff.send', since })).toHaveLength(1);
  });
});

test.describe('the daily limit', () => {
  test.use({
    world: cosWorld({ calls: 3 }),
    eveFiles: { 'chief-of-staff.jsonl': jsonl([person('older question')]), [STATE]: stateFile({ calls: 3, withSessions: false }) },
  });

  test('a clear does not reset the daily model-call count @G6.103', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText('older question', { exact: true })).toBeVisible();
    await typeClear(page);
    await expect(page.getByText(EMPTY)).toBeVisible();

    const box = page.getByRole('textbox', { name: 'Tell an agent' });
    await box.fill('hello');
    await box.press('Enter');
    await expect(page.getByText(LIMIT)).toBeVisible();
    const state = JSON.parse(await eve.dataFile(STATE));
    expect(state.day).toBe(today());
    expect(state.calls).toBe(3);
  });
});

test.describe('a delegation is active', () => {
  const until = Math.floor((Date.now() + 3 * HOUR) / 60000) * 60000;
  const delegation = activeDelegation(until);
  const posts = [person('older question'), reply('older answer'), delegation.post];
  test.use({
    world: cosWorld({ modelSessions: true }),
    locale: 'en-GB',
    timezoneId: 'UTC',
    eveFiles: {
      'chief-of-staff.jsonl': jsonl(posts),
      'chief-of-staff-delegation.json': delegation.state,
      [STATE]: stateFile(),
    },
  });

  test('refuses and says to stop the delegation first @G6.103.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText(/^Acting for you until/)).toBeVisible();
    await expect(page.getByText('older answer', { exact: true })).toBeVisible();

    const since = relay.mark();
    await typeClear(page);
    await expect(page.getByText(REFUSED)).toBeVisible();
    await expect(page.getByText('older question', { exact: true })).toBeVisible();
    await expect(page.getByText('older answer', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Acting for you until/)).toBeVisible();
    expect(await relay.logs({ event: 'session.delete', since })).toHaveLength(0);
    expect(await eve.dataFile(ARCHIVE)).toBeNull();
  });
});

test.describe('the archive cannot be written', () => {
  test.use({
    world: cosWorld({ modelSessions: true }),
    eveFiles: { 'chief-of-staff.jsonl': jsonl([person('older question'), reply('older answer')]), [STATE]: stateFile() },
  });

  test('says so and leaves the thread and the sessions alone @G6.103.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText('older answer', { exact: true })).toBeVisible();
    await eve.readOnlyDataFile(ARCHIVE);

    const since = relay.mark();
    await typeClear(page);
    await expect(page.getByText(NOT_ARCHIVED)).toBeVisible();
    await expect(page.getByText('older question', { exact: true })).toBeVisible();
    await expect(page.getByText('older answer', { exact: true })).toBeVisible();
    await expect(page.getByText(EMPTY)).toHaveCount(0);
    expect(await relay.logs({ event: 'session.delete', since })).toHaveLength(0);
    expect(await archiveLines(eve)).toEqual([]);
    const state = JSON.parse(await eve.dataFile(STATE));
    expect(state.modelSessionId).toBe(MODEL_ID);
    expect(state.personSessionId).toBe(PERSON_ID);
  });
});
