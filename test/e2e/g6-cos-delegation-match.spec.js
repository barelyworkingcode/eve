const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A reply rule with a condition (`when`) is matched to a turn end by the wake model: the Chief of Staff's
// summaryModel, a world model here whose fixed reply is the match JSON (docs/design-chief-of-staff.md).
// Seeding follows g6-cos-delegation-act.spec.js: the delegation is seeded active, with the card post and the state file.
// The browser runs in UTC and en-GB, so every HH:MM on screen is the UTC hour and minute of the stored time.

const HOUR = 3600 * 1000;
const AFK = "I'm AFK, say continue to Ledger if it asks to proceed";
const ISSUE = 'acme/app#12';
const QUESTION = 'Shall we go on?';
const WHEN = 'it asks to proceed';
const NO_RULE = "No rule covers Ledger's last turn; it waits for you.";

function session(id, name, model) {
  return { id, project_id: 'p_acme', name, model, state: 'idle', messages: [{ role: 'user', text: `${name} question` }, { role: 'assistant', text: `${name} answer` }] };
}

const fence = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
const matches = (...list) => ({ kind: 'text', text: fence({ matches: list.map(([sessionId, rule]) => ({ sessionId, rule })) }) });

// matchReply: what the wake model answers, every time it is asked anything.
function cosWorld(matchReply, { calls = 20, names = ['Ledger', 'Review'] } = {}) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: calls };
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'text', text: QUESTION } },
    { value: 'acme-match', label: 'Acme Match', group: 'Claude', provider: 'claude', reply: matchReply },
  ];
  w.sessions = names.map((n) => session(`s_${n.toLowerCase()}`, n, 'acme-ask'));
  return w;
}

const ref = (name) => ({ sessionId: `s_${name.toLowerCase()}`, label: name, project: 'Acme' });
const keepGoing = (names, approveIssues = [ISSUE]) => ({ kind: 'continue', sessions: names.map(ref), approveIssues, buildFromDev: false });
const reply = (name, on, text, when = null) => ({ kind: 'reply', ...ref(name), on, when, text });

