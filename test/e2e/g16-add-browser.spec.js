const { test, expect } = require('./support/fixtures');

test.use({ network: 'untrusted' });

async function claimEve(eve, page, relay, passkey) {
  await passkey.enable();
  await eve.open('/', { preReady: 'the Sign-in screen shows before the app is ready' });
  await page.getByRole('button', { name: 'Create Passkey' }).click();
  await eve.ready();
  await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });
}

test('open the enrolment window from the CLI @G16.2', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  await relay.ctl('presence', 'eve.enrolment.open=approve');
  const opened = await relay.cli('eve', 'enrol');
  expect(opened.code).toBe(0);
  expect(opened.stdout).toContain('eve passkey enrolment open until');
  expect(opened.stdout).toContain('5m0s, single use');
});

test('no presence answer leaves the window closed @G16.2.r1', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  await relay.ctl('presence', 'eve.enrolment.open=deny');
  const refused = await relay.cli('eve', 'enrol');
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('presence was refused');
  expect(refused.stdout).not.toContain('enrolment open');
});

test('list the passkeys eve reported @G16.5', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  const listed = await relay.cli('eve', 'list');
  expect(listed.code).toBe(0);
  const [header, ...rows] = listed.stdout.trim().split('\n');
  for (const column of ['LABEL', 'CREDENTIAL ID', 'CREATED', 'LAST USED', 'STATUS']) {
    expect(header).toContain(column);
  }
  expect(rows).toHaveLength(1);
});

test('nothing listed before eve has reported @G16.5.r1', async ({ relay }) => {
  const listed = await relay.cli('eve', 'list');
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain('no eve passkeys reported');
});

test('the last passkey cannot be revoked @G16.6.r1', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  await relay.ctl('presence', 'eve.passkey.revoke=approve');
  const creds = await passkey.credentials();
  const id = creds[0].credentialId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const refused = await relay.cli('eve', 'revoke', '--id', id);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('the last Eve passkey cannot be revoked');

  const listed = await relay.cli('eve', 'list');
  expect(listed.stdout.trim().split('\n')).toHaveLength(2);
  expect(listed.stdout).not.toContain('revocation pending');
});

const SIGN_IN = { preReady: 'the Sign-in screen shows before the app is ready' };

function b64url(id) {
  return id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Claim eve, leave as a signed-out browser, and swap to a fresh authenticator,
// so the page is a new browser. Returns the first browser's credentials.
async function becomeNewBrowser(eve, passkey) {
  await eve.signOut();
  return passkey.replace();
}

async function openWindow(relay) {
  await relay.ctl('presence', 'eve.enrolment.open=approve');
  const opened = await relay.cli('eve', 'enrol');
  expect(opened.code).toBe(0);
}

// The page ends signed in with its own, second passkey.
async function addThisBrowser(eve, page, relay, passkey) {
  await claimEve(eve, page, relay, passkey);
  const first = await becomeNewBrowser(eve, passkey);
  await openWindow(relay);
  await eve.reload(SIGN_IN);
  await page.getByRole('button', { name: 'Add this browser' }).click();
  await eve.ready();
  return first;
}

test('the Add this browser button shows once the window is open @G16.3', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  await becomeNewBrowser(eve, passkey);
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  await openWindow(relay);
  await eve.reload(SIGN_IN);
  await expect(page.getByRole('button', { name: 'Add this browser' })).toBeVisible();
  await expect(page.getByText('Enrolment is open for a few minutes.')).toBeVisible();
});

test('no button while the window is closed @G16.3.r1', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  await becomeNewBrowser(eve, passkey);
  await eve.reload(SIGN_IN);
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add this browser' })).toBeHidden();
  await expect(page.getByText('Enrolment is open for a few minutes.')).toBeHidden();
});

test('add this browser as another passkey @G16.4', async ({ eve, page, relay, passkey }) => {
  await addThisBrowser(eve, page, relay, passkey);
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeHidden();
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Good morning|Good afternoon|Good evening|Working late)\.$/ }),
  ).toBeVisible();
  const consumed = await relay.waitForEvent('eve.enrolment.consume', { match: (l) => l.status === 'ok' });
  expect(consumed.status).toBe('ok');
  const listed = await relay.cli('eve', 'list');
  expect(listed.code).toBe(0);
  expect(listed.stdout.trim().split('\n')).toHaveLength(3);
});

