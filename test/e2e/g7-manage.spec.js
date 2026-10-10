const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function manageWorld() {
  const w = worlds.base();
  w.projects[0].files = {
    'README.md': '# Acme\n',
    'notes.txt': 'first line\n',
    'data.bin': 'binary-ish\n',
    '.hidden.txt': 'dot\n',
    'blob.txt': 'ab\u0000\u0001\u0002cd\u0000',
    'docs/guide.txt': 'guide text\n',
    'docs/notes.txt': 'docs notes\n',
    'big/huge.txt': 'x'.repeat(300 * 1024),
  };
  return w;
}

test.use({ world: manageWorld() });

async function openFiles(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  return page.getByRole('tree', { name: 'Files' });
}

const treeError = (page, text) =>
  page.getByRole('tree', { name: 'Files' }).getByText(text, { exact: true });

async function answerPrompt(page, text) {
  page.once('dialog', (d) => d.accept(text));
}

async function menuOn(page, name, item) {
  const tree = page.getByRole('tree', { name: 'Files' });
  await tree.getByRole('treeitem', { name, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('create a new file inside a folder @G7.21', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toBeVisible();
  const since = relay.mark();
  await answerPrompt(page, 'fresh.txt');
  await menuOn(page,'docs', 'New File');
  await expect(tree.getByRole('treeitem', { name: 'fresh.txt' })).toBeVisible();
  await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
});

test('a file type that is not editable is refused on create @G7.21.r2', async ({ eve, page }) => {
  await eve.open('/');
  await openFiles(page);
  await answerPrompt(page, 'fresh.bin');
  await menuOn(page,'docs', 'New File');
  await expect(treeError(page, 'File type not allowed for editing')).toBeVisible();
});

test('create a new folder inside a folder @G7.22', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toBeVisible();
  const since = relay.mark();
  await answerPrompt(page, 'sub');
  await menuOn(page,'docs', 'New Folder');
  await expect(tree.getByRole('treeitem', { name: 'sub', exact: true })).toBeVisible();
  await relay.waitForEvent('file.mkdir', { since, match: (l) => l.status === 'ok' });
});

test('a taken folder name is refused inside a folder @G7.22.r1', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toBeVisible();
  await answerPrompt(page, 'sub');
  await menuOn(page,'docs', 'New Folder');
  await expect(tree.getByRole('treeitem', { name: 'sub', exact: true })).toBeVisible();
  const since = relay.mark();
  await answerPrompt(page, 'sub');
  await menuOn(page,'docs', 'New Folder');
  await expect(treeError(page, 'Directory already exists')).toBeVisible();
  await relay.waitForEvent('file.mkdir', { since, match: (l) => l.status !== 'ok' });
});

test('create a new folder at the project root @G7.23', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  await answerPrompt(page, 'assets');
  await page.getByRole('button', { name: 'New Folder', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'assets', exact: true })).toBeVisible();
  await relay.waitForEvent('file.mkdir', { since, match: (l) => l.status === 'ok' });
});

test('a taken folder name is refused at the root @G7.23.r1', async ({ eve, page }) => {
  await eve.open('/');
  await openFiles(page);
  await answerPrompt(page, 'docs');
  await page.getByRole('button', { name: 'New Folder', exact: true }).click();
  await expect(treeError(page, 'Directory already exists')).toBeVisible();
});

test('reload one folder in the tree @G7.25', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toBeVisible();
  const since = relay.mark();
  await menuOn(page,'docs', 'Refresh');
  await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
  await expect(tree.getByRole('treeitem', { name: 'guide.txt' })).toBeVisible();
});

test('rename a file and its open tab @G7.26', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'notes.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
  const since = relay.mark();
  await answerPrompt(page, 'renamed.txt');
  await menuOn(page,'notes.txt', 'Rename');
  await expect(tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toBeVisible();
  await relay.waitForEvent('file.rename', { since, match: (l) => l.status === 'ok' });
});

test('a taken name is refused on rename @G7.26.r1', async ({ eve, page }) => {
  await eve.open('/');
  await openFiles(page);
  await answerPrompt(page, 'README.md');
  await menuOn(page,'notes.txt', 'Rename');
  await expect(treeError(page, 'A file or directory with that name already exists')).toBeVisible();
});

test('delete a file after the confirm @G7.27', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  let message = '';
  page.once('dialog', (d) => {
    message = d.message();
    d.accept();
  });
  await menuOn(page,'notes.txt', 'Delete');
  await expect(tree.getByRole('treeitem', { name: 'notes.txt', exact: true })).toHaveCount(0);
  expect(message).toBe('Delete "notes.txt"? This will move it to trash.');
  await relay.waitForEvent('file.delete', { since, match: (l) => l.status === 'ok' });
});

