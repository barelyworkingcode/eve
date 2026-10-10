const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function dropWorld() {
  const w = worlds.base();
  w.projects[0].files = {
    'README.md': '# Acme\n',
    'docs/guide.txt': 'guide text\n',
  };
  return w;
}

test.use({ world: dropWorld() });

async function openDocs(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Files' });
  await tree.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'guide.txt', exact: true })).toBeVisible();
  return tree;
}

const writes = async (relay, since) => (await relay.logs({ event: 'file.write', since })).length;

test('drop a file from the desktop onto a folder @G7.29', async ({ eve, page, relay, desktop }) => {
  await eve.open('/');
  const tree = await openDocs(page);
  const since = relay.mark();
  await desktop.dropFiles(tree.getByRole('treeitem', { name: 'docs', exact: true }), [
    { name: 'dropped.txt', text: 'from the desktop\n' },
  ]);
  await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
  await expect(tree.getByRole('treeitem', { name: 'dropped.txt', exact: true })).toBeVisible();
});

test('a drop on empty tree space does nothing @G7.29', async ({ eve, page, relay, desktop }) => {
  await eve.open('/');
  const tree = await openDocs(page);
  const since = relay.mark();
  await desktop.dropFiles(tree, [{ name: 'stray.txt', text: 'nowhere\n' }]);
  // The marker: a drop on the folder does land, so the stray one had its turn.
  await desktop.dropFiles(tree.getByRole('treeitem', { name: 'docs', exact: true }), [
    { name: 'marker.txt', text: 'here\n' },
  ]);
  await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
  await expect(tree.getByRole('treeitem', { name: 'marker.txt', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'stray.txt', exact: true })).toHaveCount(0);
  expect(await writes(relay, since)).toBe(1);
});

test('a file whose name is taken is refused @G7.29.r1', async ({ eve, page, desktop }) => {
  await eve.open('/');
  const tree = await openDocs(page);
  await desktop.dropFiles(tree.getByRole('treeitem', { name: 'docs', exact: true }), [
    { name: 'guide.txt', text: 'a second guide\n' },
  ]);
  await expect(
    tree.getByText('A file with that name already exists', { exact: true }),
  ).toBeVisible();
});

test('a file over 10 MB is skipped @G7.29.r2', async ({ eve, page, relay, desktop }) => {
  await eve.open('/');
  const tree = await openDocs(page);
  const since = relay.mark();
  await desktop.dropFiles(tree.getByRole('treeitem', { name: 'docs', exact: true }), [
    { name: 'huge.bin', size: 11 * 1024 * 1024, type: 'application/octet-stream' },
    { name: 'small.txt', text: 'small\n' },
  ]);
  // The small one is the marker: once it is written the big one has had its turn.
  await relay.waitForEvent('file.write', { since, match: (l) => l.status === 'ok' });
  await expect(tree.getByRole('treeitem', { name: 'small.txt', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'huge.bin', exact: true })).toHaveCount(0);
  expect(await writes(relay, since)).toBe(1);
});
