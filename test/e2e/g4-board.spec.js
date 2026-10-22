const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  return w;
}

async function terminals(relay) {
  return (await relay.json('ctl', 'state', '--json')).terminals;
}

// Starts the Shell terminal from its Today tile and focuses its input.
async function startShell(page) {
  await page.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Terminal input' }).focus();
}

// Types a line and waits until the terminal has echoed it, so the saved log holds it.
async function sendLine(page, text) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

// Opens the Acme Project page from the Project panel; its Agents section is the board
// (Today has not listed the agents since eve#615).
async function openProjectPage(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
}

// A second page opened straight on the Acme Project page.
async function openBoard(eve) {
  const board = await eve.openAnother('/#project/p_acme');
  await expect(board.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  return board;
}

// The Project page's row of the terminal reads "Shell open" plus the last line; the page lists
// only its own project's terminals, so the row has no project name (the Chief of Staff rail
// row does). The Today tile "Shell" is a button too, but Today is hidden behind the page.
const agentRow = (page) => page.getByRole('button').filter({ hasText: 'Shell' });

test.use({ world: shellWorld() });

test('see every live terminal on the agent board of the Project page @G4.26', async ({ eve, page, relay }) => {
  await eve.open('/');
  await startShell(page);
  await sendLine(page, 'build finished');
  const board = await openBoard(eve);
  const row = agentRow(board);
  await expect(row).toBeVisible();
  await expect(row).toContainText('open');
  await expect(row).toContainText('build finished');
  // The same board in the Chief of Staff rail names the project.
  await board.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  const railRow = board.getByRole('navigation', { name: 'Agents' }).getByRole('button', { name: /^Shell/ });
  await expect(railRow).toBeVisible();
  await expect(railRow).toContainText('Acme');
  await expect(railRow).toContainText('open');
  const list = await terminals(relay);
  expect(list).toHaveLength(1);
  expect(list[0].name).toContain('Shell');
});

test('the board says nothing runs when no terminal is open @G4.26.r2', async ({ eve, page }) => {
  await eve.open('/');
  await openProjectPage(page);
  await expect(page.getByText('No agents running')).toBeVisible();
  await expect(agentRow(page)).toBeHidden();
});

test('the board says relay is out of reach @G4.26.r1', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openProjectPage(page);
  await expect(page.getByText('No agents running')).toBeVisible();
  expect((await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down')).code).toBe(0);
  // The Ask line on Today also says it, as a status; the Agents section's own line is a paragraph.
  await expect(page.getByRole('paragraph').filter({ hasText: "Can't reach relay." })).toBeVisible();
});

test('reload brings back no terminal tab, only the board row @G4.27', async ({ eve, page, relay }) => {
  await eve.open('/');
  await startShell(page);
  await sendLine(page, 'still here');
  await eve.reload();
  await openProjectPage(page);
  await expect(agentRow(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toHaveCount(0);
  expect(await terminals(relay)).toHaveLength(1);
});

test('reopen a live terminal from its board row @G4.28', async ({ eve, page }) => {
  await eve.open('/');
  await startShell(page);
  await sendLine(page, 'earlier output');
  const board = await openBoard(eve);
  await expect(agentRow(board)).toContainText('earlier output');
  await agentRow(board).click();
  await expect(board.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
  // The Project page's row (now a hidden tab) also carries the line; take the visible copy, the terminal's own.
  await expect(board.getByText('earlier output', { exact: true }).filter({ visible: true })).toBeVisible();
});

test('reopen a terminal that has exited @G4.29', async ({ eve, page, relay }) => {
  await eve.open('/');
  await startShell(page);
  await sendLine(page, 'saved output');
  await page.keyboard.type('exit 2');
  await page.keyboard.press('Enter');
  await relay.waitForEvent('session.exited');
  const board = await openBoard(eve);
  await expect(agentRow(board)).toContainText('exited 2');
  await agentRow(board).click();
  await expect(board.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
  await expect(board.getByText('saved output', { exact: true }).last()).toBeVisible();
  // The "takes no more typing" half is unproven hermetically (gap R15): fakerelay drops bytes after exit whatever eve sends.
  const list = await terminals(relay);
  expect(list).toHaveLength(1);
  expect(list[0].state).toBe('stopped');
  expect(list[0].name).toContain('Shell');
});

// Runs the terminal to its end with `exit <code>`, then reloads and opens the Project page so
// its board lists it afresh.
async function endTerminal(eve, page, relay, code) {
  await page.keyboard.type(`exit ${code}`);
  await page.keyboard.press('Enter');
  await relay.waitForEvent('session.exited');
  await eve.reload();
  await openProjectPage(page);
}

test('see a terminal open, then exited with its code @G4.30', async ({ eve, page, relay }) => {
  await eve.open('/');
  await startShell(page);
  await eve.reload();
  await openProjectPage(page);
  await expect(agentRow(page)).toContainText('open');
  expect((await terminals(relay))[0].state).toBe('running');
  // A running terminal needs nobody: the board has no Needs you group.
  await expect(page.getByRole('heading', { level: 4, name: /^Needs you/ })).toBeHidden();
  await agentRow(page).click();
  await page.getByRole('textbox', { name: 'Terminal input' }).focus();
  await endTerminal(eve, page, relay, 4);
  await expect(agentRow(page)).toContainText('exited 4');
  await expect(page.getByRole('heading', { level: 4, name: /^Needs you/ })).toBeVisible();
  const list = await terminals(relay);
  expect(list[0].state).toBe('stopped');
  expect(list[0].exitCode).toBe(4);
});

test('a clean exit stays off Needs you @G4.30', async ({ eve, page, relay }) => {
  await eve.open('/');
  await startShell(page);
  await endTerminal(eve, page, relay, 0);
  await expect(agentRow(page)).toContainText('exited');
  // The exit row above is the positive marker for the board having loaded.
  await expect(page.getByRole('heading', { level: 4, name: /^Needs you/ })).toBeHidden();
});

test('close a terminal @G4.25', async ({ eve, page, relay }) => {
  await eve.open('/');
  await startShell(page);
  expect(await terminals(relay)).toHaveLength(1);
  await page.getByRole('button', { name: 'Close Acme - Shell' }).click();
  await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toBeHidden();
  // Closing the last tab shows Today; the Project page's board no longer lists the terminal.
  await openProjectPage(page);
  await expect(page.getByText('No agents running')).toBeVisible();
  await expect(agentRow(page)).toBeHidden();
  // Nothing relay sends marks the close, so wait on the state until the row is gone.
  await expect.poll(async () => (await terminals(relay)).length).toBe(0);
});

test('see a project terminals on its Project page @G4.31', async ({ eve, page }) => {
  await eve.open('/');
  await startShell(page);
  await sendLine(page, 'project line');
  const other = await eve.openAnother('/#project/p_acme');
  await expect(other.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  const row = other.getByRole('button').filter({ hasText: 'Shell' }).filter({ hasText: 'project line' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(other.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
});

test('the Project page says nothing runs @G4.31.r2', async ({ eve, page }) => {
  await eve.open('/#project/p_acme');
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(page.getByText('No agents running')).toBeVisible();
});

test('the Project page says relay is out of reach @G4.31.r1', async ({ eve, page, relay }) => {
  await eve.open('/#project/p_acme');
  await expect(page.getByText('No agents running')).toBeVisible();
  expect((await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down')).code).toBe(0);
  await expect(page.getByRole('paragraph').filter({ hasText: "Can't reach relay." })).toBeVisible();
});

test('a routine run terminal stays off the board @G4.32', async ({ eve, page, relay }) => {
  await eve.open('/');
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox sweep');
  await dialog.getByText('Advanced').click();
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
  await dialog.getByRole('combobox', { name: 'Template' }).selectOption({ label: 'Shell' });
  await dialog.getByRole('combobox', { name: 'Schedule' }).selectOption({ label: 'On demand' });
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  await page.getByRole('button', { name: /Testbox sweep/ }).first().click();
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  await relay.waitForEvent('session.launch', { match: (l) => l.kind === 'terminal' });
  expect(await terminals(relay)).toHaveLength(1);
  const board = await openBoard(eve);
  // The run shows on its routine's row ("running now"), never as an agent.
  await expect(board.getByText('running now')).toBeVisible();
  await expect(board.getByText('No agents running')).toBeVisible();
  expect(await terminals(relay)).toHaveLength(1);
});

test('a terminal works again after the connection returns @G4.33', async ({ eve, page }) => {
  await eve.open('/');
  await startShell(page);
  // The board row behind the terminal repeats only the last line, so the first line is the
  // terminal's own and a repeated screen would show it twice.
  await sendLine(page, 'before the drop');
  await sendLine(page, 'last before');
  await eve.setOffline(true);
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await eve.setOffline(false);
  await expect(page.getByText('Reconnecting…')).toBeHidden();
  await page.getByRole('textbox', { name: 'Terminal input' }).focus();
  await page.keyboard.type('after the drop');
  await expect(page.getByText('after the drop', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('before the drop', { exact: true })).toHaveCount(1);
});

test('the tab follows the title the program sets @G4.34', async ({ eve, page }) => {
  await eve.open('/');
  await startShell(page);
  // Escape, "]0;Deploy" and Bell echo back as the OSC sequence that sets the title.
  await page.keyboard.press('Escape');
  await page.keyboard.type(']0;Deploy');
  await page.keyboard.press('Control+G');
  await expect(page.getByRole('tab', { name: 'Deploy' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.type(']0;');
  await page.keyboard.press('Control+G');
  await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toBeVisible();
});

test('the board row shows the last non-empty line, cut at 120 characters @G4.35', async ({ eve, page }) => {
  await eve.open('/');
  await startShell(page);
  const long = 'x'.repeat(130);
  await page.keyboard.type(long);
  await page.keyboard.type('END');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByText('END')).toBeVisible();
  const board = await openBoard(eve);
  const row = agentRow(board);
  await expect(row).toContainText('x'.repeat(100));
  await expect(row).not.toContainText('x'.repeat(121));
  await expect(row).not.toContainText('END');
});
