const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  return w;
}

const SIGN_IN = { preReady: 'the Sign-in screen shows before the app is ready' };
const SAFARI_PAGE = { preReady: 'the Safari sign-in page never makes the app ready' };

test.describe('the Safari sign-in sheet', () => {
  test.use({ network: 'untrusted' });

  // Waits: eve.ready() after enrolment, the report event, then the sheet's success text.
  test('the Safari page signs in with the passkey and says it is returning @G15.1', async ({ eve, page, relay, passkey }) => {
    await passkey.enable();
    await eve.open('/', SIGN_IN);
    await page.getByRole('button', { name: 'Create Passkey' }).click();
    await eve.ready();
    await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });

    const since = await relay.mark();
    await eve.open('/api/auth/safari-login', SAFARI_PAGE);
    await expect(page.getByRole('heading', { name: 'Home|Work' })).toBeVisible();
    await expect(page.getByText('Success! Returning to app…')).toBeVisible();
    const report = await relay.waitForEvent('eve.passkey.report', { since, match: (l) => l.status === 'ok' });
    expect(report.status).toBe('ok');
  });
});

test.describe('the Safari sign-in sheet, refused', () => {
  test.use({ network: 'untrusted' });

  // Ten requests are allowed in fifteen minutes and enrolling spent two. With no presence the
  // ceremony never ends, so each load of the sheet spends one more; the next one is refused.
  test('too many tries on the Safari page say Server error @G15.1.r1', async ({ eve, page, relay, passkey }) => {
    await passkey.enable();
    await eve.open('/', SIGN_IN);
    await page.getByRole('button', { name: 'Create Passkey' }).click();
    await eve.ready();
    await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });

    await passkey.setPresence(false);
    const loginStart = (status) => (r) => r.url().endsWith('/api/auth/login/start') && r.status() === status;
    const allowedLogins = 10 - 2;
    for (let attempt = 0; attempt < allowedLogins; attempt += 1) {
      await Promise.all([
        page.waitForResponse(loginStart(200)),
        eve.open('/api/auth/safari-login', SAFARI_PAGE),
      ]);
    }
    await Promise.all([
      page.waitForResponse(loginStart(429)),
      eve.open('/api/auth/safari-login', SAFARI_PAGE),
    ]);
    await expect(page.getByText('Server error')).toBeVisible();
  });
});

test.describe('a terminal on a phone', () => {
  test.use({ world: shellWorld(), ...profiles.phone });

  // Waits: the last echoed line visible, the swipe resolves, then the marker line visible.
  test('a finger drag scrolls the terminal history both ways @G15.3', async ({ eve, page, touch }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Shell', exact: true }).click();
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    const lines = Array.from({ length: 80 }, (_, i) => `scroll line ${String(i + 1).padStart(3, '0')}`);
    await page.keyboard.type(lines.join('\n'));
    const last = page.getByText(lines[79], { exact: true });
    await expect(last).toBeVisible();
    const first = page.getByText(lines[0], { exact: true });
    await expect(first).toBeHidden();

    // Dragging down shows older lines.
    await touch.swipe(last, { dx: 0, dy: 1500 });
    await expect(first).toBeVisible();
    await expect(last).toBeHidden();

    // Dragging up brings the newer lines back.
    await touch.swipe(first, { dx: 0, dy: -1500 });
    await expect(last).toBeVisible();
    await expect(first).toBeHidden();
  });
});
