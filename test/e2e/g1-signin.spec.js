const { test, expect } = require('./support/fixtures');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;
const SIGN_IN = { preReady: 'the Sign-in screen shows before the app is ready' };

function b64url(id) {
  return id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Claim an unowned eve with the first passkey, as a person does on the
// Set Up Passkey screen. The page ends signed in.
async function claimEve(eve, page, relay, passkey) {
  await passkey.enable();
  await eve.open('/', SIGN_IN);
  await page.getByRole('button', { name: 'Create Passkey' }).click();
  await eve.ready();
  await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });
}

test('trusted address lands on Today without a prompt @G1.1', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeHidden();
});

test.describe('off the trusted network', () => {
  test.use({ network: 'untrusted' });

  test('an address outside the trusted subnets gets the Sign-in screen @G1.1.r1', async ({ eve, page, relay, passkey }) => {
    await claimEve(eve, page, relay, passkey);
    await eve.signOut();
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeHidden();
  });

  test('sign in with a passkey @G1.2', async ({ eve, page, relay, passkey }) => {
    await claimEve(eve, page, relay, passkey);
    await eve.signOut();
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    const since = relay.mark();
    await page.getByRole('button', { name: 'Sign In' }).click();
    await eve.ready();
    // The sign-in markup stays in the page, hidden.
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeHidden();
    await expect(page.getByText('Use your passkey to continue.')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    const report = await relay.waitForEvent('eve.passkey.report', { since, match: (l) => l.status === 'ok' });
    expect(report.status).toBe('ok');
  });

  test('a revoked passkey is refused at sign-in @G1.2.r1', async ({ eve, page, relay, passkey }) => {
    // Browser one claims eve; this page becomes browser two through the window.
    await claimEve(eve, page, relay, passkey);
    await eve.signOut();
    await passkey.replace();
    await relay.ctl('presence', 'eve.enrolment.open=approve');
    const opened = await relay.cli('eve', 'enrol');
    expect(opened.code).toBe(0);
    await eve.reload(SIGN_IN);
    await page.getByRole('button', { name: 'Add this browser' }).click();
    await eve.ready();

    const own = await passkey.credentials();
    await relay.ctl('presence', 'eve.passkey.revoke=approve');
    const revoked = await relay.cli('eve', 'revoke', '--id', b64url(own[0].credentialId));
    expect(revoked.code).toBe(0);
    await eve.signOut();
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByText('This passkey has been revoked.')).toBeVisible();
  });

  test('too many sign-in tries are refused @G1.2.r2', async ({ eve, page, relay, passkey }) => {
    await claimEve(eve, page, relay, passkey);
    await eve.signOut();
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await passkey.setPresence(false);
    // Ten requests are allowed in fifteen minutes, and claiming eve spent two
    // (enroll start and finish). With no presence the ceremony never ends, so
    // each attempt starts from a fresh load. Each click waits for the server's
    // answer: a refused start re-enables the button at once, so the button
    // state alone cannot tell an allowed attempt from a refused one.
    const loginStart = (status) => (r) => r.url().endsWith('/api/auth/login/start') && r.status() === status;
    const allowedLogins = 10 - 2;
    for (let attempt = 0; attempt < allowedLogins; attempt += 1) {
      await Promise.all([
        page.waitForResponse(loginStart(200)),
        page.getByRole('button', { name: 'Sign In' }).click(),
      ]);
      await expect(page.getByRole('button', { name: 'Sign In' })).toBeDisabled();
      await eve.reload(SIGN_IN);
      await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    }
    await Promise.all([
      page.waitForResponse(loginStart(429)),
      page.getByRole('button', { name: 'Sign In' }).click(),
    ]);
    await expect(page.getByText('Too many attempts. Try again later.')).toBeVisible();
  });
});

test('a lost link shows the Reconnecting banner until it returns @G1.39', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeHidden();
  await eve.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
  await eve.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeHidden();
});

test('reload from the weak-connection banner @G1.40', async ({ eve, page }) => {
  await eve.open('/', { weakConnection: true });
  await expect(
    page.getByRole('alert').filter({ hasText: 'Some files didn’t load (weak connection?). Reload when you have signal.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await eve.ready();
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
});

test('offline Return keeps the text and says why @G1.4.r1', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await eve.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('hello from testbox');
  await ask.press('Enter');
  await expect(
    page.getByText('Not connected to eve. Your text is kept; try again once it reconnects.'),
  ).toBeVisible();
  await expect(ask).toHaveValue('hello from testbox');
});
