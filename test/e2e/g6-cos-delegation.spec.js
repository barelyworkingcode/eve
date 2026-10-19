const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Seeded posts are `{ v: 1, id, at, kind: 'delegation_card', byModel: true, card }` with the card shape of docs/api.md.
// The instruction is typed to a model; fakerelay's model has no tools, so the card is seeded and the person's
// steps start at the card. A card is a role `article`; the bar is read by its words.
// The browser runs in UTC and en-GB, so every HH:MM on screen is the UTC hour and minute of the stored time.

const HOUR = 3600 * 1000;

function cosWorld() {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.sessions = [
    { id: 's_ledger', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' }] },
    { id: 's_review', project_id: 'p_acme', name: 'Review', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'second question' }, { role: 'assistant', text: 'second answer' }] },
  ];
  return w;
}

const LEDGER = { sessionId: 's_ledger', label: 'Ledger', project: 'Acme' };
const REVIEW = { sessionId: 's_review', label: 'Review', project: 'Acme' };
const GONE = { sessionId: 's_gone', label: 'Draft', project: 'Acme' };

function hhmm(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

function delegationPost(id, instruction, overrides = {}, rules) {
  const card = {
    state: 'pending',
    delegationId: `d_${id}`,
    instruction,
    rules: rules || [
      { kind: 'continue', sessions: [LEDGER, REVIEW], approveIssues: [], buildFromDev: false },
      { kind: 'reply', ...LEDGER, on: 'question', when: null, text: 'Yes, go on.' },
    ],
    windowHours: 8,
    maxActions: 50,
    verifyRuns: 2,
    approvedAt: null,
    until: null,
    endedAt: null,
    endReason: null,
    actions: 0,
    turnId: 't_1',
    error: null,
    ...overrides,
  };
  return { v: 1, id, at: new Date().toISOString(), kind: 'delegation_card', byModel: true, card };
}

// The file eve keeps while a delegation is active (docs/design-chief-of-staff.md, State).
function stateFile(post, { until, actions = 0 }) {
  const sessions = {};
  for (const rule of post.card.rules) {
    const list = rule.kind === 'continue' ? rule.sessions : [rule];
    for (const s of list) sessions[s.sessionId] = { ready: false, report: '', waiting: null, actions: 0 };
  }
  return JSON.stringify({
    v: 1,
    delegationId: post.card.delegationId,
    postId: post.id,
    instruction: post.card.instruction,
    rules: post.card.rules,
    windowHours: post.card.windowHours,
    maxActions: post.card.maxActions,
    verifyRuns: post.card.verifyRuns,
    until: new Date(until).toISOString(),
    approvedAt: new Date(until - 8 * HOUR).toISOString(),
    actions,
    sessions,
    log: [],
  });
}

function activePost(id, instruction, { until, actions = 0, overrides = {} }) {
  return delegationPost(id, instruction, {
    state: 'active',
    approvedAt: new Date(until - 8 * HOUR).toISOString(),
    until: new Date(until).toISOString(),
    actions,
    ...overrides,
  });
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

function cardOf(page, instruction) {
  return page.getByRole('article').filter({ hasText: instruction });
}

function bar(page) {
  return page.getByText(/^Acting for you until/);
}

const AFK = "I'm AFK, continue until ready to merge to main";

test.describe('a pending card', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [delegationPost('c_one', AFK)],
  });

  test('the card lists the words, the rules, the bounds and the never line, and sends nothing @G6.97', async ({ eve, page, relay }) => {
    const since = relay.mark();
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await expect(card.getByText("Act for you while you're away")).toBeVisible();
    await expect(card).toContainText(AFK);
    await expect(card).toContainText('Ledger');
    await expect(card).toContainText('Review');
    await expect(card).toContainText('Yes, go on.');
    await expect(card).toContainText('Window 8 h · Up to 50 messages per agent · At most 2 full verify runs');
    await expect(card).toContainText("Never: merge to main, credentials, publishing outside your repos, deleting, CI, guards or merge-check, tool approvals, anything not listed. Those wait for you.");
    await expect(card.getByText('Waiting for your approval')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    // A card with no tap acts on nothing: no bar, and relay has seen no send.
    await expect(bar(page)).toHaveCount(0);
    expect(await relay.logs({ event: 'chief_of_staff.send', since })).toHaveLength(0);
  });
});

test.describe('bounds from the card', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [delegationPost('c_one', AFK, { windowHours: 3, maxActions: 20, verifyRuns: 0 })],
  });

  test('a card with other bounds shows them on the card and on the bar @G6.97', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await expect(card).toContainText('Window 3 h · Up to 20 messages per agent · At most 0 full verify runs');
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card.getByText(/^Active until \d{2}:\d{2}$/)).toBeVisible();
    await expect(bar(page)).toHaveText(/^Acting for you until \d{2}:\d{2} · 0 sent · up to 20 per agent$/);
  });
});

