const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function hostWorld({ agent = 'connected', presence = true } = {}) {
  const w = worlds.base();
  if (presence) w.presence = { 'project.grant': 'approve' };
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent,
  }];
  w.projects.push({ id: 'p_remote', name: 'Remote', host_id: 'h_box', path: '/home/acme/remote', mode: 'work', files: { 'todo.txt': 'one\n' } });
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
// The host bar under the panel title: the host's name and one status word.
const hostBar = (page, word) => page.getByText(new RegExp(`^\\s*testbox\\s*${word}\\s*$`));

async function openNew(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'New Project' }).click();
  await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
}

// Sets the host's live status; the call answers once every page has the frame.
async function setStatus(relay, status, error) {
  const args = ['host', 'status', '--id', 'h_box', '--status', status];
  if (error) args.push('--error', error);
  expect((await relay.ctl(...args)).code).toBe(0);
}

test.describe('hosts in the Project dialog', () => {
  test.use({ world: hostWorld() });

  test('the dialog lists the host under Where @G13.1', async ({ eve, page }) => {
    await openNew(eve, page);
    await expect(page.getByText('Where', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'This Mac' })).toBeVisible();
    await expect(page.getByRole('button', { name: /testbox/ })).toBeVisible();
  });

  test('create a project that lives on a host @G13.5', async ({ eve, relay, page }) => {
    await openNew(eve, page);
    await page.getByRole('button', { name: /testbox/ }).click();
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Orchard');
    await page.getByRole('textbox', { name: 'Path on testbox' }).fill('/home/acme/orchard');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeHidden();
    await relay.waitForEvent('project.create', { match: (l) => l.status === 'ok' });
    await rail(page).getByRole('button', { name: 'Orchard' }).click();
    await expect(hostBar(page, '(connected|connecting…)')).toBeVisible();
    const state = await relay.json('ctl', 'state', '--json');
    const made = state.projects.find((p) => p.name === 'Orchard');
    expect(made.host_id).toBe('h_box');
  });
});

test.describe('relay says no to a host project', () => {
  test.use({ world: hostWorld({ presence: false }) });

  test('the dialog stays open with the reason @G13.5.r1', async ({ eve, page }) => {
    await openNew(eve, page);
    await page.getByRole('button', { name: /testbox/ }).click();
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Orchard');
    await page.getByRole('textbox', { name: 'Path on testbox' }).fill('/home/acme/orchard');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByText(/Failed to save project: /)).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Orchard' })).toBeHidden();
  });
});

test.describe('the host bar', () => {
  test.use({ world: hostWorld() });

  test('a host project shows its host and status, a console project none @G13.6', async ({ eve, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Remote' }).click();
    await expect(hostBar(page, 'connected')).toBeVisible();
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await expect(page.getByRole('treeitem', { name: 'README.md' })).toBeVisible();
    await expect(hostBar(page, '(connected|connecting…|unreachable|idle)')).toBeHidden();
  });

  test('each status word follows the host @G13.6', async ({ eve, relay, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Remote' }).click();
    await expect(hostBar(page, 'connected')).toBeVisible();
    await setStatus(relay, 'connecting');
    await expect(hostBar(page, 'connecting…')).toBeVisible();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await expect(hostBar(page, 'unreachable')).toBeVisible();
    await setStatus(relay, 'connected');
    await expect(hostBar(page, 'connected')).toBeVisible();
  });

  test('the bar follows a probe that finds the host @G13.2', async ({ eve, relay, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Remote' }).click();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await expect(hostBar(page, 'unreachable')).toBeVisible();
    // A probe that reaches the host moves it to connecting, then connected.
    await setStatus(relay, 'connecting');
    await expect(hostBar(page, 'connecting…')).toBeVisible();
    await setStatus(relay, 'connected');
    await expect(hostBar(page, 'connected')).toBeVisible();
  });

  test('the bar shows a dropped connection @G13.3', async ({ eve, relay, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Remote' }).click();
    await expect(hostBar(page, 'connected')).toBeVisible();
    await setStatus(relay, 'unreachable', 'disconnected');
    await expect(hostBar(page, 'unreachable')).toBeVisible();
    await expect(hostBar(page, 'connected')).toBeHidden();
  });

  test('Today names the host beside the project @G13.7', async ({ eve, page }) => {
    await eve.open('/');
    const main = page.getByRole('main');
    await expect(main.getByText('testbox', { exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Acme' }).getByText('testbox')).toBeHidden();
  });

  test('Today shows the host status dot on the host project only @G13.7', async ({ eve, page }) => {
    await eve.open('/');
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Remote', exact: true }).getByRole('img', { name: 'connected', exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Acme', exact: true }).getByRole('img')).toHaveCount(0);
  });

  test('the palette shows the host status dot as it changes @G13.7', async ({ eve, relay, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Remote' }).click();
    await expect(hostBar(page, 'connected')).toBeVisible();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await expect(hostBar(page, 'unreachable')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+K');
    const box = page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' });
    await expect(box).toBeVisible();
    await box.fill('Remote');
    await expect(page.getByRole('option', { name: 'Remote', exact: true }).getByRole('img', { name: 'unreachable', exact: true })).toBeVisible();
    await box.fill('Acme');
    await expect(page.getByRole('option', { name: 'Acme', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Acme', exact: true }).getByRole('img')).toHaveCount(0);
  });

  test('the palette names the host beside the project @G13.7', async ({ eve, page }) => {
    await eve.open('/');
    await page.keyboard.press('Control+K');
    const box = page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' });
    await expect(box).toBeVisible();
    await box.fill('Remote');
    await expect(page.getByRole('option', { name: 'Remote', exact: true })).toContainText('testbox');
    await box.clear();
    await box.fill('Acme');
    await expect(page.getByRole('option', { name: 'Acme', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Acme', exact: true }).getByText('testbox')).toHaveCount(0);
  });
});