// One delegation, active for three more hours, one message per session.
// `files` adds data-dir files, such as a seeded day's model-call count.
function delegation(rules, files = {}) {
  const until = Math.floor((Date.now() + 3 * HOUR) / 60000) * 60000;
  const approvedAt = new Date(until - 8 * HOUR).toISOString();
  const card = {
    state: 'active', delegationId: 'd_0a1b2c3d', instruction: AFK, rules,
    windowHours: 8, maxActions: 1, verifyRuns: 2, approvedAt, until: new Date(until).toISOString(),
    endedAt: null, endReason: null, actions: 0, turnId: 't_1', error: null,
  };
  const post = { v: 1, id: 'c_match', at: new Date().toISOString(), kind: 'delegation_card', byModel: true, card };
  const sessions = {};
  for (const rule of rules) {
    for (const s of rule.kind === 'continue' ? rule.sessions : [rule]) sessions[s.sessionId] = { ready: false, report: '', waiting: null, actions: 0 };
  }
  const state = JSON.stringify({
    v: 1, delegationId: card.delegationId, postId: post.id, instruction: AFK, rules, maxActions: 1, verifyRuns: 2,
    until: card.until, approvedAt, actions: 0, sessions, log: [],
  });
  return {
    cosPosts: [post],
    eveSettings: { chiefOfStaff: { summaryModel: 'acme-match' } },
    eveFiles: { 'chief-of-staff-delegation.json': state, ...files },
  };
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

// The end of a turn: a message typed in the session's thread; the session answers with its question.
async function say(page, name, text) {
  await page.getByRole('button', { name, exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

const sentTo = (relay, id) => relay.waitForEvent('chief_of_staff.send', { match: (e) => e.session_id === id });
const sends = (relay, id) => relay.logs({ event: 'chief_of_staff.send' }).then((l) => l.filter((e) => e.session_id === id));
const chip = (cos, text) => cos.getByText(text, { exact: true });

const noRule = (cos) => cos.getByText(NO_RULE, { exact: true });
const post = (cos, text) => cos.getByRole('article').filter({ has: chip(cos, text) });
const digest = (cos) => cos.getByRole('article').filter({ has: cos.getByRole('heading', { name: 'While you were away' }) });

// A session has settled once relay holds its turn: idle, with the messages the test expects.
async function settled(relay, id, messageCount) {
  await expect.poll(async () => {
    const s = (await relay.json('ctl', 'state', '--json')).sessions.find((x) => x.id === id);
    return s.processing === false && s.messageCount === messageCount;
  }).toBe(true);
}

// Model calls the wake session made so far: one chat turn each, bootstrap included.
async function wakeTurns(relay) {
  const ids = (await relay.json('ctl', 'state', '--json')).sessions.filter((s) => s.name.startsWith('__cos:')).map((s) => s.id);
  return (await relay.logs({ event: 'chat.turn' })).filter((e) => ids.includes(e.session_id)).length;
}

const RULE_LEDGER = reply('Ledger', 'question', 'continue', WHEN);

test.describe('a match', () => {
  test.use({
    world: cosWorld(matches(['s_ledger', 0])), locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([RULE_LEDGER]),
  });

  test('a reply rule with a condition sends its text when the model matches the turn to it @G6.102', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await sentTo(relay, 's_ledger');
    const sent = post(cos, 'Sent for you · rule 1');
    await expect(sent).toHaveCount(1);
    await expect(sent.getByRole('button', { name: 'Ledger', exact: true })).toBeVisible();
    await expect(sent).toContainText('continue');
    await expect(noRule(cos)).toHaveCount(0);
  });
});

test.describe('no rule matches', () => {
  test.use({
    world: cosWorld(matches(['s_ledger', null])), locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([RULE_LEDGER]),
  });

  test('a reply rule with a condition does not send when the model matches no rule @G6.102', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await expect(noRule(cos)).toBeVisible();
    expect(await sends(relay, 's_ledger')).toHaveLength(0);
    await expect(cos.getByText(/^Sent for you/)).toHaveCount(0);
    await expect(cos.getByText(/^Acting for you until/)).toHaveText(/ · 0 sent · up to 1 per agent$/);
  });

  test('the thread says no rule covers the last turn and the digest lists the agent @G6.102', async ({ eve, page }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await expect(noRule(cos)).toBeVisible();
    await cos.getByRole('button', { name: 'Stop', exact: true }).click();
    const end = digest(cos);
    await expect(end).toHaveCount(1);
    await expect(end.getByRole('heading', { name: 'Waits for you', level: 4 })).toBeVisible();
    await expect(end.getByRole('listitem').filter({ hasText: 'Ledger: no rule matched' })).toBeVisible();
  });
});

test.describe('the model fails', () => {
  test.use({
    world: cosWorld({ kind: 'fail' }), locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([RULE_LEDGER]),
  });

  test('a failed model turn sends nothing from the rule @G6.102.r1', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await expect(noRule(cos)).toBeVisible();
    expect(await sends(relay, 's_ledger')).toHaveLength(0);
    await expect(cos.getByText(/^Sent for you/)).toHaveCount(0);
  });
});

test.describe('the daily limit is used up', () => {
  // The model would match, but today's calls are at the limit of 20.
  const today = new Date().toISOString().slice(0, 10);
  test.use({
    world: cosWorld(matches(['s_ledger', 0]), { calls: 20 }), locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([RULE_LEDGER], { 'chief-of-staff-state.json': JSON.stringify({ day: today, calls: 20, rowCalls: 0 }) }),
  });

  test('a limit that is used up sends nothing from the rule and costs no call @G6.102.r1', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await expect(noRule(cos)).toBeVisible();
    expect(await sends(relay, 's_ledger')).toHaveLength(0);
    await expect(cos.getByText(/^Sent for you/)).toHaveCount(0);
    expect(await wakeTurns(relay)).toBe(0);
  });
});

