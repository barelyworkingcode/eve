// Custom Today cards (eve#117 C1-C9): a terminal routine with an output file is
// a card on Today. Runs are driven at the fake scheduler; times are read in UTC
// so "Ran HH:MM" is the run record's own time.
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');
const { nav, part, runThroughScheduler } = require('./today-helpers');

const PROJECTS = ({ alpha, beta }) => [
  { id: 'wk', name: 'Work Only', path: alpha, mode: 'work' },
  { id: 'hm', name: 'Home Only', path: beta, mode: 'home' },
];
const card = (id, name, projectId = 'wk') => ({
  id, name, projectId, sessionType: 'pty', templateId: 'shell', extraArgs: ['-c', './today.sh'], outputFile: 'today.json',
  schedule: { type: 'on_demand' }, enabled: true,
});
const list = (...items) => JSON.stringify({ renderer: 'list', items: items.map((i) => (typeof i === 'string' ? { title: i } : i)) });
// As relayScheduler#10 records a run: the file's text in output, the terminal tail in response.
const wrote = (output) => ({ status: 'success', exitCode: 0, response: 'noise\r\n', output });
const EXITED_3 = { status: 'error', exitCode: 3, error: 'process exited with code 3' };

// world({ cw: ['Inbox today', [wrote(...)]] }): seeded cards and the runs each made, oldest first.
const world = (cards) => ({
  projects: PROJECTS,
  seed: async ({ relay, relayPort }) => {
    for (const [id, [name, runs = [], projectId]] of Object.entries(cards)) {
      relay.seedTask(card(id, name, projectId));
      for (const finish of runs) await runThroughScheduler(relay, relayPort, id, finish);
    }
  },
});

const urlPath = (r) => new URL(r.url()).pathname;
const isRun = (r) => r.method() === 'POST' && /^\/api\/tasks\/[^/]+\/run$/.test(urlPath(r));
function track(page, pred) {
  const seen = [];
  page.on('request', (r) => { if (pred(r)) seen.push(r); });
  return seen;
}
const lastRun = (eve, id) => eve.relay.listTasks().find((t) => t.id === id).lastRun;
const hhmm = (iso) => iso.slice(11, 16);
const items = (page, id) => part(page, `custom-${id}`).getByTestId('today-custom-item');
// data-stale on the card's root: the host's section or the card's own root inside it.
const isStale = (loc) => loc.evaluate((el) => el.dataset.stale === 'true' || !!el.querySelector('[data-stale="true"]'));
// The history cache key is (id, lastRun) at whole seconds: finish a run in a later second than the seeded one.
async function laterSecond(eve, id) {
  const at = Date.parse(lastRun(eve, id));
  await expect.poll(() => Date.now() >= at + 1000).toBe(true);
}

