const { test, expect, profiles } = require('./support/fixtures');

test.use(profiles.phone);

test('open the Project page from the bottom bar @G3.1', async ({ eve, page }) => {
  await eve.open('/');
  const bar = page.getByRole('navigation', { name: 'Navigation' });
  await bar.getByRole('button', { name: 'Threads' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Routines' })).toBeVisible();
});
