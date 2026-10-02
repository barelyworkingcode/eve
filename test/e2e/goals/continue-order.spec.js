// Today's Continue lists threads newest first by one time per thread: the later
// of when this browser last opened it and its last server activity. A running
// (active) thread is not moved up for being active; Running shows those.
const { test, expect } = require('./fixture');
const { MODELS } = require('./fixture');
const { backToToday, startChatInAlpha } = require('./today-helpers');

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const rows = (page) => page.locator('[data-testid^="home-session-"]');

test.use({
  world: {
    seed: ({ relay, folders }) => {
      relay.setModels(MODELS);
      const thread = (sessionId, name, live, msAgo) => relay.seedSession({
        sessionId, projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name, history: [],
        live, createdAt: iso(msAgo + HOUR), lastMessageAt: iso(msAgo), messageCount: 2,
      });
      // More active threads than Continue has rows, all older than s-new.
      for (let i = 1; i <= 7; i++) thread(`s-active-${i}`, `Agent ${i}`, true, (i + 1) * HOUR);
      thread('s-new', 'Made on another device', false, 10 * 60 * 1000);
      thread('s-old', 'Yesterday\'s thread', false, 30 * HOUR);
    },
  },
});

test.describe('Continue order with many active threads', () => {
  test('the newest thread shows first though this browser never opened it', async ({ page }) => {
    await expect(page.getByTestId('home-session-s-new')).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute('data-testid', 'home-session-s-new');
    await expect(rows(page)).toHaveCount(6);
  });

  test('a thread opened here after any server activity ranks first', async ({ page }) => {
    await page.waitForFunction(() => window.client.state.sessions.has('s-old'));
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('Yesterday');
    await page.getByTestId('palette-item').filter({ hasText: 'Yesterday\'s thread' }).click();
    await expect(page).toHaveURL(/#session\/s-old/);
    await page.reload(); // Continue paints on load; a live repaint on return is not what this asserts
    await backToToday(page);
    await expect(rows(page).first()).toHaveAttribute('data-testid', 'home-session-s-old');
  });
});

test.describe('Continue after starting a thread here', () => {
  test('a new thread shows in Continue on return to Today', async ({ page }) => {
    const sessionId = await startChatInAlpha(page);
    await backToToday(page);
    await expect(page.getByTestId('home-screen').getByTestId(`home-session-${sessionId}`)).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute('data-testid', `home-session-${sessionId}`);
  });
});