test.describe('C1/C7 a card in its project\'s mode', () => {
  const many = Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`);
  test.use({ timezoneId: 'UTC', world: world({ cw: ['Inbox today', [wrote(list(...many))]], ch: ['Garden', [wrote(list('Water the beans'))], 'hm'] }) });

  test('Work shows its card right after the brief, named, "Ran <time>", 10 rows and "+2 more"; Home shows only its own', async ({ page, eve }) => {
    const cw = part(page, 'custom-cw');
    await expect(cw.getByTestId('today-custom-body')).toHaveAttribute('data-renderer', 'list');
    await expect(cw).toContainText('Inbox today');
    await expect(cw.getByTestId('today-custom-when')).toHaveText(`Ran ${hhmm(lastRun(eve, 'cw'))}`);
    await expect(items(page, 'cw')).toHaveCount(10);
    await expect(items(page, 'cw').first()).toContainText('Item 1');
    await expect(cw).toContainText('+2 more');
    await expect(cw.getByTestId('today-custom-refresh')).toBeVisible();
    const order = await page.locator('[data-testid^="today-part-"]').evaluateAll((els) => els.map((e) => e.dataset.testid));
    expect(order).toContain('today-part-brief');
    expect(order[order.indexOf('today-part-brief') + 1]).toBe('today-part-custom-cw');
    await expect(part(page, 'custom-ch')).toHaveCount(0);
    // The Routines part leaves a card routine to its card.
    await expect(page.getByTestId('today-routine-cw')).toHaveCount(0);

    await page.getByTestId('mode-home').click();
    await expect(items(page, 'ch')).toHaveText(['Water the beans']);
    await expect(cw).toHaveCount(0);
  });
});

test.describe('C1 table and metrics', () => {
  const table = JSON.stringify({ renderer: 'table', columns: ['Name', 'Open', 'Due'], rows: [['p1', 3, true], ['p2', null]] });
  const metrics = JSON.stringify({ renderer: 'metrics', metrics: [{ label: 'Unread', value: 7, detail: 'INBOX' }] });
  test.use({ world: world({ ct: ['Projects', [wrote(table)]], cm: ['Mail', [wrote(metrics)]] }) });

  test('each renders its own shape', async ({ page }) => {
    const tbody = part(page, 'custom-ct').getByTestId('today-custom-body');
    await expect(tbody).toHaveAttribute('data-renderer', 'table');
    for (const text of ['Name', 'Open', 'Due', 'p1', '3', 'true', 'p2']) await expect(tbody).toContainText(text);
    const mbody = part(page, 'custom-cm').getByTestId('today-custom-body');
    await expect(mbody).toHaveAttribute('data-renderer', 'metrics');
    for (const text of ['Unread', '7', 'INBOX']) await expect(mbody).toContainText(text);
  });
});

test.describe('C6 opening Today runs nothing', () => {
  test.use({ world: world({ cn: ['Never ran'], cw: ['Inbox today', [wrote(list('Old news'))]] }) });

  test('a never-run card says "No output yet." with Refresh; mount, reload and mode switches make no run and no session', async ({ page, eve }) => {
    const before = eve.relay.requests.length;
    const never = part(page, 'custom-cn');
    await expect(never.getByTestId('today-custom-never')).toContainText('No output yet.');
    await expect(never.getByTestId('today-custom-refresh')).toBeVisible();
    await expect(items(page, 'cw')).toHaveText(['Old news']);
    await reloadEve(page);
    await expect(items(page, 'cw')).toHaveText(['Old news']);
    await page.getByTestId('mode-home').click();
    await page.getByTestId('mode-work').click();
    await expect(never.getByTestId('today-custom-never')).toBeVisible();
    await page.waitForTimeout(1000);
    const calls = eve.relay.requests.slice(before).filter((r) => r.method === 'POST' && (/\/run$/.test(r.path) || r.path === '/api/sessions'));
    expect(calls).toEqual([]);
  });
});

test.describe('C2 a run updates the card in place', () => {
  test.use({ world: world({ cw: ['Inbox today', [wrote(list('Old news'))]] }) });

  test('Refresh runs it once: "Running…" over the old output, then the new output, with no reload', async ({ page, eve }) => {
    await expect(items(page, 'cw')).toHaveText(['Old news']);
    let loads = 0;
    page.on('load', () => { loads += 1; });
    const runs = track(page, isRun);
    eve.relay.holdTaskRuns();
    const cw = part(page, 'custom-cw');
    await cw.getByTestId('today-custom-refresh').click();
    await expect(cw.getByTestId('today-custom-running')).toHaveText('Running…');
    await expect(items(page, 'cw')).toHaveText(['Old news']);
    await expect(cw.getByTestId('today-custom-refresh')).toHaveCount(0);
    expect(runs).toHaveLength(1);
    await laterSecond(eve, 'cw');
    eve.relay.finishTask('cw', wrote(list('Fresh news')));
    await expect(items(page, 'cw')).toHaveText(['Fresh news']);
    await expect(cw.getByTestId('today-custom-running')).toHaveCount(0);
    expect(loads).toBe(0);
  });

  test('a run started through eve\'s REST route, not the page, updates the card the same way', async ({ page, eve }) => {
    await expect(items(page, 'cw')).toHaveText(['Old news']);
    eve.relay.holdTaskRuns();
    const res = await fetch(`${eve.baseUrl}/api/tasks/cw/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    await expect(part(page, 'custom-cw').getByTestId('today-custom-running')).toBeVisible();
    await laterSecond(eve, 'cw');
    eve.relay.finishTask('cw', wrote(list('From elsewhere')));
    await expect(items(page, 'cw')).toHaveText(['From elsewhere']);
  });
});

test.describe('C3 a failed run', () => {
  test.use({ timezoneId: 'UTC', world: world({ cw: ['Inbox today', [wrote(list('Kept item')), EXITED_3]] }) });

  test('keeps the last good output, marked stale, with the reason and Retry; Needs you lists it', async ({ page, eve }) => {
    const cw = part(page, 'custom-cw');
    await expect(cw.getByTestId('today-custom-failed')).toContainText(`failed ${hhmm(lastRun(eve, 'cw'))} · exited 3`);
    await expect(items(page, 'cw')).toHaveText(['Kept item']);
    await expect(cw.getByTestId('today-custom-stale')).toHaveText('Stale');
    expect(await isStale(cw)).toBe(true);
    await expect(page.getByTestId('today-needs-row-cw')).toBeVisible();
    await expect(page.getByTestId('today-routine-cw')).toHaveCount(0);

    const runs = track(page, isRun);
    eve.relay.holdTaskRuns();
    await cw.getByTestId('today-custom-retry').click();
    await expect(cw.getByTestId('today-custom-running')).toBeVisible();
    expect(runs).toHaveLength(1);
  });
});