test.describe('a match that names another rule', () => {
  // Rule 1 is Ledger's, rule 2 is Review's, rule 3 is Ledger's on another trigger.
  const rules = [RULE_LEDGER, reply('Review', 'question', 'go ahead', WHEN), reply('Ledger', 'finished', 'wrap up', WHEN)];

  test.describe('of another agent', () => {
    test.use({ world: cosWorld(matches(['s_ledger', 1])), locale: 'en-GB', timezoneId: 'UTC', ...delegation(rules) });

    test('is ignored @G6.102.r2', async ({ eve, page, relay }) => {
      const cos = await eve.openAnother('/');
      await eve.open('/');
      await openCos(cos);
      await say(page, 'Ledger', 'hello');
      await expect(noRule(cos)).toBeVisible();
      expect(await sends(relay, 's_ledger')).toHaveLength(0);
      expect(await sends(relay, 's_review')).toHaveLength(0);
      await expect(cos.getByText(/^Sent for you/)).toHaveCount(0);
    });
  });

  test.describe('of another trigger', () => {
    test.use({ world: cosWorld(matches(['s_ledger', 2])), locale: 'en-GB', timezoneId: 'UTC', ...delegation(rules) });

    test('is ignored @G6.102.r2', async ({ eve, page, relay }) => {
      const cos = await eve.openAnother('/');
      await eve.open('/');
      await openCos(cos);
      await say(page, 'Ledger', 'hello');
      await expect(noRule(cos)).toBeVisible();
      expect(await sends(relay, 's_ledger')).toHaveLength(0);
      await expect(cos.getByText(/^Sent for you/)).toHaveCount(0);
    });
  });

  test.describe('for an agent that did not end a turn', () => {
    test.use({ world: cosWorld(matches(['s_review', 1])), locale: 'en-GB', timezoneId: 'UTC', ...delegation(rules) });

    test('is ignored @G6.102.r2', async ({ eve, page, relay }) => {
      const cos = await eve.openAnother('/');
      await eve.open('/');
      await openCos(cos);
      await say(page, 'Ledger', 'hello');
      await expect(noRule(cos)).toBeVisible();
      expect(await sends(relay, 's_ledger')).toHaveLength(0);
      expect(await sends(relay, 's_review')).toHaveLength(0);
    });
  });
});

test.describe('a match turn', () => {
  // Draft warms the wake model (its first call is a bootstrap); Review has an unconditional rule, so its turn end
  // costs no match turn; Ledger has a conditional one. The calls each turn end adds differ by the match turn.
  const rules = [reply('Draft', 'question', 'one', null), reply('Review', 'question', 'two', null), RULE_LEDGER];
  test.use({
    world: cosWorld(matches(['s_ledger', 2]), { names: ['Ledger', 'Review', 'Draft'] }), locale: 'en-GB', timezoneId: 'UTC',
    ...delegation(rules),
  });

  test('counts one model call @G6.102.r2', async ({ eve, page, relay }) => {
    const second = await eve.openAnother('/');
    const third = await eve.openAnother('/');
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    const finish = async (name) => {
      await sentTo(relay, `s_${name.toLowerCase()}`);
      await expect(cos.getByRole('heading', { name: `${name} asked you a question` })).toBeVisible();
      await settled(relay, `s_${name.toLowerCase()}`, 6);
    };
    await say(page, 'Draft', 'hello');
    await finish('Draft');
    const start = await wakeTurns(relay);
    await say(second, 'Review', 'hello');
    await finish('Review');
    const afterReview = await wakeTurns(relay);
    await say(third, 'Ledger', 'hello');
    await finish('Ledger');
    const afterLedger = await wakeTurns(relay);
    await expect(post(cos, 'Sent for you · rule 3')).toHaveCount(1);
    expect(afterLedger - afterReview).toBe(afterReview - start + 1);
  });
});

test.describe('no condition matches, on keep-going', () => {
  test.use({
    world: cosWorld(matches(['s_ledger', null])), locale: 'en-GB', timezoneId: 'UTC',
    ...delegation([keepGoing(['Ledger']), reply('Ledger', 'question', 'rule text only', WHEN)]),
  });

  test('the keep-going text goes instead @G6.102', async ({ eve, page, relay }) => {
    const cos = await eve.openAnother('/');
    await eve.open('/');
    await openCos(cos);
    await say(page, 'Ledger', 'hello');
    await sentTo(relay, 's_ledger');
    const sent = post(cos, 'Sent for you · rule 1');
    await expect(sent).toHaveCount(1);
    await expect(sent).toContainText('Keep going with the approved work until it is ready to merge to main');
    await expect(noRule(cos)).toHaveCount(0);
    await expect(sent).not.toContainText('rule text only');
  });
});
