const { test, expect } = require('./support/fixtures');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

test('greeting and summary line @G1.3', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await expect(page.getByText(/^1 projects? · \w+, \w+ \d+$/)).toBeVisible();
});

test('summary line says when projects fail to load @G1.3.r1', async ({ eve, page, relay }) => {
  const added = await relay.ctl('fault', 'add', '--route', 'GET /api/projects', '--mode', 'down');
  expect(added.code).toBe(0);
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await expect(
    page.getByText(/^(Can.t reach relay|Couldn.t load projects|Couldn.t load threads) · /),
  ).toBeVisible();
});
