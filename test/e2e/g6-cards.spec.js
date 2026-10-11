const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;
const OUTPUT_FIELD = 'Output file (optional, shows as a card on Today)';
const NOTE_BRIEF = 'This brief uses Claude Haiku. Pick a local model for it in Edit.';

function localModels(...values) {
  const w = worlds.base();
  w.models = values.map((value) => ({ value, label: `Local ${value}`, group: 'Local', provider: 'chat' }));
  return w;
}

const BRIEF = {
  brief: 1,
  events: [{ time: '09:30', title: 'Standup with Acme', note: 'Room 4' }],
  reminders: [{ title: 'Renew the testbox licence', due: 'today' }],
  mail: [1, 2, 3].map((n) => ({
    from: `sender${n}@acme.example`,
    subject: `Question ${n}`,
    unread: true,
    mailbox: 'INBOX',
    received: '2026-10-10T06:00:00Z',
  })),
  weather: { summary: 'Clear skies', high: 21, low: 9 },
  notes: ['Bring the testbox report'],
  unavailable: [],
};

function briefWorld(text) {
  const w = localModels('local-a');
  w.models[0].reply = { kind: 'text', text };
  return w;
}

const READABLE = 'Here you go.\n```json\n' + JSON.stringify(BRIEF) + '\n```';

async function setUpBrief(page) {
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(page.getByText(/^No brief yet\. It runs /)).toBeVisible();
}

// The card has no Refresh before its first run: the first run is "Run Now" in
// the Routine sheet on the Routines page.
async function runBriefOnce(page, reply = 'Here you go.') {
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' }).fill('Routines');
  await page.getByRole('option', { name: /^Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  await page.getByRole('button', { name: /Morning brief/ }).first().click();
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  await expect(page.getByText(reply)).toBeVisible();
  await page.getByRole('button', { name: 'Close Morning brief', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^(Good|Working)/ })).toBeVisible();
}

test.describe('a brief that reads', () => {
  test.use({ world: briefWorld(READABLE) });

  test('read the Morning brief\'s last run @G6.9', async ({ eve, page }) => {
    await eve.open('/');
    await setUpBrief(page);
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();
    await expect(page.getByText('Events', { exact: true })).toBeVisible();
    await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
    await expect(page.getByText('Needs a reply (3)')).toBeVisible();
    await expect(page.getByText('Weather', { exact: true })).toBeVisible();
  });

  test('a brief that fails again keeps the failure line and Retry @G6.10.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await setUpBrief(page);
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();

    const always = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(always.code).toBe(0);
    await page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true }).click();
    const retry = page.getByRole('main').getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    const since = relay.mark();
    await retry.click();
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
    await expect(page.getByText('Refreshing…')).toBeHidden();
    await expect(retry).toBeVisible();
  });
});

test.describe('a brief eve cannot read', () => {
  test.use({ world: briefWorld('I could not find anything.') });

  test('an unreadable brief says so @G6.9.r2', async ({ eve, page }) => {
    await eve.open('/');
    await setUpBrief(page);
    await runBriefOnce(page, 'I could not find anything.');
    await expect(page.getByText("The brief came back in a form eve can't read.")).toBeVisible();
  });
});

test.describe('no brief yet', () => {
  test.use({ world: briefWorld(READABLE) });

  test('no run yet says when it runs @G6.9.r1', async ({ eve, page }) => {
    await eve.open('/');
    await setUpBrief(page);
    await expect(page.getByText(/^Brief · /)).toBeHidden();
  });
});

async function makeBriefOnClaude(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Morning brief');
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill('Prepare my morning brief.');
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('haiku');
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
}

test.describe('a brief on another model', () => {
  test.use({ world: localModels('local-a') });

  test('switch the Morning brief to a local model @G6.11', async ({ eve, page }) => {
    await eve.open('/');
    await makeBriefOnClaude(page);
    await expect(page.getByText(NOTE_BRIEF)).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toHaveValue('Morning brief');
    await dialog.getByRole('combobox', { name: 'Model' }).selectOption('local-a');
    await dialog.getByRole('button', { name: 'Update routine', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(NOTE_BRIEF)).toBeHidden();
  });

  test('a brief on a model that is not local says to pick a local one @G6.11.r1', async ({ eve, page }) => {
    await eve.open('/');
    await makeBriefOnClaude(page);
    await expect(page.getByText(NOTE_BRIEF)).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  });
});

// A shell template, so a routine can be a terminal routine.
function cardWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  w.projects[0].allowed_templates = ['shell'];
  return w;
}

async function openRoutineDialog(page) {
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Routines' });
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Routine name' }).fill('Testbox card');
  await dialog.getByText('Advanced').click();
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Terminal (shell)' });
  return dialog;
}

test.describe('a card routine', () => {
  test.use({ world: cardWorld() });

  test('name the output file that makes a routine a Today card @G6.17.r1', async ({ eve, page }) => {
    await eve.open('/');
    const dialog = await openRoutineDialog(page);
    await dialog.getByRole('textbox', { name: OUTPUT_FIELD }).fill('out.json');
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(
      page.getByText("Couldn't save the routine: Only a browser signed in with a passkey can set up a Today card."),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});

test.describe('a card routine from a passkey session', () => {
  test.use({ network: 'untrusted', world: cardWorld() });

  async function claimEve(eve, page, relay, passkey) {
    await passkey.enable();
    await eve.open('/', { preReady: 'the Sign-in screen shows before the app is ready' });
    await page.getByRole('button', { name: 'Create Passkey' }).click();
    await eve.ready();
    await relay.waitForEvent('eve.passkey.report', { match: (l) => l.status === 'ok' && l.count === 1 });
  }

  test('name the output file that makes a routine a Today card @G6.17', async ({ eve, page, relay, passkey }) => {
    await claimEve(eve, page, relay, passkey);
    const dialog = await openRoutineDialog(page);
    const field = dialog.getByRole('textbox', { name: OUTPUT_FIELD });
    await field.fill('out.json');
    await expect(field).toHaveValue('out.json');
    await expect(dialog.getByText(/can change any file it can reach/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    await expect(page.getByText('No output yet.')).toBeVisible();
    await expect(page.getByText('Testbox card', { exact: true }).first()).toBeVisible();
  });

  test('a card that never ran says there is no output yet @G6.12.r1', async ({ eve, page, relay, passkey }) => {
    await claimEve(eve, page, relay, passkey);
    const dialog = await openRoutineDialog(page);
    await dialog.getByRole('textbox', { name: OUTPUT_FIELD }).fill('out.json');
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Close Acme', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    await expect(page.getByText('No output yet.')).toBeVisible();
  });
});
