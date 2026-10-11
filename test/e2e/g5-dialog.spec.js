const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// One project that may use one of two models.
function modelWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-model'];
  w.models = [
    { value: 'acme-model', label: 'Acme Model', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } },
    { value: 'acme-hidden', label: 'Acme Hidden', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } },
  ];
  return w;
}

// Two console templates; the project may launch only the first.
function templateWorld() {
  const w = worlds.base();
  w.terminal_templates = [
    { id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' },
    { id: 'tools', name: 'Tools', command: '/bin/sh', description: 'A shell with tools' },
  ];
  w.projects[0].allowed_templates = ['shell'];
  return w;
}

// Opens the Routine dialog from the Project page and returns it.
async function openDialog(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openNew(page) {
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toBeVisible();
  return dialog;
}

// A terminal routine form: Advanced open, Type switched.
async function openTerminalForm(page) {
  const dialog = await openNew(page);
  await dialog.getByText('Advanced').click();
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
  await expect(dialog.getByRole('combobox', { name: 'Template' })).toBeVisible();
  return dialog;
}

test.describe('the Routine dialog', () => {
  test.use({ world: modelWorld() });

  test('open the Routine dialog for a project @G5.12', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Routines' })).toBeVisible();
    await expect(dialog.getByText('Acme', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Routines', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'New', exact: true })).toBeVisible();
  });

  test('name a routine in the dialog @G5.13', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openNew(page);
    const name = dialog.getByRole('textbox', { name: 'Routine name' });
    await name.fill('Testbox sweep');
    await expect(name).toHaveValue('Testbox sweep');
  });

  test('write the prompt a chat routine sends @G5.14', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openNew(page);
    const prompt = dialog.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Sweep the testbox.');
    await expect(prompt).toHaveValue('Sweep the testbox.');
  });

  test('pick the model a chat routine uses @G5.15', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openNew(page);
    const model = dialog.getByRole('combobox', { name: 'Model' });
    await expect(model.getByRole('option', { name: 'Acme Model' })).toBeAttached();
    await expect(model.getByRole('option', { name: 'Acme Hidden' })).toHaveCount(0);
    await model.selectOption('acme-model');
    await expect(model).toHaveValue('acme-model');
  });

  test('no model chosen on save says so @G5.15.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/models', '--mode', 'slow');
    expect(added.code).toBe(0);
    await eve.reload();
    const dialog = await openNew(page);
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox sweep');
    await dialog.getByRole('textbox', { name: 'Prompt' }).fill('Sweep the testbox.');
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(page.getByText('Choose a model before saving this routine.')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('models still loading show Loading models @G5.15.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/models', '--mode', 'slow');
    expect(added.code).toBe(0);
    const id = JSON.parse(added.stdout).id;
    await eve.reload();
    const dialog = await openNew(page);
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(dialog.getByRole('combobox', { name: 'Model' }).getByRole('option', { name: 'Loading models…' })).toBeAttached();
    expect((await relay.ctl('fault', 'release', '--id', id)).code).toBe(0);
    await expect(dialog.getByRole('combobox', { name: 'Model' }).getByRole('option', { name: 'Acme Model' })).toBeAttached();
  });

  test('switch a routine to a terminal routine @G5.16', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openNew(page);
    await expect(dialog.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await dialog.getByText('Advanced').click();
    await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
    await expect(dialog.getByRole('combobox', { name: 'Template' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Extra Args (space-separated, use quotes for grouped args)' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Directory (optional, defaults to project path)' })).toBeVisible();
    await expect(dialog.getByRole('spinbutton', { name: 'Timeout (minutes, 0 = use default 30)' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Prompt' })).toBeHidden();
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeHidden();
  });

  test('add arguments to a terminal routine @G5.18', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openTerminalForm(page);
    const args = dialog.getByRole('textbox', { name: 'Extra Args (space-separated, use quotes for grouped args)' });
    await args.fill('-c "npm test"');
    await expect(args).toHaveValue('-c "npm test"');
  });

  test('choose the folder a terminal routine runs in @G5.19', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openTerminalForm(page);
    const dir = dialog.getByRole('textbox', { name: 'Directory (optional, defaults to project path)' });
    await dir.fill('/tmp/testbox');
    await expect(dir).toHaveValue('/tmp/testbox');
  });

  test('limit how long a terminal routine may run @G5.20', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openTerminalForm(page);
    const timeout = dialog.getByRole('spinbutton', { name: 'Timeout (minutes, 0 = use default 30)' });
    await timeout.fill('5');
    await expect(timeout).toHaveValue('5');
  });

  test('choose when the routine runs @G5.21', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openNew(page);
    const schedule = dialog.getByRole('combobox', { name: 'Schedule' });
    await expect(schedule.getByRole('option')).toHaveText(['Daily', 'Hourly', 'Interval', 'Weekly', 'Cron', 'Once', 'On demand']);
    await expect(dialog.getByRole('textbox', { name: 'Time' })).toBeVisible();
    await schedule.selectOption({ label: 'Hourly' });
    await expect(dialog.getByRole('spinbutton', { name: 'Minute' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Time' })).toBeHidden();
    await schedule.selectOption({ label: 'Interval' });
    await expect(dialog.getByRole('spinbutton', { name: 'Interval (minutes)' })).toBeVisible();
    await schedule.selectOption({ label: 'Weekly' });
    await expect(dialog.getByRole('combobox', { name: 'Day' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Time' })).toBeVisible();
    await schedule.selectOption({ label: 'Cron' });
    await expect(dialog.getByRole('textbox', { name: 'Cron Expression' })).toBeVisible();
    await schedule.selectOption({ label: 'Once' });
    await expect(dialog.getByRole('textbox', { name: 'Date & Time' })).toBeVisible();
    await schedule.selectOption({ label: 'On demand' });
    await expect(dialog.getByRole('textbox', { name: 'Date & Time' })).toBeHidden();
    await expect(dialog.getByRole('textbox', { name: 'Time' })).toBeHidden();
  });
});

test.describe('terminal templates', () => {
  test.use({ world: templateWorld() });

  test('pick the terminal template a routine runs @G5.17', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openTerminalForm(page);
    const template = dialog.getByRole('combobox', { name: 'Template' });
    await expect(template.getByRole('option')).toHaveText(['Shell']);
    await expect(template.getByRole('option', { name: 'Tools' })).toHaveCount(0);
  });
});

test.describe('no terminal templates', () => {
  test('none available says so @G5.17.r1', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openTerminalForm(page);
    await expect(dialog.getByRole('combobox', { name: 'Template' }).getByRole('option', { name: '(no templates available)' })).toBeAttached();
  });
});
