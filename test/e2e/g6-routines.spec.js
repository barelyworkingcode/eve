const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

function modelWorld(extra = (w) => w) {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-model'];
  w.models = [{ value: 'acme-model', label: 'Acme Model', group: 'Claude', provider: 'claude', reply: { kind: 'echo' } }];
  return extra(w);
}

// A model whose reply is a permission prompt: a run on it stays held, waiting for
// an answer nobody gives.
function holdWorld() {
  const w = modelWorld();
  w.models[0].reply = { kind: 'permission', tool: 'Bash' };
  return w;
}

// Makes a routine from the Project page. Leaves the Project page open.
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

async function openProjectPage(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
}

async function closeProjectPage(page) {
  await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
}

async function expectToday(page) {
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
}

// Runs a routine from its Project page row; the run opens as a tab, which this closes.
async function runAndCloseTab(page, name) {
  await page.getByRole('button', { name: `Run Now ${name}`, exact: true }).click();
  const close = page.getByRole('button', { name: new RegExp(`^Close ${name}`) });
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toBeHidden();
}

// A run whose session cannot start: relay refuses the launch once.
async function runThatFails(page, relay, name) {
  const added = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error', '--times', '1', '--status', '500', '--body', '{"error":"boom"}');
  expect(added.code).toBe(0);
  const since = relay.mark();
  await page.getByRole('button', { name: `Run Now ${name}`, exact: true }).click();
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
}

async function openRoutinesPage(page) {
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
}

async function openSheet(page, name) {
  await openRoutinesPage(page);
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'Run Now', exact: true })).toBeVisible();
  return sheet;
}

test.describe('Needs you', () => {
  test.use({ world: modelWorld() });

  test('see a failed routine in Needs you @G6.1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runThatFails(page, relay, 'Testbox sweep');
    await closeProjectPage(page);
    await expectToday(page);
    const row = page.getByRole('button').filter({ hasText: 'routine failed' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Testbox sweep');
  });

  test('nothing failed says so @G6.1.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expectToday(page);
    await expect(page.getByText('Nothing needs you.')).toBeVisible();
    await expect(page.getByText('routine failed')).toBeHidden();
  });

  test('a failed run that left no thread opens nothing @G6.2.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runThatFails(page, relay, 'Testbox sweep');
    await closeProjectPage(page);
    await expectToday(page);
    const row = page.getByRole('button').filter({ hasText: 'routine failed' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toHaveCount(0);
  });
});

test.describe('a run that is held', () => {
  test.use({ world: holdWorld() });

  test('open the thread of a failed routine from Needs you @G6.2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await page.getByRole('button', { name: 'Run Now Testbox sweep', exact: true }).click();
    await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });
    await page.getByRole('button', { name: /^Close Testbox sweep/ }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toHaveCount(0);
    await closeProjectPage(page);
    // The held run never ends; dropping relay's socket marks it failed.
    const down = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down');
    expect(down.code).toBe(0);
    await expect(page.getByText('Acme · routine')).toBeHidden();
    expect((await relay.ctl('fault', 'clear')).code).toBe(0);
    await expect(page.getByText('Reconnected to relay.')).toBeVisible();
    const row = page.getByRole('button').filter({ hasText: 'routine failed' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
  });
});

test.describe('finished routines on Today', () => {
  test.use({ world: modelWorld() });

  test('see which routines finished in the last 24 hours @G6.3', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runAndCloseTab(page, 'Testbox sweep');
    await closeProjectPage(page);
    await expectToday(page);
    const row = page.getByRole('button').filter({ hasText: 'Testbox sweep' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('AC');
    await expect(row).toContainText(/\d\d:\d\d · ok/);
    await expect(page.getByText('1 new')).toBeVisible();
  });

  test('no routine finished hides the section @G6.3.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expectToday(page);
    await expect(page.getByText('Nothing needs you.')).toBeVisible();
    await expect(page.getByText('Routines', { exact: true })).toBeHidden();
  });

  test('open a finished routine run from Today @G6.4', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runAndCloseTab(page, 'Testbox sweep');
    await closeProjectPage(page);
    await expectToday(page);
    await expect(page.getByText('1 new')).toBeVisible();
    await page.getByRole('button').filter({ hasText: /\d\d:\d\d · ok/ }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await page.getByRole('button', { name: /^Close Testbox sweep/ }).click();
    await expectToday(page);
    await expect(page.getByRole('button').filter({ hasText: /\d\d:\d\d · ok/ })).toBeVisible();
    await expect(page.getByText('1 new')).toBeHidden();
  });

  test('a failed routine reads failed with its reason @G6.4.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runThatFails(page, relay, 'Testbox sweep');
    await closeProjectPage(page);
    await expectToday(page);
    const row = page.getByRole('button').filter({ hasText: /\d\d:\d\d · failed · \S/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Testbox sweep');
  });

  test('count the older routines past ten @G6.5', async ({ eve, page }) => {
    const names = Array.from({ length: 11 }, (_, i) => `Testbox sweep ${String(i + 1).padStart(2, '0')}`);
    await eve.open('/');
    await openProjectPage(page);
    for (const name of names) await addRoutine(page, name);
    for (const name of names) await runAndCloseTab(page, name);
    await closeProjectPage(page);
    await expectToday(page);
    await expect(page.getByText('+1 more')).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: /\d\d:\d\d · ok/ })).toHaveCount(10);
  });
});

