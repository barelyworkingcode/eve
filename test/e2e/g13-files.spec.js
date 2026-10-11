const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function hostWorld({ agent = 'connected' } = {}) {
  const w = worlds.base();
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent,
  }];
  const remote = {
    id: 'p_remote',
    name: 'Remote',
    host_id: 'h_box',
    path: '/home/acme/remote',
    mode: 'work',
    files: { 'todo.txt': 'seed corn\n', 'notes.txt': 'plan harvest\n', 'old.txt': 'bye\n' },
  };
  w.projects.push(remote);
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const tree = (page) => page.getByRole('tree', { name: 'Files' });

async function openRemote(page) {
  await rail(page).getByRole('button', { name: 'Remote' }).click();
}

async function setStatus(relay, status, error) {
  const args = ['host', 'status', '--id', 'h_box', '--status', status];
  if (error) args.push('--error', error);
  expect((await relay.ctl(...args)).code).toBe(0);
}

const treeError = (page, text) => tree(page).getByText(text, { exact: true });

const NOT_CONNECTED = 'Host "testbox" is not connected';

test.describe('files while the host connects', () => {
  test.use({ world: hostWorld({ agent: 'connecting' }) });

  test('list the files once the host answers @G13.8', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await expect(page.getByText('Connecting to testbox…')).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'todo.txt' })).toBeHidden();
    const since = relay.mark();
    await setStatus(relay, 'connected');
    await expect(tree(page).getByRole('treeitem', { name: 'todo.txt' })).toBeVisible();
    await expect(page.getByText('Connecting to testbox…')).toBeHidden();
    await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
  });
});

test.describe('files on a host that is down', () => {
  test.use({ world: hostWorld({ agent: 'unreachable' }) });

  test('say the host is unreachable @G13.8.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openRemote(page);
    await expect(page.getByText('testbox is unreachable')).toBeVisible();
    await expect(page.getByText('ssh could not connect')).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'todo.txt' })).toBeHidden();
  });

  test('Retry lists the files once the host answers @G13.9', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await expect(page.getByText('testbox is unreachable')).toBeVisible();
    const since = relay.mark();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Connecting to testbox…')).toBeVisible();
    // Relay's probe finds the host.
    await setStatus(relay, 'connected');
    await expect(tree(page).getByRole('treeitem', { name: 'todo.txt' })).toBeVisible();
    await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
  });

  test('Retry on a host still down says so again @G13.9.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await expect(page.getByText('testbox is unreachable')).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Connecting to testbox…')).toBeVisible();
    // Relay's probe fails again.
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await expect(page.getByText('testbox is unreachable')).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'todo.txt' })).toBeHidden();
  });
});

test.describe('a file on a host', () => {
  test.use({ world: hostWorld() });

  test('open a file, change it and save it @G13.10', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await tree(page).getByRole('treeitem', { name: 'todo.txt' }).click();
    await expect(page.getByText('seed corn')).toBeVisible();
    await page.getByText('seed corn').click();
    await page.keyboard.type('more ');
    const dirty = page.getByRole('tab').filter({ hasText: '●' });
    await expect(dirty).toBeVisible();
    const since = relay.mark();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
    await expect(dirty).toHaveCount(0);
  });

  test('save while the host is not up is refused @G13.10.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await tree(page).getByRole('treeitem', { name: 'todo.txt' }).click();
    await expect(page.getByText('seed corn')).toBeVisible();
    await page.getByText('seed corn').click();
    await page.keyboard.type('more ');
    const dirty = page.getByRole('tab').filter({ hasText: '●' });
    await expect(dirty).toBeVisible();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(treeError(page, NOT_CONNECTED)).toBeVisible();
    await expect(dirty).toBeVisible();
  });

  test('delete a file, told there is no Trash @G13.11', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    const item = tree(page).getByRole('treeitem', { name: 'old.txt' });
    await expect(item).toBeVisible();
    let asked = '';
    page.once('dialog', async (d) => {
      asked = d.message();
      await d.accept();
    });
    const since = relay.mark();
    await item.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await relay.waitForEvent('file.delete', { since, match: (l) => l.status === 'ok' });
    await expect(item).toBeHidden();
    expect(asked).toBe('Delete "old.txt" permanently? There is no Trash on testbox.');
  });

  test('delete while the host is not up is refused @G13.11.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    const item = tree(page).getByRole('treeitem', { name: 'old.txt' });
    await expect(item).toBeVisible();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    page.once('dialog', (d) => d.accept());
    await item.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(treeError(page, NOT_CONNECTED)).toBeVisible();
    await expect(item).toBeVisible();
  });

  test('search the files of a host project @G13.12', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const since = relay.mark();
    await page.getByRole('textbox', { name: 'Search file contents…' }).fill('harvest');
    await relay.waitForEvent('file.search', { since, match: (l) => l.status === 'ok' });
    await expect(page.getByText('plan harvest')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask about this' })).toBeHidden();
  });

  test('search while the host is not up says so @G13.12.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openRemote(page);
    await expect(tree(page).getByRole('treeitem', { name: 'todo.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await setStatus(relay, 'unreachable', 'ssh could not connect');
    await page.getByRole('textbox', { name: 'Search file contents…' }).fill('harvest');
    await expect(page.getByText(NOT_CONNECTED)).toBeVisible();
    await expect(page.getByText('plan harvest')).toBeHidden();
  });
});
