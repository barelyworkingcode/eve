const { test, expect } = require('./fixtures');

test('loads the workspace and renders the seeded project in the sidebar', async ({ page }) => {
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 20000 });
});

test('does not get stuck on the passkey/auth screen over loopback', async ({ page }) => {
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#authScreen')).toHaveClass(/hidden/);
});
