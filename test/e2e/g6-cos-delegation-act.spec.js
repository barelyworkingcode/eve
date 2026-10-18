const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A delegation is seeded active: its card post and the state file eve keeps (docs/api.md, docs/design-chief-of-staff.md).
// A listed session ends a turn when the test sends a message in its thread; the echo (or the model's fixed text) ends it.
// Each session is driven in its own page, so no test has to navigate between threads; a third page reads the Chief of Staff.
// The browser runs in UTC and en-GB, so every HH:MM on screen is the UTC hour and minute of the stored time.

const HOUR = 3600 * 1000;
const AFK = "I'm AFK, continue until ready to merge to main";
const ISSUE = 'acme/app#12';
const QUESTION = 'Shall we go on?';
const REPORT = 'Shipped the change.';
const YES = 'Yes, go on.';
const THANKS = 'Thanks, carry on.';

// Models whose fixed reply decides how a turn ends.
const MODELS = [
  { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'text', text: QUESTION } },
  { value: 'acme-done', label: 'Acme Done', group: 'Claude', provider: 'claude', reply: { kind: 'text', text: 'All finished.' } },
  { value: 'acme-ready', label: 'Acme Ready', group: 'Claude', provider: 'claude', reply: { kind: 'text', text: `${REPORT}\nREADY-FOR-OWNER` } },
  { value: 'acme-tool', label: 'Acme Tool', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  { value: 'acme-crash', label: 'Acme Crash', group: 'Claude', provider: 'claude', reply: { kind: 'exit', code: 1 } },
];

function session(id, name, model) {
  return { id, project_id: 'p_acme', name, model, state: 'idle', messages: [{ role: 'user', text: `${name} question` }, { role: 'assistant', text: `${name} answer` }] };
}

// models: session name to model value; the default is the echo model.
function cosWorld(models = {}, names = ['Ledger', 'Review']) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.models = MODELS;
  w.sessions = names.map((n) => session(`s_${n.toLowerCase()}`, n, models[n] || 'haiku'));
  return w;
}

const ref = (name) => ({ sessionId: `s_${name.toLowerCase()}`, label: name, project: 'Acme' });
const keepGoing = (names, approveIssues = [ISSUE]) => ({ kind: 'continue', sessions: names.map(ref), approveIssues, buildFromDev: false });
const reply = (name, on, text) => ({ kind: 'reply', ...ref(name), on, when: null, text });

