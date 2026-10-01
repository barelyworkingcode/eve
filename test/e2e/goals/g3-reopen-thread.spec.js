// G3 · Pick up where I left off. A thread from yesterday opens from the
// project's Sessions list, from Home's Continue, or from ⌘K, with its history,
// and no new session is made.
const { test, expect } = require('./fixture');

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test.use({
  world: {
    seed: ({ relay, folders }) => {
      relay.setModels({ models: [{ value: 'fake-model', label: 'Fake Model' }], providerSettings: {} });
      const history = [
        { timestamp: iso(30 * HOUR), role: 'user', content: 'Plan the launch checklist' },
        { timestamp: iso(30 * HOUR), role: 'assistant', content: [{ type: 'text', text: 'Start with the release notes.' }] },
      ];
      relay.seedSession({
        sessionId: 's-launch', projectId: 'alpha', directory: folders.alpha, model: 'fake-model',
        name: 'Plan the launch', history, live: false, createdAt: iso(30 * HOUR), lastMessageAt: iso(29 * HOUR), messageCount: 2,
      });
      relay.seedSession({
        sessionId: 's-beta', projectId: 'beta', directory: folders.beta, model: 'fake-model',
        name: 'Beta thread', history: [], live: false, createdAt: iso(5 * HOUR), lastMessageAt: iso(4 * HOUR), messageCount: 0,
      });
    },
  },
});

async function expectReopened(page, eve) {
  await expect(page.getByTestId('messages-container')).toContainText('Plan the launch checklist');
  await expect(page.getByTestId('messages-container')).toContainText('Start with the release notes.');
  await expect(page).toHaveURL(/#session\/s-launch/);
  await expect(page.getByTestId('tab-s-launch')).toBeVisible();
  const joins = eve.relay.inbound.filter((m) => m.type === 'join_session' && m.sessionId === 's-launch');
  expect(joins.length).toBeGreaterThan(0);
  expect(eve.relay.sessionCreates).toHaveLength(0);
}

test.describe('G3 reopen a thread', () => {
  test('from the project panel\'s session list', async ({ page, eve }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-tab-sessions').click();
    await expect(page.getByTestId('panel-tab-sessions')).toContainText('1'); // this project's threads only
    await expect(page.getByTestId('sidebar-session-s-launch')).toBeVisible();
    await expect(page.getByTestId('sidebar-session-s-beta')).toHaveCount(0); // another project's thread
    await page.getByTestId('sidebar-session-s-launch').click();
    await expectReopened(page, eve);
  });

  test('from Home\'s Continue row, newest first, with its project and model', async ({ page, eve }) => {
    const rows = page.locator('[data-testid^="home-session-"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute('data-testid', 'home-session-s-beta'); // newer server activity
    await expect(page.getByTestId('home-session-s-launch')).toContainText('Plan the launch');
    await expect(page.getByTestId('home-session-s-launch')).toContainText('Alpha Project');
    await page.getByTestId('home-session-s-launch').click();
    await expectReopened(page, eve);
  });

  test('from ⌘K by typing part of its name', async ({ page, eve }) => {
    // The palette lists what is loaded when it opens.
    await page.waitForFunction(() => window.client.state.sessions.size > 0);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('launch');
    const item = page.getByTestId('palette-item').filter({ hasText: 'Plan the launch' });
    await expect(item).toBeVisible();
    await item.click();
    await expectReopened(page, eve);
  });

  test('Home says nothing is running while every session is dormant', async ({ page }) => {
    await expect(page.locator('.home__subtitle')).toContainText('Nothing running');
    await expect(page.locator('.home__live')).toHaveCount(0);
  });
});

// CHANGED by S1-A3 (docs/design-today-s1.md): this block used to assert that a
// live provider process is "running" (a dot, a count, a lit project chip). Live
// means the process is alive, not that a turn is in progress. A running turn is
// asserted in goals/today-truth.
test.describe('G3 a live session that is idle is not shown as running', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        relay.seedSession({
          sessionId: 's-live', projectId: 'alpha', directory: folders.alpha, model: 'fake-model',
          name: 'Live one', live: true, createdAt: iso(HOUR), lastMessageAt: iso(HOUR / 2), messageCount: 1,
        });
      },
    },
  });

  test('Home keeps its row but counts nothing and marks neither the row nor the project chip', async ({ page }) => {
    await expect(page.getByTestId('home-session-s-live')).toBeVisible();
    await expect(page.locator('.home__subtitle')).toContainText('Nothing running');
    await expect(page.getByTestId('home-session-s-live').locator('.home__live')).toHaveCount(0);
    await expect(page.getByTestId('home-project-alpha').locator('.home__live')).toHaveCount(0);
  });
});
