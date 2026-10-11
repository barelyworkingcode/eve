const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  return w;
}

const KEYS = ['Esc', 'Tab', '⇧Tab', 'Ctrl', '←', '↑', '↓', '→', 'More keys'];

// The terminal is an echo terminal: what the key bar sends comes back and xterm acts on it
// (a tab stop, a cursor move, a title), so the screen shows which key arrived.

// Opens the Shell terminal from its Today tile and focuses its input. A phone shows the
// terminal full screen, without a tab strip.
async function startShell(page) {
  await page.getByRole('button', { name: 'Shell', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  await expect(input).toBeAttached();
  await input.focus();
  return input;
}

const key = (page, name) => page.getByRole('button', { name, exact: true });
const text = (page, value) => page.getByText(value, { exact: true });

test.use({ world: shellWorld() });

test('a device with a mouse shows no key bar @G4.14.r1', async ({ eve, page }) => {
  await eve.open('/');
  await startShell(page);
  // The terminal is up and echoes; the bar is not there.
  await page.keyboard.type('ready');
  await expect(text(page, 'ready')).toBeVisible();
  for (const name of KEYS) await expect(key(page, name)).toHaveCount(0);
});

test.describe('a touch screen', () => {
  test.use(profiles.phone);

  test('show the key bar under a terminal on a touch device @G4.14', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    for (const name of KEYS) await expect(key(page, name)).toBeVisible();
  });

  test('send Esc from the key bar @G4.15', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('abc');
    await key(page, 'Esc').tap();
    // Escape then "[D" echo back as the sequence that moves the cursor one step left.
    await page.keyboard.type('[D');
    await page.keyboard.type('X');
    await expect(text(page, 'abX')).toBeVisible();
  });

  test('arm Ctrl for the next key from the key bar @G4.18', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('abc');
    // Ctrl and h is Backspace: the cursor steps left. The next key is a plain letter again,
    // so the arm cleared after one key.
    await expect(key(page, 'Ctrl')).toHaveAttribute('aria-pressed', 'false');
    await key(page, 'Ctrl').tap();
    await expect(key(page, 'Ctrl')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.type('h');
    await page.keyboard.type('X');
    await expect(text(page, 'abX')).toBeVisible();
    await expect(key(page, 'Ctrl')).toHaveAttribute('aria-pressed', 'false');
  });

  test('lock Ctrl on by double tapping it @G4.19', async ({ eve, page }) => {
    await page.clock.install();
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('abc');
    await key(page, 'Ctrl').tap();
    await key(page, 'Ctrl').tap();
    await expect(key(page, 'Ctrl')).toHaveAttribute('aria-pressed', 'true');
    // Two Backspace chords: the lock holds for more than one key.
    await page.keyboard.type('hh');
    await expect(key(page, 'Ctrl')).toHaveAttribute('aria-pressed', 'true');
    // Time moves on, so the next tap is a new single tap, which lets go of the lock.
    await page.clock.fastForward('00:10');
    await key(page, 'Ctrl').tap();
    await expect(key(page, 'Ctrl')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('XY');
    await expect(text(page, 'aXY')).toBeVisible();
  });

  test('show more keys on the key bar @G4.21', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await expect(key(page, '^C')).toHaveCount(0);
    await key(page, 'More keys').tap();
    await expect(page.getByRole('button', { name: /^(Option|Alt)$/ })).toBeVisible();
    for (const name of ['^C', '^D', 'Home', 'End', 'PgUp', 'PgDn', '|', '/', '-', '~']) {
      await expect(key(page, name)).toBeVisible();
    }
  });

  test('end input with ^D from the key bar @G4.23', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startShell(page);
    await key(page, 'More keys').tap();
    await key(page, '^D').tap();
    await relay.waitForEvent('session.exited');
    const list = (await relay.json('ctl', 'state', '--json')).terminals;
    expect(list).toHaveLength(1);
    expect(list[0].state).toBe('stopped');
  });

  test('jump with Home from the key bar @G4.24', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('abc');
    await key(page, 'More keys').tap();
    await key(page, 'Home').tap();
    await page.keyboard.type('X');
    await expect(text(page, 'Xbc')).toBeVisible();
  });

  test('send Tab from the key bar @G4.16', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('ab');
    await key(page, 'Tab').tap();
    await page.keyboard.type('c');
    // The echo has no shell to complete a word: Tab arrives as a move to the next tab stop.
    await expect(text(page, 'ab c')).toBeVisible();
  });

  test('send Shift+Tab from the key bar @G4.17', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('abcdefghijkl');
    await key(page, '⇧Tab').tap();
    await page.keyboard.type('X');
    await expect(text(page, 'abcdefghXjkl')).toBeVisible();
  });

  test('move the cursor with the arrow keys on the key bar @G4.20', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    await page.keyboard.type('abcd');
    await page.keyboard.press('Enter');
    await page.keyboard.type('efgh');
    await key(page, '↑').tap();
    await key(page, '←').tap();
    await page.keyboard.type('X');
    await expect(text(page, 'abcX')).toBeVisible();
    await key(page, '↓').tap();
    await key(page, '←').tap();
    await key(page, '←').tap();
    await key(page, '→').tap();
    await page.keyboard.type('Y');
    await expect(text(page, 'efgY')).toBeVisible();
  });
});