test('too many tries to add this browser are refused @G16.4.r2', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  await becomeNewBrowser(eve, passkey);
  await openWindow(relay);
  await passkey.setPresence(false);
  await eve.reload(SIGN_IN);
  await expect(page.getByRole('button', { name: 'Add this browser' })).toBeVisible();
  // Ten requests are allowed in fifteen minutes, and claiming eve spent two
  // (enroll start and finish). With no presence the ceremony never ends, so
  // each attempt starts from a fresh load of the Sign-in screen. Each click
  // waits for the server's answer: a refused start re-enables the button at
  // once, so the button state alone cannot tell an allowed attempt from a
  // refused one.
  const enrollStart = (status) => (r) => r.url().endsWith('/api/auth/enroll/start') && r.status() === status;
  const allowedStarts = 10 - 2;
  for (let attempt = 0; attempt < allowedStarts; attempt += 1) {
    await Promise.all([
      page.waitForResponse(enrollStart(200)),
      page.getByRole('button', { name: 'Add this browser' }).click(),
    ]);
    await expect(page.getByRole('button', { name: 'Add this browser' })).toBeDisabled();
    await eve.reload(SIGN_IN);
    await expect(page.getByRole('button', { name: 'Add this browser' })).toBeVisible();
  }
  await Promise.all([
    page.waitForResponse(enrollStart(429)),
    page.getByRole('button', { name: 'Add this browser' }).click(),
  ]);
  await expect(page.getByText('Too many attempts. Try again later.')).toBeVisible();
});

test('revoke a lost browser and eve drops it @G16.6', async ({ eve, page, relay, passkey }) => {
  // eve reports its passkeys every 30 s; this test waits for one report.
  test.slow();
  const first = await addThisBrowser(eve, page, relay, passkey);
  await relay.ctl('presence', 'eve.passkey.revoke=approve');
  const since = relay.mark();
  const revoked = await relay.cli('eve', 'revoke', '--id', b64url(first[0].credentialId));
  expect(revoked.code).toBe(0);
  expect(revoked.stdout).toContain('revocation pending');
  const pending = await relay.cli('eve', 'list');
  expect(pending.stdout).toContain('revocation pending');

  // The page stays signed in with its own passkey until eve reports again.
  await relay.waitForEvent('eve.passkey.report', {
    since,
    match: (l) => l.status === 'ok' && l.count === 1,
  });
  const after = await relay.cli('eve', 'list');
  expect(after.stdout).not.toContain('revocation pending');
  expect(after.stdout.trim().split('\n')).toHaveLength(2);
});

test('@G16.8 @G1.41 an open page signs out after its passkey is revoked', async ({ eve, page, relay, passkey }) => {
  // eve reports its passkeys every 30 s; this test waits for one report.
  test.slow();
  await addThisBrowser(eve, page, relay, passkey);
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeHidden();
  const own = await passkey.credentials();
  await relay.ctl('presence', 'eve.passkey.revoke=approve');
  const since = relay.mark();
  const revoked = await relay.cli('eve', 'revoke', '--id', b64url(own[0].credentialId));
  expect(revoked.code).toBe(0);
  expect(revoked.stdout).toContain('revocation pending');

  await relay.waitForEvent('eve.passkey.report', {
    since,
    match: (l) => l.status === 'ok' && l.count === 1,
  });
  // No reload or other action: the open page must fall back to Sign In.
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
});

test('a revoked passkey is refused at sign-in @G16.7', async ({ eve, page, relay, passkey }) => {
  await addThisBrowser(eve, page, relay, passkey);
  const own = await passkey.credentials();
  await relay.ctl('presence', 'eve.passkey.revoke=approve');
  const revoked = await relay.cli('eve', 'revoke', '--id', b64url(own[0].credentialId));
  expect(revoked.code).toBe(0);
  await eve.signOut();
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText('This passkey has been revoked.')).toBeVisible();
});

test('report the passkey list to relay after enrolment @G16.9',async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  const report = await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });
  expect(report.status).toBe('ok');
});
