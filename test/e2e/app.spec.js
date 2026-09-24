const { test, expect } = require('./fixtures');

test('loads the workspace and renders the seeded project in the sidebar', async ({ page }) => {
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 20000 });
});

test('does not get stuck on the passkey/auth screen over loopback', async ({ page }) => {
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#authScreen')).toHaveClass(/hidden/);
});

test('project panel has no Modules surface', async ({ page }) => {
  // The fixture has already navigated; reload with the listener attached so a
  // script that still names a removed module class surfaces as a page error.
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.reload();

  await page.getByTestId('sidebar-project-p1').click();
  await expect(page.getByTestId('panel-tab-changes')).toBeVisible({ timeout: 20000 });

  const tabIds = await page.$$eval('#panelTabs > *', (els) => els.map((e) => e.dataset.testid));
  expect(tabIds).toEqual(['panel-tab-files', 'panel-tab-sessions', 'panel-tab-tasks', 'panel-tab-changes']);

  await expect(page.locator('#moduleContent')).toHaveCount(0);
  await expect(page.locator('[data-testid="module-activity-orb"]')).toHaveCount(0);
  await expect(page.locator('script[src*="modules/"]')).toHaveCount(0);
  await expect(page.locator('script[src*="module-pane"]')).toHaveCount(0);
  await expect(page.locator('link[href*="modules-orb"]')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
