const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function modelWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-model'];
  w.models = [{ value: 'acme-model', label: 'Acme Model', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } }];
  return w;
}

// A model whose reply is a hold: a run on it stays running, with no prompt.
function holdWorld() {
  const w = modelWorld();
  w.models[0].reply = { kind: 'hold' };
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

// Opens the Routine dialog from the Project page and returns it.
async function openDialog(page) {
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Fills the New form of a chat routine; leaves the schedule to the caller.
async function fillChat(dialog, name) {
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill(`Run ${name}.`);
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('acme-model');
}

async function create(dialog) {
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
}

// A chat routine on the daily schedule, made from the Project page. Leaves the page open.
async function addRoutine(page, name) {
  const dialog = await openDialog(page);
  await fillChat(dialog, name);
  await create(dialog);
}

async function schedule(dialog, label) {
  await dialog.getByRole('combobox', { name: 'Schedule' }).selectOption({ label });
}

// Reopens the dialog on its list of routines.
async function openList(page) {
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Routines', exact: true }).click();
  return dialog;
}

test.describe('schedules', () => {
  test.use({ world: modelWorld() });

  test('schedule a routine daily @G5.22', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'Daily');
    await dialog.getByRole('textbox', { name: 'Time' }).fill('07:30');
    await create(dialog);
    await expect(page.getByText('Every day at 07:30', { exact: true })).toBeVisible();
    const list = await openList(page);
    await expect(list.getByText('Daily at 07:30', { exact: true })).toBeVisible();
  });

  test('schedule a routine hourly @G5.23', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'Hourly');
    await dialog.getByRole('spinbutton', { name: 'Minute' }).fill('15');
    await create(dialog);
    await expect(page.getByText('Every hour at :15', { exact: true })).toBeVisible();
    const list = await openList(page);
    await expect(list.getByText('Hourly at :15', { exact: true })).toBeVisible();
  });

  test('schedule a routine every few minutes @G5.24', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'Interval');
    await dialog.getByRole('spinbutton', { name: 'Interval (minutes)' }).fill('20');
    await create(dialog);
    await expect(page.getByText('Every 20 minutes', { exact: true })).toBeVisible();
    const list = await openList(page);
    await expect(list.getByText('Every 20m', { exact: true })).toBeVisible();
  });

  test('schedule a routine weekly @G5.25', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'Weekly');
    await dialog.getByRole('combobox', { name: 'Day' }).selectOption({ label: 'Wed' });
    await dialog.getByRole('textbox', { name: 'Time' }).fill('08:15');
    await create(dialog);
    await expect(page.getByText('Every Wednesday at 08:15', { exact: true })).toBeVisible();
  });

  test('schedule a routine with a cron expression @G5.26', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'Cron');
    await dialog.getByRole('textbox', { name: 'Cron Expression' }).fill('30 4 * * *');
    await create(dialog);
    // The scheduler refuses every cron shape the Project page cannot say, so a plain
    // daily shape is the one a cron routine can have here.
    await expect(page.getByText('Every day at 04:30', { exact: true })).toBeVisible();
    const list = await openList(page);
    await expect(list.getByText('Cron: 30 4 * * *', { exact: true })).toBeVisible();
  });

  test('schedule a routine once @G5.27', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'Once');
    await dialog.getByRole('textbox', { name: 'Date & Time' }).fill('2027-03-05T10:30');
    await create(dialog);
    await expect(page.getByText('Once, Fri 5 Mar 2027 at 10:30', { exact: true })).toBeVisible();
  });

  test('schedule a routine to run only on demand @G5.28', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await schedule(dialog, 'On demand');
    await create(dialog);
    await expect(page.getByText('When I ask', { exact: true })).toBeVisible();
    const list = await openList(page);
    await expect(list.getByText('On demand', { exact: true })).toBeVisible();
  });

  test('turn a routine off or on @G5.29', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await dialog.getByRole('checkbox', { name: 'Enabled' }).uncheck();
    await create(dialog);
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    let list = await openList(page);
    await expect(list.getByText('disabled', { exact: true })).toBeVisible();
    await list.getByRole('button', { name: 'Edit', exact: true }).click();
    await list.getByRole('checkbox', { name: 'Enabled' }).check();
    await list.getByRole('button', { name: 'Update routine', exact: true }).click();
    await expect(list).toBeHidden();
    await expect(page.getByText('Paused', { exact: true })).toBeHidden();
    list = await openList(page);
    await expect(list.getByText('ready', { exact: true })).toBeVisible();
  });
});