// One delegation, active for three more hours, `maxActions` messages per session.
function delegation(rules, maxActions) {
  const until = Math.floor((Date.now() + 3 * HOUR) / 60000) * 60000;
  const approvedAt = new Date(until - 8 * HOUR).toISOString();
  const card = {
    state: 'active', delegationId: 'd_0a1b2c3d', instruction: AFK, rules,
    windowHours: 8, maxActions, verifyRuns: 2, approvedAt, until: new Date(until).toISOString(),
    endedAt: null, endReason: null, actions: 0, turnId: 't_1', error: null,
  };
  const post = { v: 1, id: 'c_act', at: new Date().toISOString(), kind: 'delegation_card', byModel: true, card };
  const sessions = {};
  for (const rule of rules) {
    for (const s of rule.kind === 'continue' ? rule.sessions : [rule]) sessions[s.sessionId] = { ready: false, report: '', waiting: null, actions: 0 };
  }
  const state = JSON.stringify({
    v: 1, delegationId: card.delegationId, postId: post.id, instruction: AFK, rules, maxActions, verifyRuns: 2,
    until: card.until, approvedAt, actions: 0, sessions, log: [],
  });
  return { cosPosts: [post], eveFiles: { 'chief-of-staff-delegation.json': state } };
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

// The end of a turn: a message typed in the session's thread.
async function say(page, name, text) {
  await page.getByRole('button', { name, exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

const sentTo = (relay, id) => relay.waitForEvent('chief_of_staff.send', { match: (e) => e.session_id === id });
const sends = (relay, id) => relay.logs({ event: 'chief_of_staff.send' }).then((l) => l.filter((e) => e.session_id === id));
const card = (cos) => cos.getByRole('article').filter({ hasText: 'Act for you while you' });
const digest = (cos) => cos.getByRole('article').filter({ has: cos.getByRole('heading', { name: 'While you were away' }) });
const chips = (cos, text) => cos.getByText(text, { exact: true });

// A session has settled once relay holds its turn: idle, with the messages the test expects.
async function settled(relay, id, messageCount) {
  await expect.poll(async () => {
    const s = (await relay.json('ctl', 'state', '--json')).sessions.find((x) => x.id === id);
    return s.processing === false && s.messageCount === messageCount;
  }).toBe(true);
}

test.describe('keep going', () => {
  test.use({ world: cosWorld(), locale: 'en-GB', timezoneId: 'UTC', ...delegation([keepGoing(['Ledger', 'Review']), reply('Ledger', 'question', YES)], 1) });

  test('a listed session that ends a turn is sent the keep-going text once and the post says so @G6.100', async ({ eve, page, relay }) => {
    const second = await eve.openAnother('/');
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await expect(cos.getByText(/^Acting for you until \d{2}:\d{2} · 0 sent · up to 1 per agent$/)).toBeVisible();
    await say(page, 'Ledger', 'hello');
    await sentTo(relay, 's_ledger');
    const post = cos.getByRole('article').filter({ has: chips(cos, 'Sent for you · rule 1') });
    await expect(post).toHaveCount(1);
    await expect(post.getByRole('button', { name: 'Ledger', exact: true })).toBeVisible();
    // The text carries the owner's words, the approved issue, the verify bound and the stop line.
    await expect(post).toContainText(`approved this instruction: "${AFK}"`);
    await expect(post).toContainText('Keep going with the approved work until it is ready to merge to main, including the full verifications. Use at most 2 full verify runs.');
    await expect(post).toContainText('Do not merge to main. When the PR to main is ready, run merge-check without --merge and report its verdict.');
    await expect(post).toContainText(`The owner approved these issues for this run: ${ISSUE}. Any other needs-review issue waits for the owner.`);
    await expect(post).toContainText('Do not build new ideas: file them as needs-review.');
    await expect(post).toContainText('end your reply with this line alone: READY-FOR-OWNER');
    // The bar counts it; the other listed session is not at its cap, so the delegation goes on.
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 1 sent · up to 1 per agent$/);
    // The sent text is a user turn in the thread, and its echo ended a turn: at the cap of 1 nothing follows.
    await settled(relay, 's_ledger', 6);
    expect(await sends(relay, 's_ledger')).toHaveLength(1);
    // Nothing but the card and the sent post: no "finished" summary.
    await expect(cos.getByRole('article')).toHaveCount(2);
    await expect(cos.getByRole('article').filter({ hasText: /finished/i })).toHaveCount(0);
  });
});

test.describe('a session off the card', () => {
  // Draft is in the world and in no rule.
  test.use({ world: cosWorld({}, ['Ledger', 'Review', 'Draft']), locale: 'en-GB', timezoneId: 'UTC', ...delegation([keepGoing(['Ledger', 'Review'])], 1) });

  test('a session that is not on the card is sent nothing @G6.100', async ({ eve, page, relay }) => {
    const second = await eve.openAnother('/');
    await eve.open('/');
    await say(page, 'Draft', 'hello');
    await settled(relay, 's_draft', 4);
    // Review's send comes after Draft's turn ended, so eve has seen Draft's end by then.
    await say(second, 'Review', 'hello');
    await sentTo(relay, 's_review');
    expect(await sends(relay, 's_draft')).toHaveLength(0);
  });
});

test.describe('a reply rule', () => {
  test.use({
    world: cosWorld({ Ledger: 'acme-ask', Review: 'acme-done' }),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Review']), reply('Ledger', 'question', YES), reply('Ledger', 'finished', THANKS), reply('Review', 'finished', THANKS)], 1),
  });

  test('on a question sends its text when the session ends a turn on a question @G6.100', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await sentTo(relay, 's_ledger');
    const post = cos.getByRole('article').filter({ has: chips(cos, 'Sent for you · rule 2') });
    await expect(post).toHaveCount(1);
    await expect(post).toContainText(YES);
    // The finished rule for the same session did not match a question.
    await expect(cos.getByText(/^Sent for you/)).toHaveCount(1);
    await settled(relay, 's_ledger', 6);
    expect(await sends(relay, 's_ledger')).toHaveLength(1);
  });

  test('on finished sends its text when the session ends a turn that is not a question @G6.100', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Review', 'hello');
    await sentTo(relay, 's_review');
    // Review is a keep-going session too (rule 1); the reply rule for it (rule 4) wins.
    const post = cos.getByRole('article').filter({ has: chips(cos, 'Sent for you · rule 4') });
    await expect(post).toHaveCount(1);
    await expect(post).toContainText(THANKS);
    await settled(relay, 's_review', 6);
    await expect(cos.getByText(/^Sent for you/)).toHaveCount(1);
  });
});

test.describe('ready for the owner', () => {
  test.use({
    world: cosWorld({ Ledger: 'acme-ready' }),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger', 'Review'])], 1),
  });

  test('a turn whose last line is READY-FOR-OWNER gets no send and the session counts as ready @G6.100', async ({ eve, page, relay }) => {
    const second = await eve.openAnother('/');
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await settled(relay, 's_ledger', 4);
    // Review's send comes after Ledger's turn ended, so eve has seen the ready line by then.
    await say(second, 'Review', 'hello');
    await sentTo(relay, 's_review');
    expect(await sends(relay, 's_ledger')).toHaveLength(0);
    // Ledger is ready and Review is at its cap of 1, so the delegation ends: ready sessions count.
    await expect(card(cos).getByText('Ended: message limit reached')).toBeVisible();
    await expect(digest(cos).getByRole('heading', { name: 'Ready', level: 4 })).toBeVisible();
    await expect(digest(cos).getByRole('listitem').filter({ hasText: `Ledger: ${REPORT}` })).toBeVisible();
  });
});

test.describe('all done', () => {
  test.use({
    world: cosWorld({ Ledger: 'acme-ready' }),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger'])], 5),
  });

  test('when every keep-going session is ready the card ends all done and the digest names the report @G6.101', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await expect(cos.getByText(/^Acting for you until/)).toBeVisible();
    await say(page, 'Ledger', 'hello');
    await expect(card(cos).getByText('Ended: all done')).toBeVisible();
    await expect(cos.getByText(/^Acting for you until/)).toHaveCount(0);
    expect(await sends(relay, 's_ledger')).toHaveLength(0);
    const post = digest(cos);
    await expect(post).toHaveCount(1);
    await expect(post.getByText(/^\d{2}:\d{2} to \d{2}:\d{2} · 0 sent · ended: all done$/)).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Ready', level: 4 })).toBeVisible();
    await expect(post.getByRole('listitem').filter({ hasText: `Ledger: ${REPORT}` })).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Done for you', level: 4 })).toHaveCount(0);
    await expect(post.getByRole('heading', { name: 'Waits for you', level: 4 })).toHaveCount(0);
  });
});

