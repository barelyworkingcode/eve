const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const BIG_TEXT = 'a line of text that is long enough\n'.repeat(9000); // about 315 KB, under 2 MiB
const NUL_BYTES = Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0x03, 0xff]).toString('base64');
const OVER_2_MIB = Buffer.alloc(2 * 1024 * 1024 + 4096, 0x61).toString('base64');

// alpha: a.txt modified, new.txt untracked, b.txt unchanged (it is deleted by a test that needs it).
function diffWorld() {
  const w = worlds.base();
  w.projects[0].repos = [
    { dir: 'alpha', branch: 'main', commits: [{ message: 'first', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } }] },
  ];
  w.projects[0].files = {
    'alpha/a.txt': 'one changed\n',
    'alpha/new.txt': 'fresh\n',
  };
  return w;
}

const panel = (page) => page.getByRole('complementary');
const diffView = (page) => page.getByRole('group', { name: 'Diff view' });
const askButton = (page) => diffView(page).getByRole('button', { name: 'Ask about this', exact: true });
const row = (page, name) => page.getByRole('button', { name, exact: true });

async function openChanges(page, project = 'Acme') {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: project, exact: true }).click();
  await panel(page).getByRole('button', { name: /^Changes(\s+\d+)?$/ }).click();
  await expect(page.getByRole('group', { name: 'Scope' })).toBeVisible();
}

// Opens the diff of a text change and waits until it is computed (Ask about this turns enabled).
async function openTextDiff(page, name) {
  await row(page, name).click();
  await expect(diffView(page)).toBeVisible();
  await expect(askButton(page)).toBeEnabled();
}

test.describe('a modified file', () => {
  test.use({ world: diffWorld() });

  test('open a changed file as a diff @G6.71', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    const since = relay.mark();
    await openTextDiff(page, 'Modified: a.txt');
    await expect(page.getByRole('tab', { name: /a\.txt/ })).toBeVisible();
    await expect(page.getByRole('main').getByText('M', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText(/alpha\s+·\s+⎇\s+main/)).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
  });

  test('the diff load fails and Retry loads it @G6.71.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await expect(row(page, 'Modified: a.txt')).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/git', '--mode', 'error', '--status', '500', '--body', '{"error":"file operation failed","code":"ERROR"}', '--times', '1');
    expect(added.code).toBe(0);
    await row(page, 'Modified: a.txt').click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(page.getByText('Could not load the diff')).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(askButton(page)).toBeEnabled();
    await expect(page.getByText('Could not load the diff')).toBeHidden();
  });

  test('side by side is pressed at a wide window @G6.72', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    await openTextDiff(page, 'Modified: a.txt');
    await diffView(page).getByRole('button', { name: 'Inline', exact: true }).click();
    await expect(diffView(page).getByRole('button', { name: 'Inline', exact: true, pressed: true })).toBeVisible();
    await diffView(page).getByRole('button', { name: 'Side by side', exact: true }).click();
    await expect(diffView(page).getByRole('button', { name: 'Side by side', exact: true, pressed: true })).toBeVisible();
    await expect(diffView(page).getByRole('button', { name: 'Inline', exact: true, pressed: false })).toBeVisible();
  });

  test('inline shows the changes in one column @G6.73', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    await openTextDiff(page, 'Modified: a.txt');
    await expect(diffView(page).getByRole('button', { name: 'Side by side', exact: true, pressed: true })).toBeVisible();
    await diffView(page).getByRole('button', { name: 'Inline', exact: true }).click();
    await expect(diffView(page).getByRole('button', { name: 'Inline', exact: true, pressed: true })).toBeVisible();
    await expect(diffView(page).getByRole('button', { name: 'Side by side', exact: true, pressed: false })).toBeVisible();
  });

  test('the file button opens the working file in the editor @G6.74', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    await openTextDiff(page, 'Modified: a.txt');
    const since = relay.mark();
    await diffView(page).getByRole('button', { name: 'File', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await relay.waitForEvent('file.read', { since, match: (l) => l.status === 'ok' });
  });

  test('Ask about this puts the diff in the Ask box on Today @G6.75', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    await openTextDiff(page, 'Modified: a.txt');
    await askButton(page).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Diff: alpha/a.txt')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Ask', exact: true })).toBeVisible();
  });
});

test.describe('a deleted file', () => {
  test.use({ world: diffWorld() });

  test('the file button is off for a deleted file @G6.74.r1', async ({ eve, relay, page }) => {
    await eve.open('/');
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Files', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Files' });
    await tree.getByRole('treeitem', { name: 'alpha', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: 'b.txt', exact: true })).toBeVisible();
    const since = relay.mark();
    page.once('dialog', (d) => d.accept());
    await tree.getByRole('treeitem', { name: 'b.txt', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await relay.waitForEvent('file.delete', { since, match: (l) => l.status === 'ok' });
    await panel(page).getByRole('button', { name: /^Changes(\s+\d+)?$/ }).click();
    await row(page, 'Deleted: b.txt').click();
    await expect(diffView(page)).toBeVisible();
    const file = diffView(page).getByRole('button', { name: 'File', exact: true });
    await expect(file).toBeDisabled();
    await expect(file).toHaveAttribute('title', 'File was deleted');
  });
});

test.describe('files with no text diff', () => {
  const world = diffWorld();
  world.projects[0].files['alpha/blob.bin'] = { base64: NUL_BYTES };
  world.projects[0].files['alpha/huge.txt'] = { base64: OVER_2_MIB };
  world.projects[0].files['alpha/long.txt'] = BIG_TEXT;
  test.use({ world });

  test('a binary file reads Binary file changed @G6.76', async ({ eve, relay, page }) => {
    await eve.open('/');
    await openChanges(page);
    const since = relay.mark();
    await row(page, 'Untracked: blob.bin').click();
    await expect(page.getByText('Binary file changed')).toBeVisible();
    await expect(diffView(page)).toBeVisible();
    await relay.waitForEvent('file.git', { since, match: (l) => l.status === 'ok' });
    await row(page, 'Untracked: huge.txt').click();
    await expect(page.getByText('File too large to diff')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeVisible();
  });

  test('a binary or too large file has no Ask about this button @G6.75.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    await row(page, 'Untracked: blob.bin').click();
    await expect(page.getByText('Binary file changed')).toBeVisible();
    await expect(askButton(page)).toBeHidden();
    await row(page, 'Untracked: huge.txt').click();
    await expect(page.getByText('File too large to diff')).toBeVisible();
    await expect(askButton(page)).toBeHidden();
  });

  test('a diff over 256 KB is too large to attach @G6.75.r2', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page);
    await openTextDiff(page, 'Untracked: long.txt');
    await askButton(page).click();
    await expect(page.getByText("That's too large to attach (over 256 KB).")).toBeVisible();
    await expect(page.getByText('Diff: alpha/long.txt')).toBeHidden();
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
    repos: [{ dir: 'alpha', branch: 'main', commits: [{ message: 'first', files: { 'a.txt': 'one\n' } }] }],
    files: { 'alpha/a.txt': 'one changed\n' },
  });
  test.use({ world });

  test('a host project diff has no Ask about this button @G6.75.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openChanges(page, 'Remote');
    await row(page, 'Modified: a.txt').click();
    await expect(diffView(page)).toBeVisible();
    await expect(diffView(page).getByRole('button', { name: 'Side by side', exact: true })).toBeVisible();
    await expect(askButton(page)).toBeHidden();
  });
});