test.describe('the routine dialog', () => {
  test.use({ world: modelWorld() });

  test('create the routine from the dialog @G5.30', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true })).toBeVisible();
    await expect(page.getByText('Every day at 09:00', { exact: true })).toBeVisible();
    await expect(page.getByText('never ran', { exact: true })).toBeVisible();
    await eve.reload();
    await openProjectPage(page);
    await expect(page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true })).toBeVisible();
    await expect(page.getByText('never ran', { exact: true })).toBeVisible();
  });

  test('a failed save keeps the dialog open @G5.30.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await fillChat(dialog, 'Testbox sweep');
    const added = await relay.ctl('fault', 'add', '--route', 'PROXY /api/tasks', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(page.getByText(/^Couldn't save the routine: /)).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true })).toHaveCount(0);
  });

  test('no model chosen on create says so @G5.30.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/models', '--mode', 'slow');
    expect(added.code).toBe(0);
    await eve.reload();
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'New', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox sweep');
    await dialog.getByRole('textbox', { name: 'Prompt' }).fill('Run it.');
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(page.getByText('Choose a model before saving this routine.')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('change a routine from the Project page @G5.31', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await page.getByRole('button', { name: 'Edit Testbox sweep', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toHaveValue('Testbox sweep');
    await expect(dialog.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Run Testbox sweep.');
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toHaveValue('acme-model');
    await expect(dialog.getByRole('button', { name: 'Update routine', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create routine', exact: true })).toBeHidden();
  });

  test('save the changes to a routine @G5.32', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await expect(page.getByText('Every day at 09:00', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Testbox sweep', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    await schedule(dialog, 'Hourly');
    await dialog.getByRole('spinbutton', { name: 'Minute' }).fill('45');
    await dialog.getByRole('button', { name: 'Update routine', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Every hour at :45', { exact: true })).toBeVisible();
    await expect(page.getByText('Every day at 09:00', { exact: true })).toHaveCount(0);
  });

  test('a failed update keeps the dialog open @G5.32.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await page.getByRole('button', { name: 'Edit Testbox sweep', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    await schedule(dialog, 'Hourly');
    await dialog.getByRole('spinbutton', { name: 'Minute' }).fill('45');
    const added = await relay.ctl('fault', 'add', '--route', 'PROXY /api/tasks/', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    await dialog.getByRole('button', { name: 'Update routine', exact: true }).click();
    await expect(page.getByText(/^Couldn't save the routine: /)).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Every hour at :45', { exact: true })).toHaveCount(0);
  });

  test('go back from editing to the routine list @G5.33', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await page.getByRole('button', { name: 'Edit Testbox sweep', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toBeHidden();
    await expect(dialog.getByText('Testbox sweep', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Daily at 09:00', { exact: true })).toBeVisible();
  });

  test('delete a routine @G5.34', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    const list = await openList(page);
    const asked = new Promise((resolve) => page.once('dialog', async (d) => { resolve(d.message()); await d.accept(); }));
    await list.getByRole('button', { name: 'Delete', exact: true }).click();
    expect(await asked).toBe('Delete routine "Testbox sweep"?');
    await expect(list.getByText('Testbox sweep', { exact: true })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true })).toHaveCount(0);
  });

  test('a failed delete leaves the routine @G5.34.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    const list = await openList(page);
    const added = await relay.ctl('fault', 'add', '--route', 'PROXY /api/tasks/', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    page.once('dialog', (d) => d.accept());
    const since = relay.mark();
    await list.getByRole('button', { name: 'Delete', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
    await expect(list.getByText('Testbox sweep', { exact: true })).toBeVisible();
    await expect(list).toBeVisible();
  });

  test('run a routine now from the Routine dialog @G5.35', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    const list = await openList(page);
    await list.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  });
});

test.describe('a terminal routine', () => {
  test.use({ world: shellWorld() });

  test('run a terminal routine now from the Routine dialog @G5.35', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'New', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox shell');
    await dialog.getByText('Advanced').click();
    await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
    await create(dialog);
    const list = await openList(page);
    await list.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole('tab', { name: /Testbox shell/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
  });

  test('run a terminal routine now from the Project page @G5.36', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'New', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox shell');
    await dialog.getByText('Advanced').click();
    await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
    await create(dialog);
    await page.getByRole('button', { name: 'Run Now Testbox shell', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox shell/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
  });
});

test.describe('a run that is held', () => {
  test.use({ world: holdWorld() });

  test('run a routine now from the Project page @G5.36', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await expect(page.getByText('running now')).toBeVisible();
  });
});
