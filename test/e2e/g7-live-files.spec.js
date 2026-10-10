const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const svg = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  '<rect width="100%" height="100%" fill="#336699"/></svg>\n';

function liveWorld() {
  const w = worlds.base();
  w.projects[0].files = {
    'README.md': '# Acme\n',
    'notes.txt': 'first line\n',
    'logo.svg': svg(40, 20),
  };
  return w;
}

test.use({ world: liveWorld() });

const BANNER = 'This file has been modified externally.';
const dirtyTab = (page) => page.getByRole('tab').filter({ hasText: '●' });

async function openFile(page, name) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Files' });
  await tree.getByRole('treeitem', { name, exact: true }).click();
}

// eve asks relay to watch the project once a file is open; fs events only
// reach eve after that watch is live.
async function watched(relay) {
  await relay.waitForEvent('fakerelay.watch', { match: (l) => l.status === 'ok' && l.project_id === 'p_acme' });
}

async function writeOnDisk(relay, path, content) {
  const res = await relay.ctl('fs-write', '--project', 'p_acme', '--path', path, '--content', content);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).delivered).toBeGreaterThanOrEqual(1);
}

async function typeIntoNotes(page) {
  await page.getByText('first line').click();
  await page.keyboard.type('mine ');
  await expect(dirtyTab(page)).toBeVisible();
}

test('a clean open file updates when it changes on disk @G7.12', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFile(page, 'notes.txt');
  await expect(page.getByText('first line')).toBeVisible();
  await watched(relay);
  await writeOnDisk(relay, 'notes.txt', 'second line from disk\n');
  await expect(page.getByText('second line from disk')).toBeVisible();
  await expect(page.getByText(BANNER)).toBeHidden();
  await expect(dirtyTab(page)).toHaveCount(0);
});

test('an unsaved file that changes on disk is flagged @G7.13', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFile(page, 'notes.txt');
  await expect(page.getByText('first line')).toBeVisible();
  await typeIntoNotes(page);
  await watched(relay);
  await writeOnDisk(relay, 'notes.txt', 'second line from disk\n');
  await expect(page.getByText(BANNER)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep Mine', exact: true })).toBeVisible();
  await expect(page.getByText(/mine/)).toBeVisible();
  await expect(page.getByText('second line from disk')).toBeHidden();
});

test('Reload replaces my unsaved text with the disk version @G7.14', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFile(page, 'notes.txt');
  await expect(page.getByText('first line')).toBeVisible();
  await typeIntoNotes(page);
  await watched(relay);
  await writeOnDisk(relay, 'notes.txt', 'second line from disk\n');
  await expect(page.getByText(BANNER)).toBeVisible();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByText(BANNER)).toBeHidden();
  await expect(page.getByText('second line from disk')).toBeVisible();
  await expect(dirtyTab(page)).toHaveCount(0);
});

test('Keep Mine keeps my unsaved text @G7.15', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFile(page, 'notes.txt');
  await expect(page.getByText('first line')).toBeVisible();
  await typeIntoNotes(page);
  await watched(relay);
  await writeOnDisk(relay, 'notes.txt', 'second line from disk\n');
  await expect(page.getByText(BANNER)).toBeVisible();
  await page.getByRole('button', { name: 'Keep Mine', exact: true }).click();
  await expect(page.getByText(BANNER)).toBeHidden();
  await expect(page.getByText(/mine/)).toBeVisible();
  await expect(page.getByText('second line from disk')).toBeHidden();
});

test('an open image reloads after it changes on disk @G7.20', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFile(page, 'logo.svg');
  await expect(page.getByText('40 × 20')).toBeVisible();
  await watched(relay);
  const since = relay.mark();
  await writeOnDisk(relay, 'logo.svg', svg(80, 30));
  await relay.waitForEvent('file.stream', { since, match: (l) => l.status === 'ok' });
  await expect(page.getByText('80 × 30')).toBeVisible();
});

test('live file updates off for a project are announced @G7.34', async ({ eve, page, relay }) => {
  await eve.open('/');
  await openFile(page, 'notes.txt');
  await expect(page.getByText('first line')).toBeVisible();
  await watched(relay);
  const res = await relay.ctl('watch-error', '--project', 'p_acme', '--code', 'UNSUPPORTED', '--error', 'watcher stopped');
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).delivered).toBeGreaterThanOrEqual(1);
  // The reason in the toast is relay's error code.
  const toast = page.getByText(
    'Live file updates are off for this project (UNSUPPORTED). Refresh the tree to see changes.',
  );
  await expect(toast).toBeVisible();
  // The toast goes by itself; nothing is clicked. Its 8 seconds are a browser
  // timer with no hook, so the expect bound stands in for the timer.
  await expect(toast).toBeHidden({ timeout: 15000 });
});
