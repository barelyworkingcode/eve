// S5b-A4 What did it touch: the routine sheet's Relay tool calls. docs/design-routines.md
// Times are read in UTC so a row's HH:MM is its event's.
const { test, expect, MODELS } = require('./fixture');
const { gotoEve } = require('../fixtures');

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const SECRET = 'acme-secret';
// As relay's recorder stores them (audit.go), oldest first.
const event = (minutesAgo, tool, outcome, projectId = 'alpha') => ({
  id: `e-${tool}`, ts: iso(minutesAgo), event: 'call_tool', tool, outcome,
  actor: { kind: 'session', project_id: projectId, token: `${SECRET}-actor` },
  args: { to: `${SECRET}-arg` }, error: `${SECRET}-error`,
});
const EVENTS = [event(20, 'mail_list_accounts', 'ok'), event(10, 'contacts_list', 'denied')];
const isAuditCall = (r) => new URL(r.url()).pathname === '/api/projects/alpha/audit';

const world = {
  seed: ({ relay }) => {
    relay.setModels(MODELS);
    relay.seedTask({
      id: 't1', name: 'Inbox digest', projectId: 'alpha', prompt: 'p', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
    relay.seedAudit(EVENTS);
  },
};

async function openSheet(page, eve) {
  await page.goto('about:blank');
  await gotoEve(page, new URL('#routines', eve.baseUrl).href);
  await page.getByTestId('routine-t1').click();
  return page.getByTestId('routine-sheet-audit');
}

test.describe('S5b-A4 the sheet\'s tool calls', () => {
  test.use({ world, timezoneId: 'UTC' });

  test('rows read time · tool · allowed|denied, newest first, under the caption; no args reach the browser', async ({ page, eve }) => {
    const bodies = [];
    page.on('response', async (r) => { if (isAuditCall(r)) bodies.push(await r.text()); });
    const audit = await openSheet(page, eve);
    const rows = audit.getByTestId('routine-audit-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveText(new RegExp(`${EVENTS[1].ts.slice(11, 16)}.* · contacts_list · denied$`));
    await expect(rows.nth(1)).toHaveText(new RegExp(`${EVENTS[0].ts.slice(11, 16)}.* · mail_list_accounts · allowed$`));
    await expect(audit).toContainText("Tool calls Alpha Project made through Relay. A model's built-in tools aren't listed.");

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(bodies[0]).records[0])).not.toContain('args');
    expect(await page.content()).not.toContain(SECRET);
  });

  test('it loads once per opening and is never polled', async ({ page, eve }) => {
    await page.clock.install();
    let calls = 0;
    page.on('request', (r) => { if (isAuditCall(r)) calls += 1; });
    const audit = await openSheet(page, eve);
    await expect(audit.getByTestId('routine-audit-row')).toHaveCount(2);
    await page.clock.runFor(10 * 60 * 1000);
    expect(calls).toBe(1);

    await page.getByTestId('routine-sheet-close').click();
    await page.getByTestId('routine-t1').click();
    await expect(page.getByTestId('routine-sheet-audit').getByTestId('routine-audit-row')).toHaveCount(2);
    expect(calls).toBe(2);
  });

  test('auditing off: "Relay isn\'t recording tool calls."', async ({ page, eve }) => {
    eve.relay.setAuditEnabled(false);
    const audit = await openSheet(page, eve);
    await expect(audit).toContainText("Relay isn't recording tool calls.");
    await expect(audit.getByTestId('routine-audit-row')).toHaveCount(0);
  });

  test('no rows: "No tool calls through Relay for Alpha Project yet."', async ({ page, eve }) => {
    eve.relay.seedAudit([event(5, 'mail_list_accounts', 'ok', 'beta')]);
    const audit = await openSheet(page, eve);
    await expect(audit).toContainText('No tool calls through Relay for Alpha Project yet.');
  });

  test('a failure shows "Couldn\'t load tool calls." with Retry, which loads them', async ({ page, eve }) => {
    eve.relay.failRoute('GET', '/api/audit', 500, { error: 'boom' });
    const audit = await openSheet(page, eve);
    await expect(audit).toContainText("Couldn't load tool calls.");
    eve.relay.clearRouteFaults();
    await audit.getByRole('button', { name: 'Retry' }).click();
    await expect(audit.getByTestId('routine-audit-row')).toHaveCount(2);
  });
});
