// eve#197: the Chief of Staff thread. Sessions that need me arrive as posts with a card,
// I tell an agent something in plain words, and the agent's chat shows who sent it.
// Doors: sidebar-chief-of-staff (wide), nav-chief-of-staff (phone). docs/design-chief-of-staff.md
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hermeticTest, gotoEve, reloadEve, expect } = require('../fixtures');
const { startEve } = require('../../integration/harness');
const { relayFrames } = require('../../integration/protocol');

const MODEL = 'claude-haiku-4-5-20251001';
const WAIT = { timeout: 15000 };
const INTERNAL_SECRET = 'e2e-internal-secret';

const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cos-')));
    const eve = await startEve({
      projects: [{ id: 'p1', name: 'Acme', path: dir }],
      env: { EVE_INTERNAL_SECRET: INTERNAL_SECRET },
      seedDataDir: async (dataDir) => {
        await fs.promises.writeFile(path.join(dataDir, 'settings.json'),
          JSON.stringify({ chiefOfStaff: { model: 'haiku', projectId: 'p1', dailyModelCalls: 100 } }));
      },
    });
    try {
      await eve.relay.waitForScopedRelay();
      eve.relay.seedSession({
        sessionId: 's1', name: 'Agent s1', projectId: 'p1', directory: dir, model: MODEL, headless: true, agent: true,
        attention: { state: 'running', since: '2026-10-05T10:00:00.000Z' },
        history: [relayFrames.historyUser({ timestamp: '2026-10-05T10:00:00.000Z', content: 'Run the release script, please' })],
      });
      await use(eve);
    } finally {
      await eve.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

const ask = (relay) => relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'asking' }));
const avatarDot = (page) => page.getByTestId('cos-pill').getByTestId('cos-avatar').locator('i');

async function openThread(page) {
  await page.getByTestId('sidebar-chief-of-staff').click();
  await expect(page.getByTestId('cos-page')).toBeVisible();
}

test.describe('doors', () => {
  test('the sidebar button opens the thread on a wide screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId('sidebar-chief-of-staff').click();
    await expect(page.getByTestId('cos-page')).toBeVisible();
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
    test('the bottom bar button opens the thread', async ({ page }) => {
      await page.getByTestId('nav-chief-of-staff').click();
      await expect(page.getByTestId('cos-page')).toBeVisible();
    });
  });
});

test('an asking session gets a post with a card and Answer, Drop in and Open; Open opens that session', async ({ page, eve }) => {
  await openThread(page);
  await ask(eve.relay);
  const post = page.locator('[data-testid^="cos-post-"]').first();
  await expect(post).toBeVisible(WAIT);
  const card = post.locator('[data-testid^="cos-card-"][data-state="asking"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-session-id', 's1');
  await expect(post.locator('[data-testid^="cos-answer-"]')).toBeVisible();
  await expect(post.locator('[data-testid^="cos-drop-in-"]')).toBeVisible();
  await post.locator('[data-testid^="cos-open-"]').click();
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.getByTestId('chat-input')).toBeVisible();
  // Open joins the session, so its thread shows what it was asked.
  await expect(page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: 'Run the release script' })).toBeVisible(WAIT);
});

