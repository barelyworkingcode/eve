const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const SETUP = 'Get a morning brief in Acme every day at 07:00.';

function localModels(...values) {
  const w = worlds.base();
  w.models = values.map((value) => ({ value, label: `Local ${value}`, group: 'Local', provider: 'chat' }));
  return w;
}

test.describe('one local model', () => {
  test.use({ world: localModels('local-a') });

  test('set up the daily Morning brief @G1.9', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText(SETUP)).toBeVisible();
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await expect(page.getByText(SETUP)).toBeHidden();
  });
});

test('no local model blocks the brief @G1.9.r2', async ({ eve, page }) => {
  await eve.open('/');
  await expect(
    page.getByText('The morning brief needs a local model. None is allowed in Acme.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeHidden();
});

test.describe('no default project', () => {
  test.use({
    world: (() => {
      const w = localModels('local-a');
      w.projects.push({ id: 'p_beta', name: 'Beta', mode: 'work', files: { 'NOTES.md': '# Beta\n' } });
      w.default_project = {};
      return w;
    })(),
  });

  test('no default project blocks the brief @G1.9.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText('Set a default Work project in Relay to get a morning brief.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeHidden();
  });
});

const BRIEF = {
  brief: 1,
  events: [{ time: '09:30', title: 'Standup with Acme', note: 'Room 4' }],
  reminders: [{ title: 'Renew the testbox licence', due: 'today' }],
  mail: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
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
  test.use({ world: briefWorld('Here you go.\n```json\n' + JSON.stringify(BRIEF) + '\n```') });

  test('read the brief sections @G1.11', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();
    await expect(page.getByText('Events', { exact: true })).toBeVisible();
    await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
    await expect(page.getByText('Needs a reply (7)')).toBeVisible();
    await expect(page.getByText('Weather', { exact: true })).toBeVisible();
    await expect(page.getByText('Notes', { exact: true })).toBeVisible();
    await expect(page.getByText('+2 more')).toBeVisible();
  });
});

test.describe('a brief that reads, run twice', () => {
  test.use({ world: briefWorld('Here you go.\n```json\n' + JSON.stringify(BRIEF) + '\n```') });

  test('refresh the Morning brief @G1.12', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();

    const hold = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'slow');
    expect(hold.code).toBe(0);
    await page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(page.getByText('Refreshing…')).toBeVisible();
    const id = JSON.parse(hold.stdout).id;
    expect((await relay.ctl('fault', 'release', '--id', id)).code).toBe(0);
    await expect(page.getByText('Refreshing…')).toBeHidden();
    await expect(page.getByText(/^Brief · /)).toBeVisible();
  });

  test('a failed refresh keeps the last brief and offers Retry @G1.12.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();

    const fault = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
    expect(fault.code).toBe(0);
    await page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByText(/^Brief · /)).toBeVisible();
    await expect(page.getByText('Needs a reply (7)')).toBeVisible();
  });

  test('listen to the brief and stop it @G1.15', async ({ eve, page, voice }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();

    await voice.tts.reply({ seconds: 1 });
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await voice.tts.waitForRequest((r) => typeof r.text === 'string' && r.text.includes('Renew the testbox licence'));
    const texts = voice.tts.requests.map((r) => r.text || '');
    const events = texts.findIndex((t) => t.includes('Standup with Acme'));
    const reminders = texts.findIndex((t) => t.includes('Renew the testbox licence'));
    expect(events).toBeGreaterThanOrEqual(0);
    expect(events).toBeLessThanOrEqual(reminders);
  });

  test('stop the brief while it is read @G1.16', async ({ eve, page, voice }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page);
    await expect(page.getByText(/^Brief · /)).toBeVisible();

    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await voice.tts.waitForRequest((r) => typeof r.text === 'string' && r.text.includes('Standup with Acme'));
    await page.getByRole('main').getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Listen', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
  });
});

test.describe('a brief eve cannot read', () => {
  test.use({ world: briefWorld('I could not find anything.') });

  async function runUnreadable(page) {
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page, 'I could not find anything.');
  }

  test('an unreadable brief says so and offers Open @G1.11.r1', async ({ eve, page }) => {
    await eve.open('/');
    await runUnreadable(page);
    await expect(page.getByText("The brief came back in a form eve can't read.")).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  });

  test('open the last Morning brief run @G1.14', async ({ eve, page }) => {
    await eve.open('/');
    await runUnreadable(page);
    await expect(page.getByText("The brief came back in a form eve can't read.")).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Morning brief' })).toBeVisible();
    await expect(page.getByText('I could not find anything.')).toBeVisible();
  });

  test('no Listen for an unreadable brief @G1.15.r1', async ({ eve, page }) => {
    await eve.open('/');
    await runUnreadable(page);
    await expect(page.getByText("The brief came back in a form eve can't read.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Listen', exact: true })).toBeHidden();
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

test('a brief on another model says to pick a local one @G1.11.r2', async ({ eve, page }) => {
  await eve.open('/');
  await makeBriefOnClaude(page);
  await expect(page.getByText('This brief uses Claude Haiku. Pick a local model for it in Edit.')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true })).toBeHidden();
});

test('edit a brief that uses a model that is not local @G1.17', async ({ eve, page }) => {
  await eve.open('/');
  await makeBriefOnClaude(page);
  await expect(page.getByText('This brief uses Claude Haiku. Pick a local model for it in Edit.')).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Routines' })).toBeVisible();
  await expect(page.getByText('This brief uses Claude Haiku. Pick a local model for it in Edit.')).toBeVisible();
});

test.describe('two local models', () => {
  test.use({ world: localModels('local-a', 'local-b') });

  test('pick the model for the Morning brief @G1.10', async ({ eve, page }) => {
    await eve.open('/');
    const model = page.getByRole('combobox', { name: 'Brief model' });
    await expect(model.getByRole('option', { name: 'Local local-a' })).toBeAttached();
    await expect(model.getByRole('option', { name: 'Local local-b' })).toBeAttached();
    await model.selectOption({ label: 'Local local-b' });
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
  });
});
