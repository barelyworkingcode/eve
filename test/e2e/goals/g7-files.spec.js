// G7 · Read and edit project files. The tree lists the project, a file opens in
// the editor, Save persists it, and an outside edit is taken or flagged.
// Mirrors the devbox file-edit-save journey's steps against the fake relay's
// in-memory fixture folder. Outside changes are made with `relay.files`, never
// on a real disk. Waits: a watch is live when `relay.files.watched('alpha')`
// resolves; a save is the tab's dirty marker clearing (the file_saved frame),
// then `relay.files.get`.
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');

const EXTERNAL_BANNER = 'This file has been modified externally.';

async function openAlphaFiles(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('panel-tab-files').click();
}

async function endOfFile(page, text) {
  await text.click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('ControlOrMeta+End');
}

test.describe('G7 files', () => {
  test('the tree lists the files and folders of the project, and a folder expands', async ({ page }) => {
    await openAlphaFiles(page);
    for (const entry of ['README.md', 'notes.txt', 'src']) {
      await expect(page.getByTestId(`file-tree-item-/${entry}`)).toContainText(entry);
    }
    await page.getByTestId('file-tree-item-/src').click();
    await expect(page.getByTestId('file-tree-item-/src/app.js')).toBeVisible();
  });

  test('a file opens in the editor with its contents and a tab', async ({ page }) => {
    await openAlphaFiles(page);
    await page.getByTestId('file-tree-item-/notes.txt').click();
    await expect(page.locator('#monacoEditor .view-lines')).toContainText('first line', { timeout: 15000 });
    await expect(page.getByTestId('tab-alpha:/notes.txt')).toBeVisible();
    await expect(page).toHaveURL(/#file\/alpha\//);
  });

  test('save persists, a clean editor takes an outside change, a dirty one asks and Reload takes it', async ({ page, eve }) => {
    const files = eve.relay.files;
    const current = () => files.get('alpha', 'notes.txt').toString();
    const appendLine = (line) => {
      const now = current();
      files.write('alpha', 'notes.txt', `${now}${now.endsWith('\n') ? '' : '\n'}${line}\n`);
    };
    await openAlphaFiles(page);
    await page.getByTestId('file-tree-item-/notes.txt').click();
    const text = page.locator('#monacoEditor .view-lines');
    await expect(text).toContainText('first line', { timeout: 15000 });

    // The open file is registered for watching; relay confirms the watch is live.
    await eve.relay.files.watched('alpha');

    // Edit and save. The dirty marker shows the edit landed; its removal shows
    // the save was acknowledged.
    const tab = page.getByTestId('tab-alpha:/notes.txt');
    await endOfFile(page, text);
    await page.keyboard.type('saved-by-editor');
    await expect(tab).toContainText('●');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(tab).not.toContainText('●');
    expect(current()).toContain('saved-by-editor');

    // A clean editor follows an outside change without asking. The server drops
    // only the true echo of a save, so one outside write right after the save
    // is reported.
    const banner = page.getByText(EXTERNAL_BANNER);
    files.write('alpha', 'notes.txt', 'outside-after-save\n');
    await expect(text).toContainText('outside-after-save', { timeout: 10000 });
    await expect(banner).toBeHidden();

    // A dirty editor asks; Reload takes the outside version.
    await endOfFile(page, text);
    await page.keyboard.type(' draft');
    appendLine('outside-2');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await page.locator('.external-change-bar').getByRole('button', { name: 'Reload' }).click();
    await expect(text).toContainText('outside-2', { timeout: 10000 });
    await expect(banner).toBeHidden();
  });

  test('a file created outside appears in the open tree without a refresh', async ({ page, eve }) => {
    await openAlphaFiles(page);
    await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible();
    await eve.relay.files.watched('alpha');
    eve.relay.files.write('alpha', 'made-outside.txt', 'x');
    await expect(page.getByTestId('file-tree-item-/made-outside.txt')).toBeVisible({ timeout: 10000 });
  });

  test('activity inside node_modules does not reach the tree or the browser', async ({ page, eve }) => {
    eve.relay.files.mkdir('alpha', 'node_modules/pkg', { emit: false });
    await reloadEve(page);
    await openAlphaFiles(page);
    await eve.relay.files.watched('alpha');
    await expect(page.getByTestId('file-tree-item-/node_modules')).toBeVisible();
    await page.evaluate(() => {
      window.__dirFrames = [];
      window.client.bus.on('directory:changed', (d) => window.__dirFrames.push(d.path));
    });
    eve.relay.files.write('alpha', 'node_modules/pkg/index.js', 'x');
    eve.relay.files.write('alpha', 'marker.txt', 'y');
    await expect(page.getByTestId('file-tree-item-/marker.txt')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => window.__dirFrames.filter((p) => p.includes('node_modules')))).toEqual([]);
  });
});