test.describe('the per-session cap', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger', 'Review'])], 2),
  });

  test('a session at its cap gets no more sends, another still does, and the end reads message limit reached @G6.101', async ({ eve, page, relay }) => {
    const second = await eve.openAnother('/');
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    // Each send is echoed, and the echo ends a turn: Ledger gets two sends and then nothing.
    await say(page, 'Ledger', 'hello');
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 2 sent · up to 2 per agent$/);
    await settled(relay, 's_ledger', 8);
    // Ledger is at its cap and Review is not: the delegation goes on and Review is still sent to.
    await expect(card(cos).getByText('Ended: message limit reached')).toHaveCount(0);
    await say(second, 'Review', 'hello');
    await expect(card(cos).getByText('Ended: message limit reached')).toBeVisible();
    expect(await sends(relay, 's_ledger')).toHaveLength(2);
    expect(await sends(relay, 's_review')).toHaveLength(2);
    // The digest: the card, four sends and one digest are the only posts.
    await expect(cos.getByRole('article')).toHaveCount(6);
    const post = digest(cos);
    await expect(post.getByText(/^\d{2}:\d{2} to \d{2}:\d{2} · 4 sent · ended: message limit reached$/)).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Done for you', level: 4 })).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Waits for you', level: 4 })).toBeVisible();
    await expect(post.getByRole('listitem').filter({ hasText: 'Ledger: message limit reached' })).toBeVisible();
    await expect(post.getByRole('listitem').filter({ hasText: 'Review: message limit reached' })).toBeVisible();
  });
});