test('move a file by dragging it onto a folder @G7.28', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  await tree.getByRole('treeitem', { name: 'data.bin', exact: true }).dragTo(
    tree.getByRole('treeitem', { name: 'docs', exact: true }),
  );
  await relay.waitForEvent('file.move', { since, match: (l) => l.status === 'ok' });
  await expect(tree.getByRole('treeitem', { name: 'data.bin', exact: true, level: 1 })).toHaveCount(0);
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'data.bin', exact: true, level: 2 })).toBeVisible();
});

test('a taken name at the destination is refused on move @G7.28.r1', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'notes.txt', exact: true }).dragTo(
    tree.getByRole('treeitem', { name: 'docs', exact: true }),
  );
  await expect(
    treeError(page, 'A file or directory with that name already exists at destination'),
  ).toBeVisible();
});

test('dropping a folder on itself does nothing @G7.28.r2', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).dragTo(
    tree.getByRole('treeitem', { name: 'docs', exact: true }),
  );
  const since = relay.mark();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
  await expect(tree.getByRole('treeitem', { name: 'docs', exact: true })).toBeVisible();
  await expect(tree.getByText(/already exists|not reachable|failed/i)).toHaveCount(0);
});

test('ask about a file opens Today with the file attached @G7.30', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFiles(page);
  const since = relay.mark();
  await menuOn(page, 'notes.txt', 'Ask about this');
  await expect(page.getByRole('textbox', { name: 'Ask' })).toBeFocused();
  await relay.waitForEvent('file.stream', { since, match: (l) => l.status === 'ok' });
  const today = page.getByRole('main');
  await expect(today.getByText('notes.txt', { exact: true })).toBeVisible();
  await expect(today.getByRole('button', { name: 'Remove attachment', exact: true })).toBeVisible();
});

test('a file over 256 KB is refused for Ask about this @G7.30.r1', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'big', exact: true }).click();
  await menuOn(page,'huge.txt', 'Ask about this');
  await expect(page.getByText("That's too large to attach (over 256 KB).")).toBeVisible();
});

test('a binary file is refused for Ask about this @G7.30.r2', async ({ eve, page }) => {
  await eve.open('/');
  await openFiles(page);
  await menuOn(page,'blob.txt', 'Ask about this');
  await expect(page.getByText("That isn't a text file.")).toBeVisible();
});

test('dismiss a file error at the top of the tree @G7.31', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'data.bin', exact: true }).click();
  await expect(treeError(page, 'File type not allowed for editing')).toBeVisible();
  await treeError(page, 'File type not allowed for editing').click();
  await expect(treeError(page, 'File type not allowed for editing')).toHaveCount(0);
});

test('a file that cannot be read is refused for Ask about this @G7.30.r3', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await expect(tree.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  for (const route of [
    'GET /api/projects/{id}/files/stream',
    'POST /api/projects/{id}/files/read',
  ]) {
    const added = await relay.ctl('fault', 'add', '--route', route, '--mode', 'error', '--name', 'ERROR');
    expect(added.code).toBe(0);
  }
  await menuOn(page,'notes.txt', 'Ask about this');
  await expect(page.getByText("Couldn't read that file.")).toBeVisible();
});

test.describe('read-only project', () => {
  test.use({
    world: (() => {
      const w = manageWorld();
      w.projects[0].files_read_only = true;
      return w;
    })(),
  });

  test('a new file is refused @G7.21.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openFiles(page);
    await answerPrompt(page, 'fresh.txt');
    await menuOn(page,'docs', 'New File');
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
  });

  test('a new folder inside a folder is refused @G7.22.r2', async ({ eve, page }) => {
    await eve.open('/');
    await openFiles(page);
    await answerPrompt(page, 'sub');
    await menuOn(page,'docs', 'New Folder');
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
  });

  test('a new folder at the root is refused @G7.23.r2', async ({ eve, page }) => {
    await eve.open('/');
    await openFiles(page);
    await answerPrompt(page, 'assets');
    await page.getByRole('button', { name: 'New Folder', exact: true }).click();
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
  });

  test('a rename is refused @G7.26.r2', async ({ eve, page }) => {
    await eve.open('/');
    await openFiles(page);
    await answerPrompt(page, 'renamed.txt');
    await menuOn(page,'notes.txt', 'Rename');
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
  });

  test('a delete is refused @G7.27.r1', async ({ eve, page }) => {
    await eve.open('/');
    const tree = await openFiles(page);
    page.once('dialog', (d) => d.accept());
    await menuOn(page,'notes.txt', 'Delete');
    await expect(treeError(page, 'This project is read-only')).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  });
});

test('show dotfiles from Settings @G7.32', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: '.hidden.txt' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Show hidden files (dotfiles)' }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: '.hidden.txt' })).toBeVisible();
});
