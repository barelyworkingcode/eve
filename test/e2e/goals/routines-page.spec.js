// S5b-A1 the Routines page: sentences, results, the sheet and the doors.
// docs/design-routines.md. Times are read in UTC so a run's HH:MM is its record's.
const os = require('os');
const { test, expect, MODELS } = require('./fixture');
const { gotoEve } = require('../fixtures');

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const hhmm = (iso) => iso.slice(11, 16);
// The tab strip shows only the active project's tabs, so count the tabs themselves.
const routineTabs = (page) => page.evaluate(() => window.client.tabManager.tabs.filter((t) => t.type === 'routines' || t.id === 'routines').length);
const rows = (page) => page.getByTestId('routines-page').locator('.routine-row');
const task = (id, name, projectId, schedule, extra = {}) => ({
  id, name, projectId, schedule, prompt: 'p', model: 'fake-model', sessionType: 'headless', enabled: true, ...extra,
});

// A run as relayScheduler makes it: started through the scheduler's route, then finished.
async function runThroughScheduler(relay, relayPort, id, finish) {
  relay.holdTaskRuns();
  const res = await fetch(`http://127.0.0.1:${relayPort}/api/tasks/${id}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`run ${id}: ${res.status}`);
  relay.finishTask(id, finish);
  relay.holdTaskRuns(false);
}

const world = {
  projects: ({ alpha, beta }) => [
    { id: 'alpha', name: 'Alpha Project', path: alpha },
    { id: 'beta', name: 'Beta Project', path: beta },
    { id: 'hm', name: 'Home Only', path: os.tmpdir(), mode: 'home' },
  ],
  seed: async ({ relay, relayPort, folders }) => {
    relay.setModels(MODELS);
    relay.seedSession({ sessionId: 'run-ok', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Morning digest', live: false, headless: true,
      history: [{ timestamp: nowIso(), role: 'user', content: 'Digest the morning.' }] });
    // Seeded out of order: the page sorts by project, then name.
    relay.seedTask(task('b-none', 'Zeta', 'beta', undefined));
    relay.seedTask(task('a-ok', 'Morning digest', 'alpha', { type: 'daily', time: '07:00' }, { lastStatus: 'success', lastRun: nowIso(), lastSessionId: 'run-ok' }));
    relay.seedTask(task('a-paused', 'Backup check', 'alpha', { type: 'interval', minutes: 120 }, { enabled: false }));
    relay.seedTask(task('b-ask', 'Ask me', 'beta', { type: 'on_demand' }));
    relay.seedTask(task('a-never', 'Hourly ping', 'alpha', { type: 'hourly', minute: 15 }));
    relay.seedTask(task('b-cron', 'Cron daily', 'beta', { type: 'cron', expression: '30 6 * * *' }));
    relay.seedTask(task('b-custom', 'Cron odd', 'beta', { type: 'cron', expression: '*/5 * * * *' }));
    relay.seedTask(task('h-garden', 'Garden', 'hm', { type: 'daily', time: '06:00' }));
    relay.seedTask(task('a-fail', 'Inbox sweep', 'alpha', { type: 'weekly', day: 'Mon', time: '08:00' }));
    await runThroughScheduler(relay, relayPort, 'a-fail', { status: 'error', error: 'model unavailable\n  at worker.go:12' });
  },
};

async function openFromPalette(page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('Routines');
  await page.getByTestId('palette-item').filter({ hasText: 'Routines' }).first().click();
  await expect(page.getByTestId('routines-page')).toBeVisible();
}

test.describe('S5b-A1 Routines page', () => {
  test.use({ world, timezoneId: 'UTC' });

  test('⌘K, the project page link and the deep link all open the one #routines tab, which is not persisted', async ({ page, eve }) => {
    await openFromPalette(page);
    await expect(page).toHaveURL(/#routines$/);
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await page.getByTestId('project-routines-alpha').click();
    await expect(page.getByTestId('routines-page')).toBeVisible();
    await expect.poll(() => routineTabs(page)).toBe(1);

    await page.goto('about:blank');
    await gotoEve(page, eve.baseUrl);
    await expect(page.getByTestId('home-screen')).toBeVisible();
    expect(await routineTabs(page)).toBe(0);

    await page.goto('about:blank');
    await gotoEve(page, new URL('#routines', eve.baseUrl).href);
    await expect(page.getByTestId('routines-page')).toBeVisible();
    await expect.poll(() => routineTabs(page)).toBe(1);
  });

  test('in-mode routines are listed by project then name, each as sentence, name · project, result', async ({ page, eve }) => {
    await openFromPalette(page);
    const ran = eve.relay.listTasks().find((t) => t.id === 'a-ok').lastRun;
    const failed = eve.relay.listTasks().find((t) => t.id === 'a-fail').lastRun;
    const expected = [
      ['a-paused', 'Every 2 hours', 'Backup check · Alpha Project', 'paused', 'Paused'],
      ['a-never', 'Every hour at :15', 'Hourly ping · Alpha Project', 'never', 'never ran'],
      ['a-fail', 'Every Monday at 08:00', 'Inbox sweep · Alpha Project', 'failed', `failed ${hhmm(failed)} · model unavailable`],
      ['a-ok', 'Every day at 07:00', 'Morning digest · Alpha Project', 'ok', `ran ${hhmm(ran)} · ok`],
      ['b-ask', 'When I ask', 'Ask me · Beta Project', 'never', 'never ran'],
      ['b-cron', 'Every day at 06:30', 'Cron daily · Beta Project', 'never', 'never ran'],
      ['b-custom', 'Custom schedule', 'Cron odd · Beta Project', 'never', 'never ran'],
      ['b-none', 'No schedule', 'Zeta · Beta Project', 'never', 'never ran'],
    ];
    await expect(rows(page)).toHaveCount(expected.length);
    await expect(page.getByTestId('routines-count')).toHaveText(String(expected.length));
    expect(await rows(page).evaluateAll((els) => els.map((e) => e.dataset.testid))).toEqual(expected.map(([id]) => `routine-${id}`));
    for (const [id, sentence, meta, kind, result] of expected) {
      const row = page.getByTestId(`routine-${id}`);
      await expect(row.locator('.routine-row__sentence')).toHaveText(sentence);
      await expect(row).toContainText(meta);
      await expect(row.locator('.routine-row__result')).toHaveAttribute('data-kind', kind);
      await expect(row.locator('.routine-row__result')).toHaveText(result);
    }
    await expect(page.getByTestId('routine-h-garden')).toHaveCount(0);

    // The project page's section reads the same.
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await expect(page.getByTestId('project-task-a-fail')).toContainText('Every Monday at 08:00');
    await expect(page.getByTestId('project-task-a-fail')).toContainText(`failed ${hhmm(failed)} · model unavailable`);
  });

  test('a row opens its sheet with the sentence, name, project and result', async ({ page }) => {
    await openFromPalette(page);
    await page.getByTestId('routine-a-ok').click();
    const sheet = page.getByTestId('routine-sheet-a-ok');
    await expect(sheet).toBeVisible();
    for (const text of ['Every day at 07:00', 'Morning digest', 'Alpha Project', 'ran ']) await expect(sheet).toContainText(text);
  });

  const actions = [
    ['Open last run opens the last run', 'a-ok', 'routine-sheet-open-last', async (page) => {
      await expect(page.getByTestId('messages-container')).toContainText('Digest the morning.');
    }],
    ['Run Now starts a run; no Open last run without one', 'a-never', 'routine-sheet-run', async (page, eve, sheet) => {
      await expect.poll(() => eve.relay.taskHistory('a-never').length).toBe(1);
    }, async (sheet) => { await expect(sheet.getByTestId('routine-sheet-open-last')).toHaveCount(0); }],
    ['Edit opens the routine dialog on it', 'b-ask', 'routine-sheet-edit', async (page) => {
      await expect(page.getByTestId('dialog-task-dialog')).toBeVisible();
      await expect(page.getByTestId('dialog-task-dialog').locator('[name="taskName"]')).toHaveValue('Ask me');
    }],
  ];
  for (const [name, id, action, after, before] of actions) {
    test(`sheet: ${name}`, async ({ page, eve }) => {
      await openFromPalette(page);
      await page.getByTestId(`routine-${id}`).click();
      const sheet = page.getByTestId(`routine-sheet-${id}`);
      await expect(sheet).toBeVisible();
      if (before) await before(sheet);
      await sheet.getByTestId(action).click();
      await after(page, eve, sheet);
    });
  }
});

test.describe('S5b-A1 page states', () => {
  test.use({ world: { seed: ({ relay }) => relay.setModels(MODELS) } });

  test('loaded but empty: "Nothing scheduled in Work."', async ({ page }) => {
    await openFromPalette(page);
    await expect(page.getByTestId('routines-page')).toContainText('Nothing scheduled in Work.');
  });

  test('scheduler down with relay up: "Can\'t reach the scheduler." with Retry, never the empty line', async ({ page, eve }) => {
    eve.relay.schedulerDown();
    await page.reload();
    await openFromPalette(page);
    const pg = page.getByTestId('routines-page');
    await expect(pg).toContainText("Can't reach the scheduler.");
    await expect(pg).not.toContainText('Nothing scheduled');

    eve.relay.schedulerDown(false);
    eve.relay.seedTask(task('t1', 'Digest', 'alpha', { type: 'on_demand' }));
    await pg.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('routine-t1')).toBeVisible();
    await expect(pg).not.toContainText("Can't reach the scheduler.");
  });
});
