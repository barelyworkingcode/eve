const { test, expect } = require('./support/fixtures');

const ORIGIN = 'https://eve.acme.test';

test.use({ publicOrigin: ORIGIN });

test('a bare IP address is sent to the hostname @G1.43', async ({ eve, page }) => {
  await eve.openByIp('/');
  await expect(page).toHaveTitle('Use the hostname');
  await expect(page.getByRole('heading', { name: 'Open Eve by name, not by IP' })).toBeVisible();
  await expect(page.getByRole('link', { name: ORIGIN })).toHaveAttribute('href', new RegExp(`^${ORIGIN}/?$`));
});
