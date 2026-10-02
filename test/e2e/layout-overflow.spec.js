// S2-A6 no horizontal scroll from 320 to 1366, fine or coarse pointer, on
// Today, a chat, README.md in the editor and an image in the viewer.
const { test, expect } = require('./goals/fixture');
const { VIEWPORTS, vpName, viewport, WORLD, REPLY, openPanel, openProjectPage, overflow } = require('./layout-helpers');

test.use({ world: WORLD });

for (const vp of VIEWPORTS) {
  for (const hasTouch of [false, true]) {
    test.describe(`at ${vpName(vp)}, ${hasTouch ? 'coarse' : 'fine'} pointer`, () => {
      test.use({ viewport: viewport(vp), hasTouch });

      test('A6 Today, chat, editor and image viewer overflow nothing', async ({ page }) => {
        const found = {};
        await expect(page.getByTestId('home-session-s-reply')).toBeVisible();
        found.today = await overflow(page);

        await openPanel(page, 'files');
        await page.getByTestId('file-tree-item-/README.md').click();
        await expect(page.locator('#editor .monaco-editor')).toBeVisible();
        await expect(page.locator('#editor')).toContainText('hello from alpha');
        found.editor = await overflow(page);

        await openPanel(page, 'files');
        await page.getByTestId('file-tree-item-/photo.png').click();
        await expect(page.locator('#fileViewer')).toBeVisible();
        await expect(page.locator('#fileViewerPath')).toHaveText('/photo.png');
        found.image = await overflow(page);

        await openProjectPage(page);
        await page.getByTestId('project-thread-s-reply').click();
        await expect(page.getByTestId('messages-container')).toContainText(REPLY);
        found.chat = await overflow(page);

        expect(found).toEqual({ today: [], editor: [], image: [], chat: [] });
      });
    });
  }
}