test.describe('C4 output not understood', () => {
  const RAW = `not json ${'x'.repeat(5000)}`;
  test.use({
    world: world({
      cb: ['Bad json', [wrote(RAW)]],
      cu: ['Unknown', [wrote(JSON.stringify({ renderer: 'chart', points: [1, 2] }))]],
      cg: ['Healthy', [wrote(list('Fine'))]],
    }),
  });

  test('says so with the raw text behind a disclosure; Ask and a healthy card are untouched', async ({ page }) => {
    const cb = part(page, 'custom-cb');
    await expect(cb.getByTestId('today-custom-not-understood')).toContainText('Output not understood (bad-json).');
    const raw = cb.locator('details').getByTestId('today-custom-raw');
    const text = await raw.textContent();
    expect(text.startsWith('not json xxx')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4001);
    const cu = part(page, 'custom-cu');
    await expect(cu.getByTestId('today-custom-not-understood')).toContainText('Output not understood (unknown-renderer).');
    await expect(cu.locator('details').getByTestId('today-custom-raw')).toContainText('"chart"');
    await expect(items(page, 'cg')).toHaveText(['Fine']);
    await expect(part(page, 'custom-cg')).toHaveAttribute('data-state', 'ready');
    await expect(part(page, 'ask')).toHaveAttribute('data-state', 'ready');
  });
});

test.describe('C5 untrusted output', () => {
  const hostile = list(
    { title: '<b>bold</b>', url: 'javascript:alert(1)' },
    { title: '<img src=x onerror=alert(1)>', detail: '<script>alert(2)</script>' },
    { title: 'Docs', url: 'https://acme.test/docs' },
  );
  test.use({ world: world({ cx: ['Hostile', [wrote(hostile)]] }) });

  test('markup is literal text, a javascript: link is plain text, and only the https: item is a link', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    const cx = part(page, 'custom-cx');
    await expect(items(page, 'cx')).toHaveCount(3);
    await expect(items(page, 'cx').nth(0)).toContainText('<b>bold</b>');
    await expect(items(page, 'cx').nth(1)).toContainText('<img src=x onerror=alert(1)>');
    await expect(items(page, 'cx').nth(1)).toContainText('<script>alert(2)</script>');
    await expect(cx.locator('b, img, script, iframe')).toHaveCount(0);
    await expect(cx.locator('a[href^="javascript:" i]')).toHaveCount(0);
    await expect(cx.locator('a')).toHaveCount(1);
    const link = items(page, 'cx').nth(2).locator('a');
    await expect(link).toHaveAttribute('href', 'https://acme.test/docs');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(dialogs).toEqual([]);
  });
});

test.describe('C8/C9 the Output file field', () => {
  test.use({ world: world({ cw: ['Inbox today'] }) });

  test('shows with its warning for a terminal routine; saving it from the bypass gets the 403 toast and reaches nothing', async ({ page, eve }) => {
    await nav(page).getByTitle('Work Only', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await page.getByTestId('project-task-cw').getByTitle('Edit').click();
    const dialog = page.getByTestId('dialog-task-dialog');
    await expect(dialog.getByTestId('task-dialog-output-file')).toHaveValue('today.json');
    await expect(dialog.getByTestId('task-dialog-output-warning')).toHaveText(
      'Shows this routine as a card on Today. The script runs with its template\'s access and can change any file it can reach.');

    const before = eve.relay.requests.length;
    const isPut = (r) => r.method() === 'PUT' && urlPath(r) === '/api/tasks/cw';
    const [req] = await Promise.all([page.waitForRequest(isPut), dialog.getByRole('button', { name: /Save|Update/ }).click()]);
    expect(req.postDataJSON().outputFile).toBe('today.json');
    await expect(page.locator('.toast').filter({
      hasText: 'Couldn\'t save the routine: Only a browser signed in with a passkey can set up a Today card.',
    })).toBeVisible();
    expect(eve.relay.requests.slice(before).filter((r) => r.path.startsWith('/api/tasks/cw') && r.method !== 'GET')).toEqual([]);
  });
});

test.describe('the Output file field on an SSH host project', () => {
  const hosted = { id: 'rh', name: 'Remote Box', path: '/srv/acme', host_id: 'h1', mode: 'work' };
  test.use({
    world: { ...world({ cw: ['Inbox today'], cr: ['Remote card', [], 'rh'] }), projects: (f) => [...PROJECTS(f), hosted], hosts: [{ id: 'h1', name: 'Acme box' }] },
  });
  const edit = async (page, project, id) => {
    await nav(page).getByTitle(project, { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await page.getByTestId(`project-task-${id}`).getByTitle('Edit').click();
    const dialog = page.getByTestId('dialog-task-dialog');
    await expect(dialog.locator('[name="taskTemplateId"]')).toBeVisible();
    return dialog;
  };

  test('is hidden, with its warning, where a console project\'s dialog shows them', async ({ page }) => {
    const console = await edit(page, 'Work Only', 'cw');
    await expect(console.getByTestId('task-dialog-output-file')).toBeVisible();
    await expect(console.getByTestId('task-dialog-output-warning')).toBeVisible();
    await reloadEve(page);
    const remote = await edit(page, 'Remote Box', 'cr');
    await expect(remote.getByTestId('task-dialog-output-file')).toBeHidden();
    await expect(remote.getByTestId('task-dialog-output-warning')).toBeHidden();
  });
});
