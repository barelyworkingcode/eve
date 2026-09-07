// Loopback is trusted, so the real /api/auth/status never shows the login
// screen in this harness (see app.spec.js). Route-mocked here instead of
// threading a real enrolment window through the fake relay — simpler, and
// the eve<->relay wire contract itself is covered by
// test/integration/eve-passkey-enrolment.test.js.
const { test, expect } = require('./fixtures');

test('the "Add this browser" button is hidden by default and appears once the status endpoint reports an open window', async ({ page }) => {
  await page.route('**/api/auth/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enrolled: true, authenticated: false, enrollmentOpen: false }),
  }));
  await page.reload();

  await expect(page.locator('#authScreen')).not.toHaveClass(/hidden/);
  await expect(page.locator('#authEnroll')).toHaveClass(/hidden/);
  await expect(page.locator('#authEnrollHint')).toHaveClass(/hidden/);

  await page.unroute('**/api/auth/status');
  await page.route('**/api/auth/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      enrolled: true, authenticated: false,
      enrollmentOpen: true, enrollmentExpires: '2026-09-07T10:15:00Z',
    }),
  }));

  // The login screen polls /api/auth/status every 3s (public/auth.js); wait
  // for that poll to observe the new route rather than reloading again.
  await expect(page.locator('#authEnroll')).not.toHaveClass(/hidden/, { timeout: 6000 });
  await expect(page.locator('#authEnrollHint')).not.toHaveClass(/hidden/);
});
