const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// alpha has a modified and an untracked file; beta is clean.
function changesWorld() {
  const w = worlds.base();
  w.projects[0].repos = [
    { dir: 'alpha', branch: 'main', commits: [{ message: 'first', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } }] },
    { dir: 'beta', branch: 'main', commits: [{ message: 'first', files: { 'c.txt': 'three\n' } }] },
  ];
  w.projects[0].files = { 'alpha/a.txt': 'one changed\n', 'alpha/new.txt': 'fresh\n' };
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const panel = (page) => page.getByRole('complementary');
const tab = (page) => panel(page).getByRole('button', { name: /^Changes/ });
const modified = (page) => page.getByRole('button', { name: 'Modified: a.txt', exact: true });
const untracked = (page) => page.getByRole('button', { name: 'Untracked: new.txt', exact: true });

// Opens the project's Changes tab through the Project page.
async function openChanges(page, project = 'Acme') {
  await rail(page).getByRole('button', { name: project, exact: true }).click();
  await page.getByRole('button', { name: 'Project page', exact: true }).click();
  await expect(page.getByRole('heading', { name: project, level: 1 })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: /^Changes/ }).click();
  await expect(page.getByRole('group', { name: 'Scope' })).toBeVisible();
}

test.describe('repos with changes', () => {
  test.use({ world: changesWorld() });

  test('open the Changes tab from the Project page @G6.66', async ({ eve, relay, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Acme', exact: true }).click();
    await page.getByRole('button', { name: 'Project page', exact: true }).click();
    const since = relay.mark();
    await page.getByRole('main').getByRole('button', { name: /^Changes 2$/ }).click();
    await expect(page.getByRole('group', { name: 'Scope' })).toBeVisible();
    await expect(tab(page)).toHaveText('Changes 2');
    await expect(page.getByRole('tree', { name: 'Files' })).toBeHidden();
    await expect(modified(page)).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });

  test('the tab lists each repo with its branch and count @G6.65', async ({ eve, relay, page }) => {
    const since = relay.mark();
    await eve.open('/');
    await openChanges(page);
    await expect(panel(page).getByRole('group', { name: 'Scope' })).toBeVisible();
    await expect(tab(page)).toHaveText('Changes 2');
    await expect(panel(page).getByRole('button', { name: /^alpha\b/ })).toHaveText('alpha main 2');
    await expect(panel(page).getByRole('button', { name: /^beta\b/ })).toHaveText('beta main clean');
    await expect(modified(page)).toBeVisible();
    await expect(untracked(page)).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });

  test('Uncommitted lists the working tree changes @G6.67', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'vs base', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'vs base', exact: true, pressed: true })).toBeVisible();
    const since = relay.mark();
    await panel(page).getByRole('button', { name: 'Uncommitted', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Uncommitted', exact: true, pressed: true })).toBeVisible();
    await expect(modified(page)).toBeVisible();
    await expect(untracked(page)).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });

  test('vs base lists the changes on the branch @G6.68', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    const since = relay.mark();
    await panel(page).getByRole('button', { name: 'vs base', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'vs base', exact: true, pressed: true })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Uncommitted', exact: true, pressed: false })).toBeVisible();
    await expect(modified(page)).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });

  test('Refresh reloads the list @G6.69', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    const since = relay.mark();
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
    await expect(modified(page)).toBeVisible();
  });

  test('fold and unfold a repo @G6.70', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    const alpha = panel(page).getByRole('button', { name: /^alpha\b/ });
    await expect(panel(page).getByRole('button', { name: /^beta\b/, expanded: false })).toHaveText('beta main clean');
    await expect(alpha).toHaveAttribute('aria-expanded', 'true');
    await expect(modified(page)).toBeVisible();
    await alpha.click();
    await expect(panel(page).getByRole('button', { name: /^alpha\b/, expanded: false })).toBeVisible();
    await expect(modified(page)).toBeHidden();
    await expect(untracked(page)).toBeHidden();
    await panel(page).getByRole('button', { name: /^alpha\b/, expanded: false }).click();
    await expect(modified(page)).toBeVisible();
    await expect(untracked(page)).toBeVisible();
  });

  test('an agent edit joins the list without a reload @G6.77', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    await relay.waitForEvent('fakerelay.watch', { match: (l) => l.status === 'ok' });
    const since = relay.mark();
    const write = await relay.ctl('fs-write', '--project', 'p_acme', '--path', 'alpha/extra.txt', '--content', 'agent was here\n');
    expect(write.code).toBe(0);
    expect(JSON.parse(write.stdout).delivered).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('button', { name: 'Untracked: extra.txt', exact: true })).toBeVisible();
    await expect(tab(page)).toHaveText('Changes 3');
    await expect(panel(page).getByRole('button', { name: /^alpha\b/ })).toHaveText('alpha main 3');
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });
});

test.describe('a project with no repos', () => {
  test('say there are no git repositories @G6.65.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(page.getByText('No git repositories in this project')).toBeVisible();
  });
});

test.describe('git is missing', () => {
  test.use({ world: changesWorld() });

  test('the note replaces the list @G6.65.r2', async ({ eve, relay, page }) => {
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/git', '--mode', 'error', '--status', '500', '--body', '{"error":"file operation failed","code":"GIT_MISSING"}');
    expect(added.code).toBe(0);
    await eve.open('/');
    await openChanges(page);
    await expect(page.getByText('Git is not installed on this machine.')).toBeVisible();
    await expect(modified(page)).toBeHidden();
  });
});

test.describe('git is slow', () => {
  test.use({ world: changesWorld() });

  test('vs base says git timed out @G6.68.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/git', '--mode', 'error', '--name', 'TIMEOUT');
    expect(added.code).toBe(0);
    await panel(page).getByRole('button', { name: 'vs base', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(page.getByText('git timed out').first()).toBeVisible();
  });

  test('vs base says there are too many changes @G6.68.r2', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/git', '--mode', 'error', '--status', '413', '--body', '{"error":"File too large","code":"TOO_LARGE"}');
    expect(added.code).toBe(0);
    await panel(page).getByRole('button', { name: 'vs base', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(page.getByText('Too many changes to list').first()).toBeVisible();
  });

  test('Refresh says why git failed @G6.69.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(modified(page)).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/git', '--mode', 'error', '--name', 'ERROR');
    expect(added.code).toBe(0);
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(page.getByText('internal error').first()).toBeVisible();
  });
});

test.describe('a host project', () => {
  const world = worlds.base();
  world.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent: 'connected',
  }];
  world.projects.push({
    id: 'p_remote',
    name: 'Remote',
    host_id: 'h_box',
    path: '/home/acme/remote',
    mode: 'work',
    repos: [{ dir: 'alpha', branch: 'main', commits: [{ message: 'first', files: { 'a.txt': 'one\n' }}] }],
    files: { 'alpha/a.txt': 'one changed\n' },
  });
  test.use({ world });

  test('a host that is down says so @G6.65.r3', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page, 'Remote');
    await expect(modified(page)).toBeVisible();
    const down = await relay.ctl('host', 'status', '--id', 'h_box', '--status', 'unreachable', '--error', 'ssh could not connect');
    expect(down.code).toBe(0);
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Host unreachable.')).toBeVisible();
  });
});
