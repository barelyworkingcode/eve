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
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';
const WAIT = { timeout: 15000 };

const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cos-')));
    const eve = await startEve({
      projects: [{ id: 'p1', name: 'Acme', path: dir }],
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

test('"tell <name> to ..." sends at once with no dialog, and the target chat shows the origin chip live and after a re-join', async ({ page, eve }) => {
  eve.relay.setCosModel({
    reply: (text, n) => (n === 1 ? 'ready'
      : text.startsWith('Chief of Staff person') ? fence({ reply: 'Sending it.', send: { sessionId: 's1', text: 'merge after CI' } }) : null),
  });
  await page.getByTestId('today-agent-s1').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await openThread(page);

  await page.getByTestId('cos-input').fill('tell Agent s1 to merge after CI');
  await page.getByTestId('cos-input').press('Enter');
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
