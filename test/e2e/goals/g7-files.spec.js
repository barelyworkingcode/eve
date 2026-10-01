// G7 · Read and edit project files. The tree lists the project, a file opens in
// the editor, Save persists it, and an outside edit is taken or flagged.
// Mirrors the devbox file-edit-save journey's steps against a fixture folder.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixture');

const EXTERNAL_BANNER = 'This file has been modified externally.';
// Longer than file-watcher.js's SELF_WRITE_TTL_MS: eve drops a change made within
// that window of its own save, taking it for the echo.
const SELF_WRITE_WINDOW_MS = 1500;

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
    const file = path.join(eve.folders.alpha, 'notes.txt');
    const appendLine = async (line) => {
      const now = fs.readFileSync(file, 'utf8');
      fs.appendFileSync(file, `${now.endsWith('\n') ? '' : '\n'}${line}\n`);
    };
    await openAlphaFiles(page);
    await page.getByTestId('file-tree-item-/notes.txt').click();
    const text = page.locator('#monacoEditor .view-lines');
    await expect(text).toContainText('first line', { timeout: 15000 });

    // Edit and save.
    await endOfFile(page, text);
    await page.keyboard.type('saved-by-editor');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 5000 }).toContain('saved-by-editor');
    await page.waitForTimeout(SELF_WRITE_WINDOW_MS);

    // A clean editor follows an outside change without asking.
    const banner = page.getByText(EXTERNAL_BANNER);
    await appendLine('outside-1');
    await expect(text).toContainText('outside-1', { timeout: 10000 });
    await expect(banner).toBeHidden();

    // A dirty editor asks; Reload takes the outside version.
    await endOfFile(page, text);
    await page.keyboard.type(' draft');
    await appendLine('outside-2');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await page.locator('.external-change-bar').getByRole('button', { name: 'Reload' }).click();
    await expect(text).toContainText('outside-2', { timeout: 10000 });
    await expect(banner).toBeHidden();
  });

  test('a file created outside appears in the open tree without a refresh', async ({ page, eve }) => {
    await openAlphaFiles(page);
    await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible();
    fs.writeFileSync(path.join(eve.folders.alpha, 'made-outside.txt'), 'x');
    await expect(page.getByTestId('file-tree-item-/made-outside.txt')).toBeVisible({ timeout: 10000 });
  });

  test('activity inside node_modules does not reach the tree or the browser', async ({ page, eve }) => {
    fs.mkdirSync(path.join(eve.folders.alpha, 'node_modules', 'pkg'), { recursive: true });
    await openAlphaFiles(page);
    await expect(page.getByTestId('file-tree-item-/node_modules')).toBeVisible();
    await page.evaluate(() => {
      window.__dirFrames = [];
      window.client.bus.on('directory:changed', (d) => window.__dirFrames.push(d.path));
    });
    fs.writeFileSync(path.join(eve.folders.alpha, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.writeFileSync(path.join(eve.folders.alpha, 'marker.txt'), 'y');
    await expect(page.getByTestId('file-tree-item-/marker.txt')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => window.__dirFrames.filter((p) => p.includes('node_modules')))).toEqual([]);
  });
});
