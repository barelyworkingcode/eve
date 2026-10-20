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
    await relay.waitForEvent('eve.passkey.report', { since, match: (l) => l.status === 'ok' });
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

test.describe('the Safari sign-in sheet, not accepted', () => {
  test.use({ network: 'untrusted' });

  // Waits: the report event after enrolment, then the sheet starts its own ceremony and shows the text.
  test('a passkey eve does not accept says Verification failed @G15.1.r2', async ({ eve, page, relay, passkey }) => {
    await passkey.enable();
    await eve.open('/', SIGN_IN);
    await page.getByRole('button', { name: 'Create Passkey' }).click();
    await eve.ready();
    await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });

    await passkey.forgeKey();
    await eve.open('/api/auth/safari-login', SAFARI_PAGE);
    await expect(page.getByRole('heading', { name: 'Home|Work' })).toBeVisible();
    await expect(page.getByText('Verification failed')).toBeVisible();
    await expect(page.getByText('Success! Returning to app…')).toBeHidden();
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

test.describe('a terminal on a tablet', () => {
  test.use({ world: shellWorld(), ...profiles.tablet });

  // Waits: the input attached, line 080 visible, then after the keyboard opens line 040 hidden
  // (the terminal has refit), then the typed line visible; after it closes, line 040 visible.
  // Boxes are measured only after those signals.
  test('the line I type stays above the key bar while the keyboard is open @G15.4', async ({ eve, page, softKeyboard }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Shell', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await expect(input).toBeAttached();
    await input.focus();
    const lines = Array.from({ length: 80 }, (_, i) => `kb line ${String(i + 1).padStart(3, '0')}`);
    await page.keyboard.type(lines.join('\n'));
    const last = page.getByText('kb line 080', { exact: true });
    const middle = page.getByText('kb line 040', { exact: true });
    const esc = page.getByRole('button', { name: 'Esc', exact: true });
    await expect(last).toBeVisible();
    await expect(middle).toBeVisible();
    const innerHeight = page.viewportSize().height;
    const escBefore = await esc.boundingBox();

    // Open: the terminal shrinks to the space above the keyboard, so line 040 scrolls out of view.
    const keyboardTop = Math.round(innerHeight / 2);
    await softKeyboard.open(innerHeight - keyboardTop);
    await expect(middle).toBeHidden();
    await page.keyboard.type(' typed');
    const typed = page.getByText('kb line 080 typed', { exact: true });
    await expect(typed).toBeVisible();
    const typedBox = await typed.boundingBox();
    const escOpen = await esc.boundingBox();
    const typedBottom = typedBox.y + typedBox.height;
    expect(typedBottom).toBeLessThanOrEqual(keyboardTop);
    expect(typedBottom).toBeLessThanOrEqual(escOpen.y);
    expect(escOpen.y - typedBottom).toBeLessThan(3 * typedBox.height);
    const gapOpen = keyboardTop - (escOpen.y + escOpen.height);
    const gapBefore = innerHeight - (escBefore.y + escBefore.height);
    expect(Math.abs(gapOpen - gapBefore)).toBeLessThanOrEqual(1);

    // Close: the terminal and the key bar return to where they were.
    await softKeyboard.close();
    await expect(middle).toBeVisible();
    const escAfter = await esc.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) {
      expect(Math.abs(escAfter[key] - escBefore[key])).toBeLessThanOrEqual(1);
    }
  });
});
