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

test('too many tries are refused @G16.1.r2', async ({ eve, page, passkey }) => {
  await passkey.enable();
  await passkey.setPresence(false);
  await eve.open('/', { preReady: 'the Sign-in screen shows before the app is ready' });
  await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeVisible();
  // Ten attempts are allowed in fifteen minutes. With no presence the ceremony
  // never ends, so each attempt starts from a fresh load of the Sign-in screen.
  for (let attempt = 0; attempt < 11; attempt += 1) {
    await page.getByRole('button', { name: 'Create Passkey' }).click();
    await expect(page.getByRole('button', { name: 'Create Passkey' })).toBeDisabled();
    await eve.reload({ preReady: 'the Sign-in screen shows before the app is ready' });
    await expect(page.getByRole('heading', { name: 'Set Up Passkey' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Create Passkey' }).click();
  await expect(page.getByText('Too many attempts. Try again later.')).toBeVisible();
});
