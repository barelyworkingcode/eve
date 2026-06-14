/**
 * E2E increment 1 — the app boots in a real browser, the WS connects + auth
 * passes (loopback trusted), and the seeded project renders in the sidebar.
 * This is the first coverage of the vanilla-JS client (public/) at all.
 */
const { test, expect } = require('./fixtures');

test('loads the workspace and renders the seeded project in the sidebar', async ({ page }) => {
  // The project button appears once the client has connected, fetched
  // /api/projects (proxied to the fake relay), and rendered the rail.
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 20000 });
});

test('does not get stuck on the passkey/auth screen over loopback', async ({ page }) => {
  // #authScreen carries the .hidden class unless enrollment/login is required;
  // on a trusted loopback client it must stay hidden.
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#authScreen')).toHaveClass(/hidden/);
});
