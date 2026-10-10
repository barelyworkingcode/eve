const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const TODAY = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

// A chat-provider model whose every run ends in an error, so a routine on it
// fails; the reply is held back by a fault where a spec needs a run in flight.
function failingModelWorld() {
  const w = worlds.base();
  w.models = [{ value: 'local-fail', label: 'Local fail', group: 'Local', provider: 'chat', reply: { kind: 'fail' } }];
  return w;
}

async function createRoutine(page, name) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill('Say hello from testbox.');
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('local-fail');
  await dialog.getByRole('combobox', { name: 'Schedule' }).selectOption({ label: 'On demand' });
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function runFromRoutinesPage(page, name) {
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
}

test('Needs you says so when nothing waits @G1.18', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
});

test('Running says so when nothing runs @G1.20', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByText('Nothing running.')).toBeVisible();
});

test.describe('a routine that fails', () => {
  test.use({ world: failingModelWorld() });

  test('open a failed routine from Needs you @G1.19', async ({ eve, page, relay }) => {
    await eve.open('/');
    await createRoutine(page, 'Nightly check');
    await page.getByRole('button', { name: 'Run Now Nightly check', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Nightly check/ })).toBeVisible();
    await page.getByRole('button', { name: /^Close .*Nightly check/ }).click();
    await expect(page.getByText(/ran \d\d:\d\d · ok/)).toBeVisible();
    const fault = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down', '--times', '1');
    expect(fault.code).toBe(0);
    await page.getByRole('button', { name: 'Run Now Nightly check', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: TODAY })).toBeVisible();
    const row = page.getByRole('main').getByRole('button', { name: /Nightly check/ }).first();
    await expect(row).toBeVisible();
    await expect(page.getByText(/routine failed|routine timed out/)).toBeVisible();
  });

  test('open a routine that is running from Running @G1.21', async ({ eve, page, relay }) => {
    await eve.open('/');
    await createRoutine(page, 'Nightly check');
    const hold = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'slow');
    expect(hold.code).toBe(0);
    await page.getByRole('button', { name: 'Run Now Nightly check', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(page.getByRole('tab', { name: 'Nightly check', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close Nightly check', exact: true }).click();
    await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: TODAY })).toBeVisible();
    await expect(page.getByText('Acme · routine')).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Nightly check', exact: true }).filter({ hasText: 'Acme · routine' }),
    ).toBeVisible();
    expect((await relay.ctl('fault', 'release', '--id', JSON.parse(hold.stdout).id)).code).toBe(0);
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