test('the avatar breathes only while the model works', async ({ page, eve }) => {
  const gate = eve.relay.holdSessionCreate();
  await openThread(page);
  await ask(eve.relay);
  await expect(page.getByTestId('cos-pill').getByTestId('cos-avatar')).toHaveAttribute('data-busy', '', WAIT);
  expect(await avatarDot(page).evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
  gate.release();
  await expect(page.locator('[data-testid^="cos-post-"]').first()).toBeVisible(WAIT);
  await expect(page.getByTestId('cos-pill').getByTestId('cos-avatar')).not.toHaveAttribute('data-busy', WAIT);
});

test('with reduced motion the busy avatar does not animate', async ({ page, eve }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const gate = eve.relay.holdSessionCreate();
  try {
    await openThread(page);
    await ask(eve.relay);
    await expect(page.getByTestId('cos-pill').getByTestId('cos-avatar')).toHaveAttribute('data-busy', '', WAIT);
    expect(await avatarDot(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  } finally { gate.release(); }
});

// eve#249: relay names a project eve cannot find, so the Chief of Staff is off and the banner
// points to relay's Settings.
test('the off banner points to relay\'s Settings when no project can run the Chief of Staff', async ({ page, eve }) => {
  eve.relay.setChiefOfStaffConfig({ projectId: 'ghost', model: 'haiku', dailyModelCalls: 100 });
  await openThread(page);
  await page.getByTestId('cos-input').fill('hello');
  await page.getByTestId('cos-input').press('Enter');
  await expect(page.getByTestId('cos-off')).toHaveText(
    "No project can run the Chief of Staff. Pick one in relay's Settings, under Projects > Chief of Staff.", WAIT);
});

// The person model streams the given tool_use blocks and holds its turn open; the test makes the
// eve-cos call while the turn is held, as relay's MCP would, then lets the turn end. Returns the result.
async function callCosTool(page, eve, { say, toolUses, tool, args, replyText }) {
  let release;
  const gate = new Promise((r) => { release = r; });
  eve.relay.setCosModel({
    reply: (text, n) => (n === 1 ? 'ready'
      : text.startsWith('Chief of Staff person') ? { toolUses, gate, text: replyText } : null),
  });
  const held = eve.relay.waitForCosTurn((t) => t.text.startsWith('Chief of Staff person') && t.text.includes(say));
  await page.getByTestId('cos-input').fill(say);
  await page.getByTestId('cos-input').press('Enter');
  await held;
  try {
    const res = await fetch(`${eve.baseUrl}/internal/cos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-eve-internal': INTERNAL_SECRET },
      body: JSON.stringify({ tool, args, meta: { project_id: 'p1' } }),
    });
    return (await res.json()).result;
  } finally { release(); }
}

test('"tell <name> to ..." sends at once with no dialog, and the target chat shows the origin chip live and after a re-join', async ({ page, eve }) => {
  await page.getByTestId('today-agent-s1').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await openThread(page);

  const sendArgs = { sessionId: 's1', text: 'merge after CI' };
  const result = await callCosTool(page, eve, {
    say: 'tell Agent s1 to merge after CI',
    toolUses: [{ id: 'c1', name: 'mcp__relay__cos_propose_send', input: sendArgs }],
    tool: 'cos_propose_send', args: sendArgs, replyText: 'Sending it.',
  });
  expect(result.status).toBe('sent');
  const sent = page.locator('[data-testid^="cos-post-"][data-kind="sent"]');
  await expect(sent).toBeVisible(WAIT);
  await expect(sent.getByTestId('cos-sent-chip')).toBeVisible();
  await expect(page.locator('dialog[open], [role="dialog"], [aria-modal="true"]')).toHaveCount(0);

  await page.getByTestId('tab-s1').click();
  await expect(page.getByTestId('message-origin-chip')).toBeVisible(WAIT);

  await reloadEve(page);
  await page.getByTestId('tab-s1').click();
  await expect(page.getByTestId('message-origin-chip')).toBeVisible(WAIT);
});

// eve#238: a Start card for an agent the Chief of Staff proposed after reading a file. The model
// session streams a Read and a cos_propose_start; the test makes the eve-cos call while the turn is
// held open, as relay's MCP would, then lets the turn end.
const START_ARGS = { project: 'Acme', prompt: 'composed after reading notes' };

async function proposeStart(page, eve) {
  const result = await callCosTool(page, eve, {
    say: 'start an agent on Acme',
    toolUses: [
      { id: 'r1', name: 'Read', input: { file_path: 'notes.txt' } },
      { id: 'c1', name: 'mcp__relay__cos_propose_start', input: START_ARGS },
    ],
    tool: 'cos_propose_start', args: START_ARGS, replyText: 'Proposed it.',
  });
  expect(result.status).toBe('card');
  const card = page.locator('[data-testid^="cos-card-"][data-kind="start"]');
  await expect(card).toBeVisible(WAIT);
  const id = (await card.getAttribute('data-testid')).slice('cos-card-'.length);
  return { card, id };
}

test.describe('Start card', () => {
  test.beforeEach(async ({ page }) => { await openThread(page); });

  test('shows project, folder, model, mode and prompt; Start starts the agent and the thread posts its name with an Open link', async ({ page, eve }) => {
    const { card, id } = await proposeStart(page, eve);
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card).toContainText('Acme');
    await expect(card).toContainText('composed after reading notes');
    await expect(card).toContainText('haiku');
    await expect(card).toContainText('headless');
    await expect(card.locator('[data-field="folder"]')).toBeVisible();
    expect(eve.relay.cosStarts).toHaveLength(0);

    await page.getByTestId(`cos-start-${id}`).click();
    await expect(card).toHaveAttribute('data-state', 'started', WAIT);
    expect(eve.relay.cosStarts).toHaveLength(1);
    expect(eve.relay.cosStarts[0].body).toMatchObject({ projectId: 'p1', prompt: 'composed after reading notes', mode: 'headless' });

    const started = page.locator('[data-testid^="cos-post-"][data-kind="started"]');
    await expect(started).toBeVisible(WAIT);
    await started.locator('[data-testid^="cos-open-"]').click();
    await expect(page).toHaveURL(/#session\/sess-/);
  });

  test('Edit changes the prompt, and Start sends the edited prompt', async ({ page, eve }) => {
    const { card, id } = await proposeStart(page, eve);
    await page.getByTestId(`cos-edit-${id}`).click();
    await page.getByTestId(`cos-edit-prompt-${id}`).fill('the prompt I wrote myself');
    await page.getByTestId(`cos-start-${id}`).click();
    await expect(card).toHaveAttribute('data-state', 'started', WAIT);
    expect(eve.relay.cosStarts.map((c) => c.body.prompt)).toEqual(['the prompt I wrote myself']);
  });

  test('Cancel ends the card and starts nothing', async ({ page, eve }) => {
    const { card, id } = await proposeStart(page, eve);
    await page.getByTestId(`cos-cancel-${id}`).click();
    await expect(card).toHaveAttribute('data-state', 'cancelled', WAIT);
    await expect(page.getByTestId(`cos-start-${id}`)).toBeDisabled();
    expect(eve.relay.cosStarts).toHaveLength(0);
  });
});

// The session list a person can see is the project page's thread list (`project-thread-<id>`);
// the chip (`session-origin-chip`) sits on the row of a session relay marks with that origin.
test('the session list marks a session the Chief of Staff started and no other', async ({ page, eve }) => {
  const base = { projectId: 'p1', directory: '/tmp', model: MODEL };
  eve.relay.seedSession({ ...base, sessionId: 's2', name: 'Started by the chief', origin: 'chief-of-staff' });
  eve.relay.seedSession({ ...base, sessionId: 's3', name: 'Started by me' });
  await reloadEve(page);
  await page.evaluate(() => { window.location.hash = '#project/p1'; });
  const marked = page.getByTestId('project-thread-s2');
  await expect(marked).toBeVisible(WAIT);
  await expect(page.getByTestId('project-thread-s3')).toBeVisible();
  await expect(marked.getByTestId('session-origin-chip')).toBeVisible();
  await expect(page.getByTestId('project-thread-s3').getByTestId('session-origin-chip')).toHaveCount(0);
});

// eve#273: an errand (a session the Chief of Staff sent a message to) posts a finished summary
// when its turn ends idle; the post names the agent and project, and Open opens the session.
test('a finished errand posts its name, project and summary, and Open opens the session', async ({ page, eve }) => {
  await openThread(page);
  const sendArgs = { sessionId: 's1', text: 'merge after CI' };
  await callCosTool(page, eve, {
    say: 'tell Agent s1 to merge after CI',
    toolUses: [{ id: 'c1', name: 'mcp__relay__cos_propose_send', input: sendArgs }],
    tool: 'cos_propose_send', args: sendArgs, replyText: 'Sending it.',
  });
  await expect(page.locator('[data-testid^="cos-post-"][data-kind="sent"]')).toBeVisible(WAIT);

  eve.relay.setCosModel({
    reply: (text, n) => (n === 1 ? 'ready'
      : text.startsWith('Chief of Staff finished') ? '```json\n{"posts":[{"sessionId":"s1","summary":"Merged the branch.\\nAll checks passed."}]}\n```' : null),
  });
  eve.relay.emitToRelay(relayFrames.turnDone({ sessionId: 's1', excerpt: 'Merged the branch. All checks passed.' }));
  eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'idle' }));

  const post = page.locator('[data-testid^="cos-post-"][data-kind="finished"]');
  await expect(post).toBeVisible(WAIT);
  await expect(post.locator('h3')).toHaveText('Agent s1 finished');
  await expect(post).toContainText('Acme');
  await expect(post.locator('[data-testid^="cos-finished-summary-"]')).toHaveText('Merged the branch.\nAll checks passed.');
  await post.locator('[data-testid^="cos-open-"]').click();
  await expect(page).toHaveURL(/#session\/s1$/);
});
