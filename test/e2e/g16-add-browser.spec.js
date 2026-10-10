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

test('report the passkey list to relay after enrolment @G16.9', async ({ eve, page, relay, passkey }) => {
  await claimEve(eve, page, relay, passkey);
  const report = await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });
  expect(report.status).toBe('ok');
});
