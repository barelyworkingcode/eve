// G10 · Find something in my project. Search returns matches and opens them;
// ⌘K finds sessions, projects and actions.
const { test, expect } = require('./fixture');

test.use({
  world: {
    seed: ({ relay, folders }) => {
      relay.seedSession({
        sessionId: 's-find', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Quarterly planning',
        live: false, createdAt: new Date(Date.now() - 86400000).toISOString(), lastMessageAt: new Date(Date.now() - 80000000).toISOString(),
      });
    },
  },
});

test.describe('G10 find', () => {
  test('⌘K with nothing typed offers actions, sessions and projects', async ({ page }) => {
    // The palette lists what is loaded when it opens.
    await page.waitForFunction(() => window.client.state.sessions.size > 0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette-input')).toBeFocused();
    const items = page.getByTestId('palette-item');
    await expect(items.filter({ hasText: 'Quarterly planning' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'Alpha Project' }).filter({ hasText: '1 session' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'Beta Project' }).filter({ hasText: '0 sessions' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'New project' })).toHaveCount(1);
  });

  test('⌘K narrows as you type, Enter opens the match, Escape closes', async ({ page }) => {
    await page.waitForFunction(() => window.client.state.sessions.size > 0 && window.client.projects.size > 1);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('beta');
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Quarterly planning' })).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('#panelTitle')).toHaveText('Beta Project');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette-input')).toBeHidden();
  });

  test('project search lists matches by file and line, and a match opens the file', async ({ page }) => {
    await page.evaluate(() => window.client.bus.emit('dialog:search', { projectId: 'alpha' }));
    await expect(page.getByTestId('search-dialog-query')).toBeFocused();
    await page.keyboard.type('hello from alpha');
    await page.keyboard.press('Enter');
    const results = page.getByTestId('search-dialog-results');
    const hit = results.getByTestId(/search-dialog-result-.*README\.md-3/);
    await expect(hit).toBeVisible({ timeout: 15000 });
    await hit.click();
    await expect(page.locator('#monacoEditor .view-lines')).toContainText('hello from alpha', { timeout: 15000 });
    await expect(page.getByTestId('tab-alpha:/README.md')).toBeVisible();
  });

  test('a search with no matches says so', async ({ page }) => {
    await page.evaluate(() => window.client.bus.emit('dialog:search', { projectId: 'alpha' }));
    // The dialog focuses its input a frame after it opens; typing earlier is lost.
    const query = page.getByTestId('search-dialog-query');
    await expect(query).toBeFocused();
    await page.keyboard.type('zzz-not-anywhere');
    await expect(query).toHaveValue('zzz-not-anywhere');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dialog-search-dialog').getByText('No matches.')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('G10 ⌘K ranking and task runs', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
        // "plan" is a prefix of one name and only inside the other; the prefix match ranks first.
        relay.seedSession({ sessionId: 's-inner', projectId: 'alpha', directory: folders.alpha, model: 'm', name: 'Quarterly planning', live: false, createdAt: at(3), lastMessageAt: at(2) });
        relay.seedSession({ sessionId: 's-prefix', projectId: 'alpha', directory: folders.alpha, model: 'm', name: 'Plan the launch', live: false, createdAt: at(30), lastMessageAt: at(29) });
        // A task run is a headless session, never a thread.
        relay.seedSession({ sessionId: 'run1', projectId: 'alpha', directory: folders.alpha, model: 'm', name: 'Nightly run', live: false, createdAt: at(1), lastMessageAt: at(0.5), headless: true });
        relay.seedTask({ id: 'tn', name: 'Nightly', projectId: 'alpha', prompt: 'p', model: 'm', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless', lastSessionId: 'run1', lastStatus: 'success' });
      },
    },
  });

  test('typing ranks the best match first', async ({ page }) => {
    await page.waitForFunction(() => window.client.state.sessions.size > 0 && window.client.state.tasks.size > 0);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('plan');
    const texts = await page.getByTestId('palette-item').allInnerTexts();
    const at = (name) => texts.findIndex((t) => t.includes(name));
    expect(at('Plan the launch')).toBeGreaterThanOrEqual(0);
    expect(at('Quarterly planning')).toBeGreaterThanOrEqual(0);
    expect(at('Plan the launch')).toBeLessThan(at('Quarterly planning'));
  });

  test('with nothing typed, the run behind a task is not offered as a session', async ({ page }) => {
    await page.waitForFunction(() => window.client.state.sessions.size > 0 && window.client.state.tasks.size > 0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Quarterly planning' })).toHaveCount(1);
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Nightly run' })).toHaveCount(0);
  });

  test('typing the run\'s name does not offer it as a session either', async ({ page }) => {
    await page.waitForFunction(() => window.client.state.sessions.size > 0 && window.client.state.tasks.size > 0);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('nightly run');
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Nightly run' })).toHaveCount(0);
  });
});
