const { test, expect } = require('./support/fixtures');

const CREATED = 1791622800;

function hostWorld({ agent = 'connected', tmux = true, sessions = [], persist = false } = {}) {
  const w = {
    schema: 1,
    projects: [
      { id: 'p_acme', name: 'Acme', mode: 'work', files: { 'README.md': '# Acme\n' } },
      { id: 'p_remote', name: 'Remote', host_id: 'h_box', path: '/home/acme/remote', mode: 'work', files: { 'todo.txt': 'seed corn\n' } },
    ],
    default_project: { work: 'p_acme' },
  };
  const template = { id: 'hshell', name: 'Shell', command: '/bin/bash', description: 'A shell on the host' };
  if (persist) template.persist = true;
  const host = {
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash' },
    agent,
    terminal_templates: [template],
    persistent_sessions: sessions,
  };
  if (tmux) {
    host.tmux_path = '/usr/bin/tmux';
    host.probe.tmux_path = '/usr/bin/tmux';
  }
  w.hosts = [host];
  return w;
}

const TWO = [
  { name: 'relay-p_remote-hshell-1', created: CREATED, attached: 0 },
  { name: 'relay-p_remote-hshell-2', created: CREATED, attached: 1 },
];

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const LISTING = 'GET /api/projects/{id}/persistent-sessions';
const KILLING = 'DELETE /api/projects/{id}/persistent-sessions/{name}';

async function openLauncher(page) {
  await rail(page).getByRole('button', { name: 'Remote' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
  await expect(launcher).toBeVisible();
  return launcher;
}

async function state(relay) {
  return relay.json('ctl', 'state', '--json');
}

async function setStatus(relay, status, error) {
  const args = ['host', 'status', '--id', 'h_box', '--status', status];
  if (error) args.push('--error', error);
  expect((await relay.ctl(...args)).code).toBe(0);
}

test.describe('a terminal on the host', () => {
  test.use({ world: hostWorld() });

  test('start a terminal that opens on the host @G13.14', async ({ eve, relay, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText('Sessions and terminals open on testbox.')).toBeVisible();
    await launcher.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(launcher).toBeHidden();
    await expect(page.getByRole('tab', { name: /testbox/ })).toBeVisible();
    await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' && l.kind === 'terminal' });
    expect((await state(relay)).terminals).toHaveLength(1);
  });
});

test.describe('remote sessions', () => {
  test.use({ world: hostWorld({ sessions: TWO }) });

  test('list the sessions left on the host @G13.15', async ({ eve, relay, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText('Remote sessions')).toBeVisible();
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    await expect(launcher.getByText(/^Shell #2\b/)).toBeVisible();
    await expect(launcher.getByText('attached', { exact: true })).toHaveCount(1);
    await expect(launcher.getByRole('button', { name: 'Reattach' })).toHaveCount(2);
    await relay.waitForEvent('session.persistent.list', { match: (l) => l.status === 'ok' });
  });

  test('refresh shows Loading and then the list again @G13.16', async ({ eve, relay, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    const slow = JSON.parse((await relay.ctl('fault', 'add', '--route', LISTING, '--mode', 'slow')).stdout);
    await launcher.getByRole('button', { name: 'Refresh remote sessions' }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(launcher.getByText('Loading…')).toBeVisible();
    expect((await relay.ctl('fault', 'release', '--id', slow.id)).code).toBe(0);
    await expect(launcher.getByText('Loading…')).toBeHidden();
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
  });

  test('refresh with the host down says so @G13.16.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await launcher.getByRole('button', { name: 'Refresh remote sessions' }).click();
    await expect(launcher.getByText("Couldn't reach the host")).toBeVisible();
    await expect(launcher.getByText(/^Shell #1\b/)).toBeHidden();
  });

  test('kill a session after the question @G13.18', async ({ eve, relay, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    await launcher.getByRole('button', { name: 'Kill' }).first().click();
    const confirm = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(confirm.getByText('Kill remote session "Shell #1"? Anything running in it on the host stops.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await relay.waitForEvent('session.persistent.kill', { match: (l) => l.status === 'ok' });
    await expect(launcher.getByText(/^Shell #1\b/)).toBeHidden();
    await expect(launcher.getByText(/^Shell #2\b/)).toBeVisible();
    const left = (await state(relay)).hosts[0].persistent_sessions.map((s) => s.name);
    expect(left).toEqual(['relay-p_remote-hshell-2']);
  });

  test('a kill that fails says why above the list @G13.18.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    expect((await relay.ctl('fault', 'add', '--route', KILLING, '--mode', 'error', '--status', '500', '--body', '{"error":"tmux said no"}')).code).toBe(0);
    await launcher.getByRole('button', { name: 'Kill' }).first().click();
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Delete' }).click();
    await expect(launcher.getByText('Couldn\'t kill "Shell #1": tmux said no')).toBeVisible();
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
  });

  test('keep a session at the kill question @G13.19', async ({ eve, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    await launcher.getByRole('button', { name: 'Kill' }).first().click();
    const confirm = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
  });
});

test.describe('a persistent template', () => {
  test.use({ world: hostWorld({ sessions: [TWO[0]], persist: true }) });

  test('reattach to a session on the host @G13.17', async ({ eve, relay, page }) => {
    await eve.open('/');
    // On load eve reattaches the listed session by itself; close that tab to reattach by hand.
    await rail(page).getByRole('button', { name: 'Remote' }).click();
    const tab = page.getByRole('tab', { name: /testbox/ });
    await expect(tab).toBeVisible();
    await page.getByRole('button', { name: /^Close .*testbox/ }).click();
    await expect(tab).toHaveCount(0);
    await page.getByRole('button', { name: 'New Session' }).click();
    const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
    await expect(launcher.getByText(/^Shell #1\b/)).toBeVisible();
    const since = relay.mark();
    await launcher.getByRole('button', { name: 'Reattach' }).click();
    await expect(launcher).toBeHidden();
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' && l.kind === 'terminal' });
  });
});

test.describe('no remote sessions left', () => {
  test.use({ world: hostWorld() });

  test('say none are left @G13.15.r3', async ({ eve, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText('No remote sessions.')).toBeVisible();
  });
});

test.describe('a host without tmux', () => {
  test.use({ world: hostWorld() });

  test('say tmux is missing @G13.15.r1', async ({ eve, relay, page }) => {
    // The text is relay's own for a host with no tmux; fakerelay words it differently.
    expect((await relay.ctl('fault', 'add', '--route', LISTING, '--mode', 'error', '--status', '409', '--body', '{"error":"tmux is not available on this host."}')).code).toBe(0);
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText('tmux is not available on this host.')).toBeVisible();
  });
});

test.describe('a host that is down', () => {
  test.use({ world: hostWorld({ agent: 'unreachable', sessions: TWO }) });

  test('say the host cannot be reached @G13.15.r2', async ({ eve, page }) => {
    await eve.open('/');
    const launcher = await openLauncher(page);
    await expect(launcher.getByText("Couldn't reach the host")).toBeVisible();
    await expect(launcher.getByText(/^Shell #1\b/)).toBeHidden();
  });
});