test.describe('open the last run', () => {
  test.use({ world: modelWorld() });

  test('open a routine\'s last run from the Project page @G6.6', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runAndCloseTab(page, 'Testbox sweep');
    await expect(page.getByText(/ran .* · ok/)).toBeVisible();
    await page.getByRole('button', { name: 'Testbox sweep', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
  });

  test('a routine that never ran opens nothing from the Project page @G6.6.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await expect(page.getByText('never ran')).toBeVisible();
    const row = page.getByRole('button', { name: 'Testbox sweep', exact: true });
    await expect(row).toBeDisabled();
    await row.click({ force: true });
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toHaveCount(0);
  });

  test('open a routine\'s last run from its sheet @G6.7', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await runAndCloseTab(page, 'Testbox sweep');
    await closeProjectPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await sheet.getByRole('button', { name: 'Open last run', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Testbox sweep/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open last run', exact: true })).toBeHidden();
  });

  test('a routine that never ran has no Open last run @G6.7.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await closeProjectPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Open last run', exact: true })).toBeHidden();
  });
});

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  w.projects[0].allowed_templates = ['shell'];
  return w;
}

// A terminal routine, run once and ended by typing exit in its Terminal. Leaves the
// Project page open with the routine's row.
async function ranTerminalRoutine(page, relay) {
  await openProjectPage(page);
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox shell');
  await dialog.getByText('Advanced').click();
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Run Now Testbox shell', exact: true }).click();
  const term = page.getByRole('textbox', { name: 'Terminal input' });
  await expect(term).toBeAttached();
  await term.pressSequentially('exit');
  await term.press('Enter');
  await expect.poll(async () => (await relay.json('ctl', 'state', '--json')).terminals.map((t) => t.state)).toEqual(['stopped']);
  await page.getByRole('button', { name: 'Close Testbox shell', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close Testbox shell', exact: true })).toBeHidden();
}

test.describe('a terminal routine', () => {
  test.use({ world: shellWorld() });

  test('open a terminal routine\'s last run from the Project page @G6.6', async ({ eve, page, relay }) => {
    await eve.open('/');
    await ranTerminalRoutine(page, relay);
    await page.getByRole('button', { name: 'Testbox shell', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Testbox shell' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
  });

  test('a past terminal run whose log is missing says so @G6.6.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await ranTerminalRoutine(page, relay);
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/terminals/{id}/log', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    await page.getByRole('button', { name: 'Testbox shell', exact: true }).click();
    await expect(page.getByText(/\[Failed to load log: /)).toBeVisible();
  });
});

const CALLS = [
  { id: 'a1', ts: '2026-10-10T06:00:00Z', event: 'call_tool', tool: 'mail_list_accounts', outcome: 'ok' },
  { id: 'a2', ts: '2026-10-10T06:05:00Z', event: 'call_tool', tool: 'contacts_list', outcome: 'denied' },
].map((r) => ({ ...r, actor: { kind: 'session', auth: 'token', project_id: 'p_acme' }, scope: 'read' }));

function auditWorld() {
  const w = modelWorld();
  w.audit = CALLS;
  return w;
}

test.describe('tool calls in the sheet', () => {
  test.use({ world: auditWorld() });

  test('see what a routine\'s project did through Relay @G6.18', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await closeProjectPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByText("Tool calls Acme made through Relay. A model's built-in tools aren't listed.")).toBeVisible();
    await expect(sheet.getByText('mail_list_accounts')).toBeVisible();
    await expect(sheet.getByText('contacts_list')).toBeVisible();
    await expect(sheet.getByText('allowed', { exact: false }).first()).toBeVisible();
    await expect(sheet.getByText('denied', { exact: false }).first()).toBeVisible();
    const audit = await relay.cli('audit', '--json', '--project', 'p_acme', '--event', 'call_tool');
    expect(audit.code).toBe(0);
    const tools = audit.stdout.trim().split('\n').map((l) => JSON.parse(l).tool).sort();
    expect(tools).toEqual(['contacts_list', 'mail_list_accounts']);
  });

  test('a failed load offers Retry @G6.18.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await closeProjectPage(page);
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/audit', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByText("Couldn't load tool calls.")).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  });

  test('audit off says Relay is not recording @G6.18.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await closeProjectPage(page);
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/audit/log', '--mode', 'error', '--status', '400', '--body', '{"error":"auditing is disabled"}');
    expect(added.code).toBe(0);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByText("Relay isn't recording tool calls.")).toBeVisible();
  });

  test('retry loading the tool calls @G6.19', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await closeProjectPage(page);
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/audit', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(added.code).toBe(0);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByText("Couldn't load tool calls.")).toBeVisible();
    expect((await relay.ctl('fault', 'clear')).code).toBe(0);
    await sheet.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(sheet.getByText('mail_list_accounts')).toBeVisible();
    await expect(sheet.getByText("Couldn't load tool calls.")).toBeHidden();
  });
});

test.describe('no tool calls', () => {
  test.use({ world: modelWorld() });

  test('a project with no tool calls says so @G6.18.r3', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await addRoutine(page, 'Testbox sweep');
    await closeProjectPage(page);
    const sheet = await openSheet(page, 'Testbox sweep');
    await expect(sheet.getByText('No tool calls through Relay for Acme yet.')).toBeVisible();
  });
});
