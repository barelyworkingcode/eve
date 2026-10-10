const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function twoUnpicked() {
  const w = worlds.base();
  w.projects.push({ id: 'p_beta', name: 'Beta', mode: 'work', files: { 'NOTES.md': '# Beta\n' } });
  w.default_project = {};
  return w;
}

function noProject() {
  const w = worlds.base();
  w.projects = [];
  w.default_project = {};
  return w;
}

test('start a thread with the Ask button @G1.5', async ({ eve, page, relay }) => {
  const since = relay.mark();
  await eve.open('/');
  await page.getByRole('textbox', { name: 'Ask' }).fill('hello from testbox');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  const launch = await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
  expect(launch.status).toBe('ok');
  const turn = await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  expect(turn.status).toBe('ok');
});

test.describe('no project', () => {
  test.use({ world: noProject() });

  test('Ask is disabled and says why @G1.5.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: /^Create a project to start asking\.$/ })).toBeVisible();
  });
});

test.describe('modes with no default project', () => {
  test.use({ world: twoUnpicked() });

  test('choose the project Ask uses and keep the pick @G1.7', async ({ eve, page, relay }) => {
    await eve.open('/');
    const project = page.getByRole('combobox', { name: 'Project' });
    await expect(project.getByRole('option', { name: 'Choose a project…' })).toBeAttached();
    await expect(project.getByRole('option', { name: 'Beta' })).toBeAttached();
    await project.selectOption({ label: 'Beta' });
    await page.getByRole('textbox', { name: 'Ask' }).fill('hello from testbox');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });

    await page.getByRole('button', { name: /^Close Beta/ }).click();
    await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue('p_beta');
  });

  test('no pick made keeps Ask disabled @G1.7.r1', async ({ eve, page }) => {
    await eve.open('/');
    const ask = page.getByRole('textbox', { name: 'Ask' });
    await ask.fill('hello from testbox');
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
    await ask.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Choose a project.' })).toBeVisible();
  });
});

test('Return before eve is ready sends itself once it is @G1.6', async ({ eve, page, relay }) => {
  await eve.open('/');
  const hold = await relay.ctl('fault', 'add', '--route', 'GET /api/sessions', '--mode', 'slow', '--times', '1');
  expect(hold.code).toBe(0);
  const since = relay.mark();
  await eve.reload({ preReady: 'acting before eve is ready is the row' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('hello from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Sending when eve is ready…' })).toBeVisible();
  expect((await relay.ctl('fault', 'release', '--id', JSON.parse(hold.stdout).id)).code).toBe(0);
  await eve.ready();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Acme - hello from testbox' })).toBeVisible();
  await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
});

test('start a thread by typing in Ask and pressing Return @G1.4', async ({ eve, page, relay }) => {
  const since = relay.mark();
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('hello from testbox');
  await ask.press('Enter');

  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  const launch = await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
  expect(launch.status).toBe('ok');
  const turn = await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  expect(turn.status).toBe('ok');
});
