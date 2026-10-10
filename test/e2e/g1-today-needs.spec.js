const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A model whose reply is a permission prompt: a thread or routine on it stays
// held, waiting for an answer nobody gives.
function holdWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-ask'];
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
  return w;
}

async function startRoutine(page) {
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
}

test.describe('a run that is held', () => {
  test.use({ world: holdWorld() });

  test('open a routine that is running from Running @G1.21', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startRoutine(page);
    await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });
    await page.getByRole('button', { name: /^Close Testbox sweep/ }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toHaveCount(0);
    await expect(page.getByText('Acme · routine')).toBeVisible();
    await eve.reload();
    const row = page.getByRole('button').filter({ hasText: 'Acme · routine' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Testbox sweep');
    await row.click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
  });

  test('open a failed routine from Needs you @G1.19', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startRoutine(page);
    await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });
    await page.getByRole('button', { name: /^Close Testbox sweep/ }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toHaveCount(0);
    await expect(page.getByText('Acme · routine')).toBeVisible();
    const down = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down');
    expect(down.code).toBe(0);
    await expect(page.getByText('Acme · routine')).toBeHidden();
    expect((await relay.ctl('fault', 'clear')).code).toBe(0);
    await expect(page.getByText('Reconnected to relay.')).toBeVisible();
    const row = page.getByRole('button').filter({ hasText: 'routine failed' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Testbox sweep');
    await row.click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
  });
});

test.describe('scheduler down', () => {
  test.use({ scheduler: false });

  test('Needs you says the scheduler is out of reach @G1.19.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText("Can't reach the scheduler.").first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Nothing needs you.')).toBeHidden();
  });

  test('Running says the scheduler is out of reach @G1.21.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText("Can't reach the scheduler.").first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Nothing running.')).toBeHidden();
  });
});

test('retry a Today part that failed to load @G1.38', async ({ eve, page, relay }) => {
  const added = await relay.ctl('fault', 'add', '--route', 'GET /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
  expect(added.code).toBe(0);
  await eve.open('/');
  await expect(page.getByText("Couldn't load threads.").first()).toBeVisible();
  expect((await relay.ctl('fault', 'clear')).code).toBe(0);
  await page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(page.getByText("Couldn't load threads.")).toBeHidden();
});

test('a Retry while the source is still down keeps the failure line @G1.38.r1', async ({ eve, page, relay }) => {
  const added = await relay.ctl('fault', 'add', '--route', 'GET /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
  expect(added.code).toBe(0);
  await eve.open('/');
  await expect(page.getByText("Couldn't load threads.").first()).toBeVisible();
  const since = relay.mark();
  await page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first().click();
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
  await expect(page.getByText("Couldn't load threads.").first()).toBeVisible();
});
