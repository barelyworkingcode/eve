const { test, expect } = require('./support/fixtures');

test.use({ network: 'untrusted' });

test('create the first passkey on a new eve @G16.1', async ({ eve, page, relay, passkey }) => {
  await passkey.enable();
  await eve.open('/', { preReady: 'the Sign-in screen shows before the app is ready' });
  await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Passkey' }).click();

  await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeHidden();
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Good morning|Good afternoon|Good evening|Working late)\.$/ }),
  ).toBeVisible();

  const report = await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' });
  expect(report.status).toBe('ok');

  const creds = await passkey.credentials();
  expect(creds).toHaveLength(1);
  const listed = await relay.cli('eve', 'list');
  expect(listed.code).toBe(0);
  // The CLI prints the id base64url-encoded and shortened.
  const id = creds[0].credentialId.replace(/\+/g, '-').replace(/\//g, '_');
  expect(listed.stdout).toContain(id.slice(0, 8));
});

test.describe('an address outside the trusted subnets', () => {
  // Loopback is outside 192.0.2.0/24, so eve sees this browser as an outside address.
  test.use({ network: 'trusted', trustedSubnets: '192.0.2.0/24' });

  test('an outside address gets plain Not found before any passkey exists @G16.1.r1', async ({ eve, page }) => {
    await eve.open('/', { preReady: 'eve answers the page with plain text, so the app never starts' });
    await expect(page.getByText('Not found', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Create Passkey' })).toBeHidden();
  });
});

test('too many tries are refused @G16.1.r2', async ({ eve, page, passkey }) => {
  await passkey.enable();
  await passkey.setPresence(false);
  await eve.open('/', { preReady: 'the Sign-in screen shows before the app is ready' });
  await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeVisible();
  // Ten requests are allowed in fifteen minutes. With no presence the ceremony
  // never ends, so each attempt starts from a fresh load of the Sign-in screen.
  // Each click waits for the server's answer: a refused start re-enables the
  // button at once, so the button state alone cannot tell an allowed attempt
  // from a refused one.
  const enrollStart = (status) => (r) => r.url().endsWith('/api/auth/enroll/start') && r.status() === status;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.all([
      page.waitForResponse(enrollStart(200)),
      page.getByRole('button', { name: 'Create Passkey' }).click(),
    ]);
    await expect(page.getByRole('button', { name: 'Create Passkey' })).toBeDisabled();
    await eve.reload({ preReady: 'the Sign-in screen shows before the app is ready' });
    await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeVisible();
  }
  await Promise.all([
    page.waitForResponse(enrollStart(429)),
    page.getByRole('button', { name: 'Create Passkey' }).click(),
  ]);
  await expect(page.getByText('Too many attempts. Try again later.')).toBeVisible();
});
