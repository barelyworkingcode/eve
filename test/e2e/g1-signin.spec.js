const { test, expect } = require('./support/fixtures');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

test('trusted address lands on Today without a prompt @G1.1', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeHidden();
});
