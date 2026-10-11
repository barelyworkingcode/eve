const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const BRIEF = {
  brief: 1,
  events: [{ time: '09:30', title: 'Standup with Acme', note: 'Room 4' }],
  reminders: [{ title: 'Renew the testbox licence', due: 'today' }],
  mail: [],
  weather: { summary: 'Clear skies', high: 21, low: 9 },
  notes: ['Bring the testbox report'],
  unavailable: [],
};

function briefWorld(text) {
  const w = worlds.base();
  w.models = [{ value: 'local-a', label: 'Local local-a', group: 'Local', provider: 'chat' }];
  w.models[0].reply = { kind: 'text', text };
  return w;
}

// The card has no Refresh before its first run: the first run is "Run Now" in
// the Routine sheet on the Routines page.
async function runBriefOnce(page, reply) {
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

const REPLY = 'Here you go.';

test.describe('a brief that reads', () => {
  test.use({ world: briefWorld(REPLY + '\n```json\n' + JSON.stringify(BRIEF) + '\n```') });

  test('Retry after a failed refresh brings back a readable brief @G6.10', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await runBriefOnce(page, REPLY);
    await expect(page.getByText(/^Brief · /)).toBeVisible();

    const fault = await relay.ctl(
      'fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error',
      '--times', '1', '--status', '500', '--body', '{"error":"boom"}',
    );
    expect(fault.code).toBe(0);
    await page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true }).click();
    const retry = page.getByRole('main').getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByText(/^failed \d\d:\d\d/)).toBeVisible();

    const since = await relay.mark();
    await retry.click();
    await relay.waitForEvent('chat.turn', { since });
    await expect(page.getByText('Refreshing…')).toBeHidden();

    await expect(page.getByText(/^Brief · /)).toBeVisible();
    await expect(page.getByText("The brief came back in a form eve can't read.")).toHaveCount(0);
    await expect(page.getByText(/^failed \d\d:\d\d/)).toBeHidden();
    await expect(retry).toBeHidden();
  });
});
