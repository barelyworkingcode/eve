const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const tell = (page) => page.getByRole('textbox', { name: 'Tell an agent' });

function cosWorld() {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.projects.push({ id: 'p_harbor', name: 'Harbor', mode: 'home', files: { 'NOTES.md': '# Harbor\n' } });
  w.default_project = { home: 'p_harbor', work: 'p_acme' };
  return w;
}

test.use({ world: cosWorld() });

test('a click on Chief of Staff before eve is ready stays on it once eve is ready @G6.30', async ({ eve, page, relay }) => {
  await eve.open('/');
  const since = relay.mark();
  const hold = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'slow');
  expect(hold.code).toBe(0);
  const id = JSON.parse(hold.stdout).id;
  await eve.reload({ preReady: 'acting before eve is ready is the row' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  await expect(page.getByRole('status').filter({ hasText: 'Starting…' })).toBeVisible();
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(tell(page)).toBeVisible();

  expect((await relay.ctl('fault', 'release', '--id', id)).code).toBe(0);
  expect((await relay.ctl('fault', 'clear')).code).toBe(0);
  await eve.ready();
  await expect(page.getByRole('status').filter({ hasText: 'Starting…' })).toBeHidden();
  await expect(tell(page)).toBeVisible();
});

test('switching from Work to Home keeps the Chief of Staff on screen @G6.30', async ({ eve, page }) => {
  await eve.open('/');
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(tell(page)).toBeVisible();

  const home = page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Home' });
  await home.click();
  await expect(home).toBeChecked();
  await expect(tell(page)).toBeVisible();
});
