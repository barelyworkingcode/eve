const { test, expect } = require('./support/fixtures');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

async function ask(page, text) {
  const box = page.getByRole('textbox', { name: 'Ask' });
  await box.fill(text);
  await box.press('Enter');
}

test('a failed launch tells the person @G1.4.r3', async ({ eve, page, relay }) => {
  const added = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error', '--status', '500', '--body', '{"error":"boom"}');
  expect(added.code).toBe(0);
  await eve.open('/');
  await ask(page, 'hello from testbox');
  await expect(page.getByText("Couldn't start the thread. Try again.")).toBeVisible();
});

test('relay down tells the person @G1.4.r2', async ({ eve, page, relay }) => {
  await eve.open('/');
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  const added = await relay.ctl('fault', 'add', '--route', '*', '--mode', 'down');
  expect(added.code).toBe(0);
  await ask(page, 'hello from testbox');
  await expect(page.getByRole('status').filter({ hasText: "Can't reach relay." })).toBeVisible();
});
