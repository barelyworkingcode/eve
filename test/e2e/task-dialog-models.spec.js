const { expect } = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');
const { hermeticTest, gotoEve } = require('./fixtures');

const MODELS = {
  models: [
    { label: 'Acme Fast', value: 'acme-fast', group: 'Acme' },
    { label: 'Acme Deep', value: 'acme-deep', group: 'Acme' },
    { label: 'Acme Wide', value: 'acme-wide', group: 'Acme' },
  ],
  providerSettings: {},
};
const ALLOWED = ['acme-fast', 'acme-deep'];

// No auto-navigation: each test routes /api/models before the first load.
const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-taskmodels-'));
    const eve = await startEve({
      projects: [{ id: 'p1', name: 'Acme', path: dir, allowed_models: ALLOWED }],
      models: MODELS,
    });
    try { await use(eve); } finally { await eve.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  },
});

const isTaskPost = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks';

async function load(page, eve) {
  await gotoEve(page, eve.baseUrl);
  await page.waitForFunction(() => window.client?.projects?.has('p1'));
  // Survives only if the page is never reloaded.
  await page.evaluate(() => { window.__sameDocument = true; });
}

async function openNewTask(page) {
  await page.evaluate(() => window.client.bus.emit('dialog:task', { projectId: 'p1' }));
  const dialog = page.getByTestId('dialog-task-dialog');
  await dialog.locator('.dialog__tab[data-tab="new"]').click();
  await dialog.locator('[name="taskName"]').fill('Acme report');
  await dialog.locator('[name="taskType"]').selectOption('headless');
  return dialog;
}

const optionValues = (select) => select.locator('option').evaluateAll((opts) => opts.map((o) => o.value));

test('models arriving after the dialog opens: placeholder, save refused, then filled in place', async ({ page, eve }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/api/models', async (route) => { await gate; await route.continue(); });
  await load(page, eve);

  const dialog = await openNewTask(page);
  const select = dialog.locator('[name="taskModel"]');
  const options = select.locator('option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('value', '');
  await expect(options.first()).toBeDisabled();
  await expect(options.first()).toHaveText('Loading models…');

  const posts = [];
  page.on('request', (r) => { if (isTaskPost(r)) posts.push(r); });
  await dialog.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.locator('.toast__message', { hasText: 'Choose a model before saving this task.' })).toBeVisible();
  await expect(dialog).not.toHaveClass(/\bhidden\b/);
  expect(posts).toHaveLength(0);

  release();
  await expect.poll(() => optionValues(select)).toEqual(ALLOWED);
  await expect(dialog.locator('[name="taskName"]')).toHaveValue('Acme report');
  await select.selectOption('acme-deep');
  const [request] = await Promise.all([
    page.waitForRequest(isTaskPost),
    dialog.getByRole('button', { name: 'Create Task' }).click(),
  ]);
  expect(request.postDataJSON().model).toBe('acme-deep');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
});

test('a failed models fetch is retried and the select fills without a reload', async ({ page, eve }) => {
  let calls = 0;
  await page.route('**/api/models', async (route) => {
    calls += 1;
    if (calls === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    return route.continue();
  });
  await load(page, eve);

  const dialog = await openNewTask(page);
  await expect.poll(() => optionValues(dialog.locator('[name="taskModel"]')), { timeout: 10000 }).toEqual(ALLOWED);
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
});

test('a scheduler 400 on create shows its error in a toast and the dialog stays open', async ({ page, eve }) => {
  const error = 'task "Acme": model is required for chat tasks';
  eve.relay.failTaskCreateWith(400, { error });
  await load(page, eve);

  const dialog = await openNewTask(page);
  const select = dialog.locator('[name="taskModel"]');
  await expect.poll(() => optionValues(select)).toEqual(ALLOWED);
  await select.selectOption('acme-fast');
  const [response] = await Promise.all([
    page.waitForResponse((r) => isTaskPost(r.request())),
    dialog.getByRole('button', { name: 'Create Task' }).click(),
  ]);
  expect(response.status()).toBe(400);

  const toast = page.locator('.toast.toast--error[data-toast-id="task-save-error"]');
  await expect(toast.locator('.toast__message')).toHaveText(`Couldn't save the task: ${error}`);
  await expect(dialog).not.toHaveClass(/\bhidden\b/);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
});
