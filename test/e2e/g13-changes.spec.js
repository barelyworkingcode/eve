const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// One host project (Remote on testbox) with one repo and one changed file.
function hostWorld() {
  const w = worlds.base();
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent: 'connected',
  }];
  w.projects.push({
    id: 'p_remote',
    name: 'Remote',
    host_id: 'h_box',
    path: '/home/acme/remote',
    mode: 'work',
    repos: [{ dir: 'alpha', branch: 'main', commits: [{ message: 'first', files: { 'a.txt': 'one\n' } }] }],
    files: { 'alpha/a.txt': 'one changed\n' },
  });
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const panel = (page) => page.getByRole('complementary');
const modified = (page) => page.getByRole('button', { name: 'Modified: a.txt', exact: true });

// Opens the host project's Changes tab from the Project panel.
async function openChanges(page) {
  await rail(page).getByRole('button', { name: 'Remote', exact: true }).click();
  await panel(page).getByRole('button', { name: /^Changes(\s+\d+)?$/ }).click();
  await expect(page.getByRole('group', { name: 'Scope' })).toBeVisible();
}

test.describe('a host project with a changed file', () => {
  test.use({ world: hostWorld() });

  test('the Changes tab lists what changed on the host @G13.13', async ({ eve, relay, page }) => {
    const since = relay.mark();
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Changes 1', exact: true })).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });

  test('a host that goes down keeps the last known changes @G13.13.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    const down = await relay.ctl('host', 'status', '--id', 'h_box', '--status', 'unreachable', '--error', 'ssh could not connect');
    expect(down.code).toBe(0);
    await expect(page.getByText('Host unreachable. Showing the last known changes.')).toBeVisible();
    await expect(modified(page)).toBeVisible();
  });

  test('git missing on the host says so @G13.13.r2', async ({ eve, relay, page }) => {
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/git', '--mode', 'error', '--status', '500', '--body', '{"error":"file operation failed","code":"GIT_MISSING"}');
    expect(added.code).toBe(0);
    await eve.open('/');
    await openChanges(page);
    await expect(page.getByText('Git is not installed on this host.')).toBeVisible();
    await expect(modified(page)).toBeHidden();
  });
});
