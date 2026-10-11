const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function modelWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-model'];
  w.models = [{ value: 'acme-model', label: 'Acme Model', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } }];
  return w;
}

// A model whose reply is a permission prompt: a run on it stays held until answered.
function holdWorld() {
  const w = modelWorld();
  w.models[0].reply = { kind: 'permission', tool: 'Bash' };
  return w;
}

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  w.projects[0].allowed_templates = ['shell'];
  return w;
}

async function openProjectPage(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
}

// Makes a daily chat routine from the Project page. Leaves the Project page open.
async function addRoutine(page, name) {
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill(`Run ${name}.`);
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('acme-model');
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function addTerminalRoutine(page, name) {
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill(name);
  await dialog.getByText('Advanced').click();
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openRoutinesPage(page) {
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
}

function routineButton(page, name) {
  return page.getByRole('button', { name, exact: true }).first();
}

// Opens the routine's sheet from the Routines page.
async function openSheet(page, name) {
  await routineButton(page, name).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'Run Now', exact: true })).toBeVisible();
  return sheet;
}

test.describe('the Routines page', () => {
  test.use({ world: modelWorld() });

  test('see the routines of every project on one page @G5.37', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await addRoutine(page, 'Testbox tidy');
    await openRoutinesPage(page);
    const sweep = routineButton(page, 'Testbox sweep');
    await expect(sweep).toContainText('Every day at 09:00');
    await expect(sweep).toContainText('Testbox sweep · Acme');
    await expect(sweep).toContainText('never ran');
    await expect(routineButton(page, 'Testbox tidy')).toContainText('Testbox tidy · Acme');
    await expect(page.getByRole('tab', { name: 'Routines' })).toBeVisible();
  });

  test('nothing scheduled says so @G5.37.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openRoutinesPage(page);
    await expect(page.getByText('Nothing scheduled in Work.')).toBeVisible();
  });

  test('a failed load offers Retry @G5.37.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    const added = await relay.ctl('fault', 'add', '--route', 'PROXY /api/tasks', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    await eve.reload();
    await openRoutinesPage(page);
    const retry = page.getByRole('main').getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    await expect(routineButton(page, 'Testbox sweep')).toBeHidden();
    expect((await relay.ctl('fault', 'clear')).code).toBe(0);
    await retry.click();
    await expect(routineButton(page, 'Testbox sweep')).toBeVisible();
  });

  test('open the Routines page from a Project page @G5.38', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await addRoutine(page, 'Testbox tidy');
    await page.getByRole('button', { name: 'All routines', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
    await expect(routineButton(page, 'Testbox sweep')).toBeVisible();
    await expect(routineButton(page, 'Testbox tidy')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Routines' })).toBeVisible();
  });

  test('open the Routines page from a link @G5.39', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await openRoutinesPage(page);
    await eve.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
    await expect(routineButton(page, 'Testbox sweep')).toBeVisible();
    const other = await eve.openAnother('/#routines');
    await expect(other.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Routines' })).toBeVisible();
    await expect(other.getByRole('tab', { name: 'Routines' })).toBeVisible();
  });

  test('open a routine\'s sheet @G5.40', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await openRoutinesPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByText('Every day at 09:00')).toBeVisible();
    await expect(sheet.getByText('Testbox sweep').first()).toBeVisible();
    await expect(sheet.getByText('Acme').first()).toBeVisible();
    await expect(sheet.getByText('never ran')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  });

  test('edit a routine from its sheet @G5.42', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await openRoutinesPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'Run Now', exact: true })).toBeHidden();
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toHaveValue('Testbox sweep');
    await expect(dialog.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Run Testbox sweep.');
    await expect(dialog.getByRole('button', { name: 'Update routine', exact: true })).toBeVisible();
  });

  test('close a routine\'s sheet @G5.43', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await openRoutinesPage(page);
    let sheet = await openSheet(page, 'Testbox sweep');
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'Run Now', exact: true })).toBeHidden();
    sheet = await openSheet(page, 'Testbox sweep');
    await page.keyboard.press('Escape');
    await expect(sheet.getByRole('button', { name: 'Run Now', exact: true })).toBeHidden();
    sheet = await openSheet(page, 'Testbox sweep');
    await page.mouse.click(2, 2);
    await expect(sheet.getByRole('button', { name: 'Run Now', exact: true })).toBeHidden();
    await expect(routineButton(page, 'Testbox sweep')).toBeVisible();
  });
});

test.describe('a run that is held', () => {
  test.use({ world: holdWorld() });

  test('run a routine from its sheet @G5.41', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await openRoutinesPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await sheet.getByRole('button', { name: 'Run Now', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await openRoutinesPage(page);
    await expect(routineButton(page, 'Testbox sweep')).toContainText('running now');
  });

  test('a started run shows running now, with no reload @G5.44', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await expect(page.getByText('never ran', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await expect(page.getByText('running now', { exact: true })).toBeVisible();
    await expect(page.getByText('never ran', { exact: true })).toBeHidden();
  });
});

test.describe('a finished run', () => {
  test.use({ world: modelWorld() });

  test('a finished run shows ran with its time and ok, with no reload @G5.44', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await expect(page.getByText('never ran', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await expect(page.getByText(/^ran \d\d:\d\d · ok$/)).toBeVisible();
    await expect(page.getByText('never ran', { exact: true })).toBeHidden();
  });
});

test.describe('a failed run', () => {
  test.use({ world: modelWorld() });

  test('a failed run shows failed with its reason, with no reload @G5.44', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error', '--times', '1', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    const since = relay.mark();
    await page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
    await expect(page.getByText(/^failed \d\d:\d\d · \S/)).toBeVisible();
  });
});

test.describe('a terminal routine', () => {
  test.use({ world: shellWorld() });

  test('run a terminal routine from its sheet @G5.41', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addTerminalRoutine(page, 'Testbox shell');
    await openRoutinesPage(page);
    const sheet = await openSheet(page, 'Testbox shell');
    await sheet.getByRole('button', { name: 'Run Now', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox shell/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
  });
});