test.describe('Stop', () => {
  test.use({
    world: cosWorld({ Review: 'acme-ready' }, ['Ledger', 'Review', 'Draft']),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger', 'Review', 'Draft'])], 1),
  });

  test('stopping writes one digest with what was sent, what waits and what is ready @G6.101', async ({ eve, page, relay }) => {
    const second = await eve.openAnother('/');
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(second, 'Review', 'hello');
    await settled(relay, 's_review', 4);
    await say(page, 'Ledger', 'hello');
    await sentTo(relay, 's_ledger');
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 1 sent · up to 1 per agent$/);
    await cos.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(card(cos).getByText('Ended: you stopped it')).toBeVisible();
    const post = digest(cos);
    await expect(post).toHaveCount(1);
    await expect(post.getByText(/^\d{2}:\d{2} to \d{2}:\d{2} · 1 sent · ended: you stopped it$/)).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Done for you', level: 4 })).toBeVisible();
    await expect(post.getByRole('listitem').filter({ hasText: 'Ledger: The owner is away.' })).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Waits for you', level: 4 })).toBeVisible();
    await expect(post.getByRole('listitem').filter({ hasText: 'Ledger: message limit reached' })).toBeVisible();
    await expect(post.getByRole('heading', { name: 'Ready', level: 4 })).toBeVisible();
    await expect(post.getByRole('listitem').filter({ hasText: `Review: ${REPORT}` })).toBeVisible();
  });
});

test.describe('a session that asks or errors', () => {
  test.use({
    world: cosWorld({ Ledger: 'acme-tool', Review: 'acme-crash' }, ['Ledger', 'Review', 'Draft']),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger', 'Review', 'Draft'])], 3),
  });

  test('a session that asks for a tool approval gets no delegated action @G6.100', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'run it from testbox');
    await expect(cos.getByRole('heading', { name: 'Ledger is asking you something' })).toBeVisible();
    expect(await sends(relay, 's_ledger')).toHaveLength(0);
  });

  test('a session that errors gets no delegated action @G6.100', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Review', 'hello');
    await expect(cos.getByRole('heading', { name: 'Review stopped with an error' })).toBeVisible();
    expect(await sends(relay, 's_review')).toHaveLength(0);
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 0 sent · up to 3 per agent$/);
  });
});

test.describe('a send that relay refuses', () => {
  test.use({
    world: cosWorld(),
    locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger', 'Review'])], 1),
  });

  test('posts the usual failure line and does not count toward the cap @G6.100.r1', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/chief-of-staff/messages', '--mode', 'error', '--times', '1', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    await say(page, 'Ledger', 'hello');
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(cos.getByText(/^Sent for you/)).toHaveCount(0);
    await expect(cos.getByText('Relay refused the send (boom).')).toBeVisible();
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 0 sent · up to 1 per agent$/);
    // The refused send did not use the cap of 1: the next turn end is sent to.
    const box = page.getByRole('textbox', { name: 'Type your message...' });
    await box.fill('again');
    await box.press('Enter');
    await expect(cos.getByText('Sent for you · rule 1', { exact: true })).toBeVisible();
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 1 sent · up to 1 per agent$/);
  });
});
