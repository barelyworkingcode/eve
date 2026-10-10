const { test, expect } = require('./support/fixtures');

test.describe('scheduler down', () => {
  test.use({ scheduler: false });

  test('Needs you says the scheduler is out of reach @G1.19.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText("Can't reach the scheduler.").first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Nothing needs you.')).toBeHidden();
  });

  test('Running says the scheduler is out of reach @G1.21.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText("Can't reach the scheduler.").first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Nothing running.')).toBeHidden();
  });
});

test('retry a Today part that failed to load @G1.38', async ({ eve, page, relay }) => {
  const added = await relay.ctl('fault', 'add', '--route', 'GET /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
  expect(added.code).toBe(0);
  await eve.open('/');
  await expect(page.getByText("Couldn't load threads.").first()).toBeVisible();
  expect((await relay.ctl('fault', 'clear')).code).toBe(0);
  await page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(page.getByText("Couldn't load threads.")).toBeHidden();
});

test('a Retry while the source is still down keeps the failure line @G1.38.r1', async ({ eve, page, relay }) => {
  const added = await relay.ctl('fault', 'add', '--route', 'GET /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
  expect(added.code).toBe(0);
  await eve.open('/');
  await expect(page.getByText("Couldn't load threads.").first()).toBeVisible();
  const since = relay.mark();
  await page.getByRole('main').getByRole('button', { name: 'Retry', exact: true }).first().click();
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
  await expect(page.getByText("Couldn't load threads.").first()).toBeVisible();
});
