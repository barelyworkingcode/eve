const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Two threads: Ledger rests, Hold is on a model whose reply is a permission
// prompt, so a message to it leaves it waiting on an answer nobody gives.
function boardWorld() {
  const w = worlds.base();
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
  w.sessions = [
    { id: 's_ledger', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' }] },
    { id: 's_hold', project_id: 'p_acme', name: 'Hold', model: 'acme-ask', state: 'idle', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] },
  ];
  w.terminal_templates = [{ id: 't_sh', name: 'Shell' }];
  return w;
}

// The board's row for an agent: its name, with the state words in its text.
function row(page, name, state) {
  return page.getByRole('button', { name, exact: true }).filter({ hasText: state });
}

// The board is the Agents section of the Acme Project page (Today has not listed the agents
// since eve#615). A second page opened on it, or this page's own after the Project page opens.
function openBoard(eve) {
  return eve.openAnother('/#project/p_acme');
}

async function openProjectPage(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
}

// Opens Hold from Today and sends it a message. It then waits on a prompt, and
// the modal covers this page, so the board is read from another browser.
async function holdThread(page) {
  await page.getByRole('button', { name: 'Hold', exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill('run it from testbox');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'Permission Request' })).toBeVisible();
}

test.describe('agents on the board', () => {
  test.use({ world: boardWorld() });

  test('see each agent in the group for its state @G6.20', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await openBoard(eve);
    await expect(other.getByRole('heading', { name: 'Needs you 1', level: 4 })).toBeVisible();
    await expect(row(other, 'Hold', 'asking')).toBeVisible();
    await expect(other.getByRole('heading', { name: 'Idle 1', level: 4 })).toBeVisible();
    await expect(row(other, 'Ledger', 'idle')).toBeVisible();
    const waiting = row(other, 'Hold', 'asking').getByRole('img', { name: 'Waiting on you' });
    await expect(waiting).toBeVisible();
    await expect(row(other, 'Hold', 'asking')).toHaveAccessibleDescription('Waiting on you');
    await expect(row(other, 'Ledger', 'idle').getByRole('img', { name: 'Idle' })).toBeVisible();
    // The agents the board shows are the threads relay holds. The Chief of Staff's
    // own hidden session (`__cos:`) is created on its own timing and is no agent.
    const seeded = boardWorld().sessions.map((s) => s.name).sort();
    const sessions = (await relay.json('ctl', 'state', '--json')).sessions;
    expect(sessions.map((s) => s.name).filter((n) => !n.startsWith('__cos:')).sort()).toEqual(seeded);
  });

  test('a terminal is working while it runs and done after it exits @G6.20', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Shell', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toBeVisible();
    const running = await openBoard(eve);
    await expect(running.getByRole('heading', { name: 'Working 1', level: 4 })).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await input.focus();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    const finished = await openBoard(eve);
    await expect(finished.getByRole('heading', { name: 'Done 1', level: 4 })).toBeVisible();
    await expect(finished.getByRole('heading', { name: 'Working 1', level: 4 })).toBeHidden();
  });

  test('open an agent from the board @G6.21', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await row(page, 'Ledger', 'idle').click();
    await expect(page.getByRole('tab', { name: /Ledger/ })).toBeVisible();
    await expect(page.getByText('first answer')).toBeVisible();
  });

  test('an agent moves group while the board is open @G6.22', async ({ eve, page }) => {
    const other = await openBoard(eve);
    await eve.open('/');
    await expect(row(other, 'Hold', 'idle')).toBeVisible();
    await holdThread(page);
    await expect(row(other, 'Hold', 'asking')).toBeVisible();
    await expect(row(other, 'Hold', 'idle')).toBeHidden();
    await expect(other.getByRole('heading', { name: 'Needs you 1', level: 4 })).toBeVisible();
  });
});

test('relay is down for the board @G6.20.r1', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openProjectPage(page);
  await expect(page.getByText('No agents running')).toBeVisible();
  // The Project page's board follows relay's socket, so the socket route is the one that goes down.
  const added = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down');
  expect(added.code).toBe(0);
  await expect(page.getByRole('paragraph').filter({ hasText: "Can't reach relay." })).toBeVisible();
});

test('no agents are running @G6.20.r2', async ({ eve, page }) => {
  await eve.open('/');
  await openProjectPage(page);
  await expect(page.getByText('No agents running')).toBeVisible();
});

// A model whose reply is a hold: a routine on it stays running, with no prompt.
function routineWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-ask'];
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'hold' } },
  ];
  return w;
}

// Creates the routine "Testbox sweep", runs it, and closes the run's tab, so the
// run goes on with no tab holding it.
async function runRoutine(page, relay) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox sweep');
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill('Sweep the testbox.');
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('acme-ask');
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  await page.getByRole('button', { name: /Testbox sweep/ }).first().click();
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });
  await page.getByRole('button', { name: /^Close Testbox sweep/ }).click();
  await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toHaveCount(0);
}

const SKIPPED = 'not shown on Today since eve#615; returns with its own journey';

test.describe('a routine that is running', () => {
  test.skip(true, SKIPPED);
  test.use({ world: routineWorld() });

  test('see it under Running @G6.26', async ({ eve, page, relay }) => {
    await eve.open('/');
    await runRoutine(page, relay);
    await eve.reload();
    const running = page.getByRole('button').filter({ hasText: 'Acme · routine' });
    await expect(running).toBeVisible();
    await expect(running).toContainText('Testbox sweep');
    await expect(running.getByRole('img', { name: 'Running', exact: true })).toBeVisible();
  });
});

test.describe('nothing is running', () => {
  test.skip(true, SKIPPED);

  test('nothing is running @G6.26.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText('Nothing running.')).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use({ ...profiles.phone, world: boardWorld() });

  test('see how many agents need me on the Today button @G6.25', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page);
    // The agent that needs me is read on the Project page; the badge is on Today's Bottom bar.
    const board = await openBoard(eve);
    await expect(board.getByRole('heading', { name: 'Needs you 1', level: 4 })).toBeVisible();
    const other = await eve.openAnother('/');
    await expect(other.getByRole('navigation', { name: 'Navigation' }).getByText('1 need you')).toBeVisible();
  });

  test('no count when no agent needs me @G6.25.r1', async ({ eve, page }) => {
    // Both agents rest, as the Project page's board shows; Today's Bottom bar then has no count.
    const board = await openBoard(eve);
    await expect(board.getByRole('heading', { name: 'Idle 2', level: 4 })).toBeVisible();
    await eve.open('/');
    const bar = page.getByRole('navigation', { name: 'Navigation' });
    await expect(bar.getByRole('button', { name: /^Today/ })).toBeVisible();
    await expect(bar.getByText(/\d+ need you/)).toBeHidden();
  });
});
