// S5b-A3 routine results on Today. docs/design-routines.md
// Times are read in UTC so a row's HH:MM is its record's.
const os = require('os');
const { test, expect, MODELS } = require('./fixture');
const { reloadEve } = require('../fixtures');
const { part, backToToday } = require('./today-helpers');

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
const hhmm = (s) => s.slice(11, 16);
const rows = (page) => part(page, 'routines').locator('[data-testid^="today-routine-"]');
const runTabs = (page) => page.locator('[data-testid^="tab-sess-"]');
const task = (id, name, projectId, extra = {}) => ({
  id, name, projectId, prompt: `${name} prompt`, model: 'fake-model', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless', ...extra,
});

async function runThroughScheduler(relay, relayPort, id, finish) {
  relay.holdTaskRuns();
  const res = await fetch(`http://127.0.0.1:${relayPort}/api/tasks/${id}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`run ${id}: ${res.status}`);
  relay.finishTask(id, finish);
  relay.holdTaskRuns(false);
}

const projects = ({ alpha, beta }) => [
  { id: 'alpha', name: 'Alpha Project', path: alpha },
  { id: 'beta', name: 'Beta Project', path: beta },
  { id: 'hm', name: 'Home Only', path: os.tmpdir(), mode: 'home' },
];

test.describe('S5b-A3 two runs in the last day, one older', () => {
  test.use({
    timezoneId: 'UTC',
    world: {
      projects,
      seed: async ({ relay, relayPort }) => {
        relay.setModels(MODELS);
        relay.seedTask(task('r-old', 'Weekly report', 'alpha', { lastStatus: 'success', lastRun: iso(30) }));
        relay.seedTask(task('r-home', 'Garden', 'hm'));
        relay.seedTask(task('r1', 'Inbox digest', 'alpha'));
        relay.seedTask(task('r2', 'Backup check', 'alpha'));
        await runThroughScheduler(relay, relayPort, 'r-home', { status: 'success', response: 'Watered.' });
        await runThroughScheduler(relay, relayPort, 'r1', { status: 'success', response: '\n\nInbox is clear.\nTwo drafts wait.' });
        await new Promise((r) => setTimeout(r, 1100)); // the scheduler's times are whole seconds
        await runThroughScheduler(relay, relayPort, 'r2', { status: 'error', error: 'disk full\n  at backup.go:3' });
      },
    },
  });

  test('lists the in-mode runs newest first with their line, "2 new", and opens nothing by itself', async ({ page, eve }) => {
    const lastRun = (id) => eve.relay.listTasks().find((t) => t.id === id).lastRun;
    await expect(rows(page)).toHaveCount(2);
    expect(await rows(page).evaluateAll((els) => els.map((e) => e.dataset.testid))).toEqual(['today-routine-r2', 'today-routine-r1']);
    await expect(page.getByTestId('today-routine-r1')).toContainText('Inbox digest');
    await expect(page.getByTestId('today-routine-r1')).toContainText(`${hhmm(lastRun('r1'))} · ok · Inbox is clear.`);
    await expect(page.getByTestId('today-routine-r2')).toContainText('Backup check');
    await expect(page.getByTestId('today-routine-r2')).toContainText(`${hhmm(lastRun('r2'))} · failed · disk full`);
    await expect(page.getByTestId('today-routines-unseen')).toHaveText('2 new');
    await expect(runTabs(page)).toHaveCount(0);

    await reloadEve(page);
    await expect(page.getByTestId('today-routines-unseen')).toHaveText('2 new');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(runTabs(page)).toHaveCount(0);
  });

  test('a tap opens the run and marks it seen on this device: "1 new", across a reload', async ({ page }) => {
    await page.getByTestId('today-routine-r1').click();
    await expect(page.getByTestId('messages-container')).toContainText('Inbox is clear.');
    await backToToday(page);
    await expect(page.getByTestId('today-routines-unseen')).toHaveText('1 new');
    await reloadEve(page);
    await expect(page.getByTestId('today-routines-unseen')).toHaveText('1 new');
  });
});

test.describe('S5b-A3 nothing ran in the last day', () => {
  test.use({
    world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.seedTask(task('r-old', 'Weekly report', 'alpha', { lastStatus: 'success', lastRun: iso(30) })); } },
  });

  test('the part is hidden', async ({ page }) => {
    await expect(part(page, 'needs-you')).toHaveAttribute('data-state', 'ready');
    await expect(part(page, 'routines')).toBeHidden();
  });
});

test.describe('S5b-A3 more than ten', () => {
  test.use({
    world: {
      seed: ({ relay }) => {
        relay.setModels(MODELS);
        for (let i = 0; i < 11; i++) relay.seedTask(task(`m${i}`, `Routine ${i}`, 'alpha', { lastStatus: 'success', lastRun: iso(1 + i / 10) }));
      },
    },
  });

  test('ten rows, then "+1 more"', async ({ page }) => {
    await expect(rows(page)).toHaveCount(10);
    await expect(part(page, 'routines')).toContainText('+1 more');
    await expect(page.getByTestId('today-routine-m10')).toHaveCount(0); // the oldest is the one left out
  });
});

test.describe('S5b-A3 scheduler down', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.schedulerDown(); } } });

  test('the part shows "Can\'t reach the scheduler." with Retry, never an empty message', async ({ page, eve }) => {
    await expect(page.getByTestId('today-error-routines')).toContainText("Can't reach the scheduler.");
    await expect(page.getByTestId('today-retry-routines')).toBeVisible();

    eve.relay.schedulerDown(false);
    await page.getByTestId('today-retry-routines').click();
    await expect(page.getByTestId('today-error-routines')).toHaveCount(0);
  });
});
