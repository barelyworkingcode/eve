const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

const TEMPLATES = [
  { id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' },
  { id: 'logs', name: 'Logs', command: '/bin/sh', description: 'Follow the logs' },
];

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = TEMPLATES.map((t) => ({ ...t }));
  return w;
}

async function openLauncher(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
  await expect(launcher).toBeVisible();
  return launcher;
}

async function terminals(relay) {
  return (await relay.json('ctl', 'state', '--json')).terminals;
}

const launchedTerminal = (l) => l.status === 'ok' && l.kind === 'terminal';
const FAULT_ROUTE = 'POST /api/terminals';
const NO_ROOM = ['--mode', 'error', '--status', '500', '--body', '{"error":"no room"}'];

test.describe('terminal templates', () => {
  test.use({ world: shellWorld() });

  test('start a terminal from a card in the Launcher @G4.1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await launcher.getByRole('button', { name: 'Shell' }).click();
    await expect(launcher).toBeHidden();
    const tab = page.getByRole('tab', { name: 'Acme - Shell' });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.type('hello');
    await expect(page.getByText('hello')).toBeVisible();
    await relay.waitForEvent('session.launch', { match: launchedTerminal });
    const list = await terminals(relay);
    expect(list).toHaveLength(1);
    expect(list[0].templateId).toBe('shell');
  });

  test('start a terminal from a tile on Today @G4.2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Shell', exact: true }).click();
    const tab = page.getByRole('tab', { name: 'Acme - Shell' });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('dialog', { name: 'Shell Launcher' })).toBeHidden();
    await relay.waitForEvent('session.launch', { match: launchedTerminal });
    expect(await terminals(relay)).toHaveLength(1);
  });

  test('type a command and read its output @G4.4', async ({ eve, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await launcher.getByRole('button', { name: 'Shell' }).click();
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.type('list the notes');
    await page.keyboard.press('Enter');
    await expect(page.getByText('list the notes')).toBeVisible();
  });

  // The "takes no more typing" half is unproven hermetically (gap R15): fakerelay drops bytes after exit whatever eve sends.
  test('a program that has ended shows as exited with its code @G4.4.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await launcher.getByRole('button', { name: 'Shell' }).click();
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.type('exit 3');
    await page.keyboard.press('Enter');
    await relay.waitForEvent('session.exited');
    // A second page's board (the Agents section of the Project page) shows the ended terminal with its code.
    const board = await eve.openAnother('/#project/p_acme');
    await expect(board.getByRole('button').filter({ hasText: 'exited 3' })).toBeVisible();
  });

  test('relay refuses: the Launcher card shows a toast @G4.1.r3', async ({ eve, page, relay }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    expect((await relay.ctl('fault', 'add', '--route', FAULT_ROUTE, ...NO_ROOM)).code).toBe(0);
    await launcher.getByRole('button', { name: 'Shell' }).click();
    // The same text is also written into the (hidden) chat; the toast is the one in a status region.
    await expect(page.getByRole('status').filter({ hasText: 'terminal create failed: no room' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toBeHidden();
  });

  test('relay refuses: the Today tile shows a toast @G4.2.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    expect((await relay.ctl('fault', 'add', '--route', FAULT_ROUTE, ...NO_ROOM)).code).toBe(0);
    await page.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'terminal create failed: no room' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toBeHidden();
  });

  test('see every template while the project lists none @G4.3', async ({ eve, page, relay }) => {
    const slow = JSON.parse((await relay.ctl('fault', 'add', '--route', 'GET /api/terminal/templates', '--mode', 'slow')).stdout);
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText('Loading terminal templates…')).toBeVisible();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    expect((await relay.ctl('fault', 'release', '--id', slow.id)).code).toBe(0);
    await expect(launcher.getByRole('button', { name: 'Shell' })).toContainText('A plain shell');
    await expect(launcher.getByRole('button', { name: 'Logs' })).toContainText('Follow the logs');
    await expect(launcher.getByText('Loading terminal templates…')).toBeHidden();
  });

  test('relay unreachable: the list loads empty @G4.3.r1', async ({ eve, page, relay }) => {
    expect((await relay.ctl('fault', 'add', '--route', 'GET /api/terminal/templates', '--mode', 'down')).code).toBe(0);
    await eve.open('/');
    const launcher = await openLauncher(page);
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(launcher.getByText('Loading terminal templates…')).toBeHidden();
    await expect(launcher.getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(launcher.getByRole('button', { name: 'Shell' })).toBeHidden();
    await expect(launcher.getByRole('button', { name: 'Logs' })).toBeHidden();
  });
});

test.describe('a project that lists one template', () => {
  test.use({
    world: (() => {
      const w = shellWorld();
      w.projects[0].allowed_templates = ['logs'];
      return w;
    })(),
  });

  test('see only the templates this project may launch @G4.3', async ({ eve, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByRole('button', { name: 'Logs' })).toContainText('Follow the logs');
    await expect(launcher.getByRole('button', { name: 'Shell' })).toBeHidden();
  });

  test('start the one template this project may launch @G4.1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await launcher.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByRole('tab', { name: 'Acme - Logs' })).toHaveAttribute('aria-selected', 'true');
    await relay.waitForEvent('session.launch', { match: launchedTerminal });
    expect((await terminals(relay))[0].templateId).toBe('logs');
  });
});

test.describe('a thread is open', () => {
  test.use({
    world: (() => {
      const w = shellWorld();
      w.sessions = [{ id: 's_t1', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'dormant', messages: [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }] }];
      return w;
    })(),
  });

  test('relay down: the Launcher card says so in the thread behind it @G4.1.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Ledger', exact: true }).click();
    await expect(page.getByText('answer', { exact: true })).toBeVisible();
    const launcher = await openLauncher(page);
    expect((await relay.ctl('fault', 'add', '--route', FAULT_ROUTE, '--mode', 'down')).code).toBe(0);
    await launcher.getByRole('button', { name: 'Shell' }).click();
    await expect(page.getByText('terminal create failed: relay unavailable')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toBeHidden();
  });
});
