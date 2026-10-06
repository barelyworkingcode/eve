// Characterization of the Home screen as it is today (public/home-screen.js has
// no other test). The Home|Work epic replaces it; a slice that changes any of
// this on purpose rewrites the matching assertion in the same PR.
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test.describe('Home greeting follows the hour', () => {
  for (const [hour, greeting] of [[3, 'Working late.'], [9, 'Good morning.'], [14, 'Good afternoon.'], [19, 'Good evening.'], [23, 'Working late.']]) {
    test(`${String(hour).padStart(2, '0')}:00 says "${greeting}"`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(2026, 0, 15, hour, 0, 0));
      await reloadEve(page);
      await expect(page.locator('.home__greeting')).toHaveText(greeting);
    });
  }
});

test.describe('Home start tiles', () => {
  test.use({
    world: {
      seed: ({ relay }) => {
        relay.setTerminalTemplates([
          { id: 'shell', name: 'Shell', description: 'Plain shell (sandboxed)' },
          { id: 'claude-code', name: 'Claude Code', description: 'Claude Code CLI; asks before acting' },
          { id: 'third', name: 'Third', description: 'Never shown' },
        ]);
      },
    },
  });

  test('with a project active: Chat, the first two terminal templates, then Voice', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await expect(page.locator('.home__eyebrow-detail')).toHaveText('in Alpha Project');
    const tiles = page.locator('.home__tile');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0)).toHaveAttribute('data-testid', 'home-tile-chat');
    await expect(tiles.nth(1)).toHaveAttribute('data-testid', 'home-tile-shell');
    await expect(tiles.nth(2)).toHaveAttribute('data-testid', 'home-tile-claude-code');
    await expect(tiles.nth(3)).toHaveAttribute('data-testid', 'home-tile-voice');
    await expect(page.getByTestId('home-tile-shell')).toContainText('Plain shell');
    await expect(page.getByTestId('home-tile-claude-code')).toContainText('Claude Code CLI');
  });

  test('a template tile opens that terminal in the active project', async ({ page, eve }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('home-tile-shell').click();
    await expect(page.locator('#terminal')).toBeVisible();
    await expect.poll(() => eve.relay.listTerminals().length).toBe(1);
    expect(eve.relay.listTerminals()[0]).toMatchObject({ templateId: 'shell', directory: eve.folders.alpha });
  });

  test('the Voice tile opens the launcher on voice', async ({ page }) => {
    await page.getByTestId('home-tile-voice').click();
    await expect(page.getByTestId('dialog-shell-launcher-dialog')).toBeVisible();
  });
});

test.describe('Home continue list', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        for (let i = 0; i < 9; i++) {
          relay.seedSession({
            sessionId: `s${i}`, projectId: i % 2 ? 'beta' : 'alpha', directory: i % 2 ? folders.beta : folders.alpha, model: 'vendor/deep-model',
            name: `Thread ${i}`, live: false, createdAt: iso((20 - i) * HOUR), lastMessageAt: iso((10 - i) * HOUR), messageCount: 1,
          });
        }
        // A task run is a headless session and never a thread.
        relay.seedSession({ sessionId: 'run1', projectId: 'alpha', directory: folders.alpha, model: 'm', name: 'Nightly run', live: false, createdAt: iso(HOUR), lastMessageAt: iso(HOUR / 2), messageCount: 2, headless: true });
        relay.seedTask({ id: 'tn', name: 'Nightly', projectId: 'alpha', prompt: 'p', model: 'm', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless', lastSessionId: 'run1', lastStatus: 'success' });
      },
    },
  });

  test('shows the six newest by server activity, with project and the model\'s last path segment', async ({ page }) => {
    const rows = page.locator('[data-testid^="home-session-"]');
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toHaveAttribute('data-testid', 'home-session-s8');
    await expect(rows.first()).toContainText('Thread 8');
    await expect(rows.first()).toContainText('Alpha Project · deep-model');
    await expect(page.getByTestId('home-session-s1')).toHaveCount(0); // older than the six
  });

  test('never lists the headless run behind a task', async ({ page }) => {
    await expect(page.getByTestId('home-session-run1')).toHaveCount(0);
  });

  // CHANGED by S1-A8 (docs/design-today-s1.md): the known-bug marker (test.fail) is
  // gone; the chip now activates its project and the assertions below hold.
  test('the project chip activates the project; the active one is marked', async ({ page }) => {
    await page.getByTestId('home-project-beta').click();
    await expect(page.locator('#panelTitle')).toHaveText('Beta Project', { timeout: 3000 });
    await expect(page.getByTestId('home-project-beta')).toHaveClass(/home__chip--active/);
    await expect(page.getByTestId('home-project-alpha')).not.toHaveClass(/home__chip--active/);
  });

  test('the active project is the one the panel shows, and its chip is marked', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true }).click();
    await expect(page.locator('#panelTitle')).toHaveText('Beta Project');
    await expect(page.getByTestId('home-project-beta')).toHaveClass(/home__chip--active/);
    await expect(page.getByTestId('home-project-alpha')).not.toHaveClass(/home__chip--active/);
  });
});

test.describe('Home when relay is unreachable at load', () => {
  // CHANGED by S1-A3c (docs/design-today-s1.md): this used to pin that Home offers
  // "Start with a project" because no project could be loaded. With relay down the
  // projects are unknown, not absent: the connection is reported, each part that
  // needs relay says so with a Retry, and first-run is not offered.
  test('reports the lost connection and says what could not load; it does not offer first-run', async ({ page, eve }) => {
    await eve.relay.close();
    await reloadEve(page);
    await expect(page.locator('.home__greeting')).toBeVisible();
    await expect(page.locator('#connectionBanner, .connection-banner').first()).toContainText('Reconnecting…');
    await expect(page.locator('.toast')).toContainText('Lost connection to relay');
    await expect(page.getByRole('heading', { name: 'Start with a project' })).toHaveCount(0);
    await expect(page.getByTestId('today-error-projects')).toContainText("Can't reach relay");
    await expect(page.getByTestId('today-retry-projects')).toBeVisible();
    await expect(page.locator('[data-testid^="home-project-"]')).toHaveCount(0);
  });
});
