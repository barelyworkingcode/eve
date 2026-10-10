const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function filesWorld(extra = {}, project = {}) {
  const w = worlds.base();
  w.projects[0].files = {
    'README.md': '# Acme\n\nplain paragraph\n',
    'notes.txt': 'first line\n',
    'page.html': '<h1>Hello page</h1>\n',
    'data.bin': 'binary-ish\n',
    'docs/guide.txt': 'guide text\n',
    ...extra,
  };
  Object.assign(w.projects[0], project);
  return w;
}

async function openFiles(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  return page.getByRole('tree', { name: 'Files' });
}

const dirtyTab = (page) => page.getByRole('tab').filter({ hasText: '●' });
const treeError = (page, text) =>
  page.getByRole('tree', { name: 'Files' }).getByText(text, { exact: true });


test.describe('editing', () => {
  test.use({ world: filesWorld() });

  test('list the project files, folders first @G7.2', async ({ eve, page, relay }) => {
    const since = relay.mark();
    await eve.open('/');
    const tree = await openFiles(page);
    await expect(tree.getByRole('treeitem', { name: 'docs' })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
    await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
    const names = await tree.getByRole('treeitem').allTextContents();
    expect(names.findIndex((n) => n.includes('docs'))).toBeLessThan(
      names.findIndex((n) => n.includes('README.md')),
    );
  });

  test('relay down shows a refusal in the tree @G7.2.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await expect(tree.getByRole('treeitem', { name: 'docs' })).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', '*', '--mode', 'down');
    expect(added.code).toBe(0);
    await tree.getByRole('treeitem', { name: 'docs' }).click();
    await expect(treeError(page, 'Relay is not reachable')).toBeVisible();
  });

  test('open and close a folder @G7.3', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    const since = relay.mark();
    await tree.getByRole('treeitem', { name: 'docs' }).click();
    await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toBeVisible();
    await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
    await tree.getByRole('treeitem', { name: 'docs' }).click();
    await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toHaveCount(0);
  });

  test('open a text file in the editor @G7.4', async ({ eve, page, relay }) => {
    const since = relay.mark();
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
    await expect(page.getByText('/notes.txt')).toBeVisible();
    await expect(page.getByText('first line')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await relay.waitForEvent('file.read', { since, match: (l) => l.status === 'ok' });
  });

  test('a type that is not editable is refused @G7.4.r1', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'data.bin' }).click();
    await expect(treeError(page, 'File type not allowed for editing')).toBeVisible();
  });

  test('change the text of an open file @G7.5', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
    await page.getByText('first line').click();
    await page.keyboard.type('more ');
    await expect(dirtyTab(page)).toBeVisible();
    await expect(save).toBeEnabled();
  });

  test('save with the Save button @G7.6', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    await page.getByText('first line').click();
    await page.keyboard.type('saved ');
    await expect(dirtyTab(page)).toBeVisible();

    const since = relay.mark();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
    await expect(dirtyTab(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    // Closing and reopening shows the saved text.
    await page.getByRole('button', { name: 'Close notes.txt' }).click();
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    await expect(page.getByText(/firstsaved/)).toBeVisible();
  });

  test('save with the keyboard @G7.7', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    await page.getByText('first line').click();
    await page.keyboard.type('kb ');
    await expect(dirtyTab(page)).toBeVisible();

    const since = relay.mark();
    await page.keyboard.press('ControlOrMeta+s');
    await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
    await expect(dirtyTab(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  });

  test('reload the whole Files list @G7.24', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
    const since = relay.mark();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
    await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
  });

  test('refresh with relay down says so @G7.24.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', '*', '--mode', 'down');
    expect(added.code).toBe(0);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(treeError(page, 'Relay is not reachable')).toBeVisible();
  });
});

test.describe('read-only project', () => {
  test.use({ world: filesWorld({}, { files_read_only: true }) });

  test('save with the button is refused @G7.6.r1', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    await page.getByText('first line').click();
    await page.keyboard.type('nope ');
    await expect(dirtyTab(page)).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
    await expect(dirtyTab(page)).toBeVisible();
  });

  test('save with the keyboard is refused @G7.7.r1', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
    await page.getByText('first line').click();
    await page.keyboard.type('nope ');
    await expect(dirtyTab(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
    await expect(dirtyTab(page)).toBeVisible();
  });
});

test.describe('refusals read from relay', () => {
  test.use({
    world: filesWorld({
      'huge.txt': 'x'.repeat(11 * 1024 * 1024),
      'link.txt': { symlink: 'notes.txt' },
    }),
  });

  test('a file over 10 MB is refused @G7.4.r2', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'huge.txt' }).click();
    await expect(treeError(page, 'File too large (max 10MB)')).toBeVisible();
  });

  test('a symbolic link is not opened @G7.4.r3', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'link.txt' }).click();
    await expect(treeError(page, 'Symbolic links are not opened')).toBeVisible();
  });

  test('a folder that is gone says so @G7.2.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await expect(tree.getByRole('treeitem', { name: 'docs' })).toBeVisible();
    const added = await relay.ctl(
      'fault', 'add', '--route', 'POST /api/projects/{id}/files/list', '--mode', 'error',
      '--status', '404', '--body', JSON.stringify({ error: 'Not found', code: 'ENOENT' }),
    );
    expect(added.code).toBe(0);
    await tree.getByRole('treeitem', { name: 'docs' }).click();
    await expect(treeError(page, 'Directory not found')).toBeVisible();
  });
});

test.describe('preview modes', () => {
  test.use({ world: filesWorld() });

  test('see Markdown as editor and preview side by side @G7.8', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'README.md' }).click();
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Editor content/ })).toBeVisible();
  });

  test('see only the preview @G7.9', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'README.md' }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Editor content/ })).toBeHidden();
  });

  test('see only the editor @G7.10', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    await tree.getByRole('treeitem', { name: 'README.md' }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^Editor content/ })).toBeHidden();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^Editor content/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeHidden();
  });
});