test.describe('approve', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [delegationPost('c_one', AFK)],
  });

  test('Approve makes the card active and shows the bar @G6.98', async ({ eve, page, relay }) => {
    const since = relay.mark();
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await expect(bar(page)).toHaveCount(0);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    const active = card.getByText(/^Active until \d{2}:\d{2}$/);
    await expect(active).toBeVisible();
    const until = (await active.textContent()).replace('Active until ', '');
    await expect(bar(page)).toHaveText(`Acting for you until ${until} · 0 sent · up to 50 per agent`);
    await expect(card.getByText('Waiting for your approval')).toHaveCount(0);
    // The window is the card's 8 hours from now.
    const eightHours = hhmm(Date.now() + 8 * HOUR);
    const [h, m] = until.split(':').map(Number);
    const [eh, em] = eightHours.split(':').map(Number);
    const apart = Math.abs((h * 60 + m) - (eh * 60 + em));
    expect(Math.min(apart, 1440 - apart)).toBeLessThanOrEqual(2);
    // Acting under the card is a later part: approval alone sends nothing.
    expect(await relay.logs({ event: 'chief_of_staff.send', since })).toHaveLength(0);
  });
});

test.describe('cancel', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [delegationPost('c_one', AFK)],
  });

  test('Cancel makes the card read Cancelled and shows no bar @G6.98', async ({ eve, page, relay }) => {
    const since = relay.mark();
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await expect(bar(page)).toHaveCount(0);
    expect(await relay.logs({ event: 'chief_of_staff.send', since })).toHaveLength(0);
  });
});

test.describe('stop', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [delegationPost('c_one', AFK)],
  });

  test('Stop on the bar ends the card and removes the bar @G6.99', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(bar(page)).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(card.getByText('Ended: you stopped it')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  });
});

test.describe('two cards', () => {
  const FIRST = 'Keep Ledger going until it is ready';
  const SECOND = 'Keep Review going until it is ready';
  // Two posts are seeded through eveFiles: a two-element cosPosts array would read as Playwright's [value, options] pair.
  const posts = [
    delegationPost('c_first', FIRST, {}, [{ kind: 'continue', sessions: [LEDGER], approveIssues: [], buildFromDev: false }]),
    delegationPost('c_second', SECOND, {}, [{ kind: 'continue', sessions: [REVIEW], approveIssues: [], buildFromDev: false }]),
  ];
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    eveFiles: { 'chief-of-staff.jsonl': posts.map((p) => JSON.stringify(p)).join('\n') + '\n' },
  });

  test('approving a second card ends the first @G6.98', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const first = cardOf(page, FIRST);
    const second = cardOf(page, SECOND);
    await first.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(first.getByText(/^Active until/)).toBeVisible();
    await second.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(second.getByText(/^Active until/)).toBeVisible();
    await expect(first.getByText('Ended: replaced by a newer instruction')).toBeVisible();
    // One delegation is active at a time: one bar.
    await expect(bar(page)).toHaveCount(1);
  });
});

test.describe('a session that left', () => {
  const GONE_TEXT = 'Keep Draft going until it is ready';
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [delegationPost('c_gone', GONE_TEXT, {}, [{ kind: 'continue', sessions: [GONE], approveIssues: [], buildFromDev: false }])],
  });

  test('Approve fails the card when a listed session is gone @G6.98.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, GONE_TEXT);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card.getByText('Failed: Draft is gone. Type the instruction again.')).toBeVisible();
    await expect(card.getByText(/^Active until/)).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
  });
});

test.describe('restart with a window still open', () => {
  const until = Math.floor((Date.now() + 3 * HOUR) / 60000) * 60000;
  const post = activePost('c_live', AFK, { until, actions: 3 });
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [post],
    eveFiles: { 'chief-of-staff-delegation.json': stateFile(post, { until, actions: 3 }) },
  });

  test('the card and the bar are there after eve starts again @G6.98', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await expect(card.getByText(`Active until ${hhmm(until)}`)).toBeVisible();
    await expect(bar(page)).toHaveText(`Acting for you until ${hhmm(until)} · 3 sent · up to 50 per agent`);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  });
});

test.describe('restart after the window ended', () => {
  const until = Date.now() - HOUR;
  const post = activePost('c_late', AFK, { until, actions: 2 });
  test.use({
    world: cosWorld(),
    locale: 'en-GB',
    timezoneId: 'UTC',
    cosPosts: [post],
    eveFiles: { 'chief-of-staff-delegation.json': stateFile(post, { until, actions: 2 }) },
  });

  test('a window that ended while eve was down reads Ended: time is up @G6.98', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const card = cardOf(page, AFK);
    await expect(card.getByText('Ended: time is up')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  });
});
