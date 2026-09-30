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
    await page.keyboard.type('zzz-not-anywhere');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dialog-search-dialog').getByText('No matches.')).toBeVisible({ timeout: 15000 });
  });
});
