const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// One project that may use two models, and a thread on the first.
function threadWorld({ threadModel = 'acme-model', allowed = ['acme-model', 'acme-other'] } = {}) {
  const w = worlds.base();
  w.projects[0].allowed_models = allowed;
  w.models = [
    { value: 'acme-model', label: 'Acme Model', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } },
    { value: 'acme-other', label: 'Acme Other', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } },
  ];
  w.sessions = [
    { id: 's_alpha', project_id: 'p_acme', name: 'Alpha notes', model: threadModel, state: 'idle', messages: [{ role: 'user', text: 'Sweep the testbox.' }, { role: 'assistant', text: 'echo: Sweep the testbox.' }] },
    { id: 's_empty', project_id: 'p_acme', name: 'Empty notes', model: threadModel, state: 'idle', messages: [] },
  ];
  return w;
}

async function openThread(page, name) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).first().click();
  await expect(page.getByRole('tab', { name, selected: true })).toBeVisible();
}

async function openPanel(page) {
  await openThread(page, 'Alpha notes');
  await page.getByRole('button', { name: 'Make this a routine', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Make this a routine' });
  await expect(panel).toBeVisible();
  return panel;
}

async function openRoutinesPage(page) {
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
}

test.describe('the routine panel', () => {
  test.use({ world: threadWorld() });

  test('make the open thread a routine @G5.1', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await expect(panel.getByRole('textbox', { name: 'Routine name' })).toHaveValue('Alpha notes');
    await expect(panel.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Sweep the testbox.');
  });

  test('a thread with no message has no routine button @G5.1.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openThread(page, 'Alpha notes');
    await expect(page.getByRole('button', { name: 'Make this a routine', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await openThread(page, 'Empty notes');
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Make this a routine', exact: true })).toBeHidden();
  });

  test('a routine run has no routine button @G5.1.r1', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await page.getByRole('button', { name: 'Run Now Alpha notes', exact: true }).click();
    const runTab = page.getByRole('button', { name: /^Close Alpha notes/ }).last();
    await expect(runTab).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Make this a routine', exact: true })).toBeHidden();
  });

  test('a voice thread has no routine button @G5.1.r1', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Project page', exact: true }).click();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await page.getByRole('button', { name: 'Voice Chat' }).click();
    await page.getByRole('button', { name: 'Start Voice Chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'End session', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Make this a routine', exact: true })).toBeHidden();
  });

  test('rename the routine in the panel @G5.2', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    const name = panel.getByRole('textbox', { name: 'Routine name' });
    await name.fill('Testbox sweep');
    await expect(name).toHaveValue('Testbox sweep');
    await name.fill('x'.repeat(70));
    await expect(name).toHaveValue('x'.repeat(60));
  });

  test('an empty name disables Create routine @G5.2.r1', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await expect(panel.getByRole('button', { name: 'Create routine', exact: true })).toBeEnabled();
    await panel.getByRole('textbox', { name: 'Routine name' }).fill('');
    await expect(panel.getByRole('button', { name: 'Create routine', exact: true })).toBeDisabled();
  });

  test('edit the routine prompt in the panel @G5.3', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    const prompt = panel.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Check the testbox disks.');
    await expect(prompt).toHaveValue('Check the testbox disks.');
  });

  test('an empty prompt disables Create routine @G5.3.r1', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await expect(panel.getByRole('button', { name: 'Create routine', exact: true })).toBeEnabled();
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('');
    await expect(panel.getByRole('button', { name: 'Create routine', exact: true })).toBeDisabled();
  });

  test('pick the routine model in the panel @G5.4', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    const model = panel.getByRole('combobox', { name: 'Model' });
    await expect(panel.getByText('using Acme Model.')).toBeVisible();
    await model.selectOption('acme-other');
    await expect(model).toHaveValue('acme-other');
    await expect(panel.getByText('using Acme Other.')).toBeVisible();
    await expect(panel.getByText('using Acme Model.')).toBeHidden();
  });

  test('choose how often the routine runs @G5.5', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    const every = panel.getByRole('button', { name: 'Every day', exact: true });
    await expect(every).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText('Every day at 09:00, in Acme, using Acme Model.')).toBeVisible();
    await panel.getByRole('button', { name: 'Every hour', exact: true }).click();
    await expect(every).toHaveAttribute('aria-pressed', 'false');
    await every.click();
    await expect(every).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText('Every day at 09:00, in Acme, using Acme Model.')).toBeVisible();
  });

  test('set the time of day in the panel @G5.6', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('textbox', { name: 'At' }).fill('07:30');
    await expect(panel.getByText('Every day at 07:30, in Acme, using Acme Model.')).toBeVisible();
  });

  test('a cleared time disables Create routine @G5.6.r1', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await expect(panel.getByRole('button', { name: 'Create routine', exact: true })).toBeEnabled();
    await panel.getByRole('textbox', { name: 'At' }).fill('');
    await expect(panel.getByRole('button', { name: 'Create routine', exact: true })).toBeDisabled();
  });

  test('pick the weekday in the panel @G5.7', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'Every Monday', exact: true }).click();
    await panel.getByRole('combobox', { name: 'Day' }).selectOption({ label: 'Wednesday' });
    await expect(panel.getByRole('button', { name: 'Every Wednesday', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText('Every Wednesday at 09:00, in Acme, using Acme Model.')).toBeVisible();
  });

  test('set the minute past the hour in the panel @G5.8', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'Every hour', exact: true }).click();
    await panel.getByRole('spinbutton', { name: 'Minute past the hour' }).fill('15');
    await expect(panel.getByText('Every hour at :15, in Acme, using Acme Model.')).toBeVisible();
  });

  test('run the routine only when I ask @G5.9', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'When I ask', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'When I ask', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText('When I ask, in Acme, using Acme Model.')).toBeVisible();
  });

  test('create the routine from the panel @G5.10', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('textbox', { name: 'Routine name' }).fill('Testbox sweep');
    await panel.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('Every day at 09:00')).toBeVisible();
    await openRoutinesPage(page);
    await expect(page.getByRole('button', { name: /Testbox sweep/ }).first()).toBeVisible();
  });

  test('a failed save keeps the panel open @G5.10.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    const added = await relay.ctl('fault', 'add', '--route', 'PROXY /api/tasks', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    await panel.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(page.getByText(/^Couldn't save the routine: /)).toBeVisible();
    await expect(panel).toBeVisible();
  });

  test('close the panel without making a routine @G5.11', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run Now Alpha notes', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ New routine', exact: true })).toBeVisible();
    await expect(page.getByText('never ran')).toHaveCount(0);
  });
});

test.describe('a thread model the project no longer allows', () => {
  test.use({ world: threadWorld({ threadModel: 'sonnet' }) });

  test('the panel says which model it uses instead @G5.4.r1', async ({ eve, page }) => {
    await eve.open('/');
    const panel = await openPanel(page);
    await expect(panel.getByText(/isn't allowed in Acme now, so this uses Acme Model\./)).toBeVisible();
  });
});
