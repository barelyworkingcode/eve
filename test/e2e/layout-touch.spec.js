// S2-A2 thumb-sized: under a coarse pointer, the contract's sweep finds no
// control below 44x44 on Today, the sidebar, the project page, a chat or the
// terminal keybar.
const { test, expect } = require('./goals/fixture');
const { VIEWPORTS, vpName, viewport, WORLD, REPLY, openPanel, sweep } = require('./layout-helpers');

test.use({ world: WORLD, hasTouch: true });

for (const vp of VIEWPORTS) {
  test.describe(`at ${vpName(vp)}`, () => {
    test.use({ viewport: viewport(vp) });

    test('A2 Today, sidebar Files, the project page, and a chat with a reply have no target under 44x44', async ({ page }) => {
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      const found = {};
      await expect(page.getByTestId('home-session-s-reply')).toBeVisible();
      found.today = await sweep(page);

      await openPanel(page, 'files');
      await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible();
      found.files = await sweep(page);

      await page.getByTestId('panel-project-page').click();
      await expect(page.getByTestId('project-thread-s-reply')).toBeVisible();
      found.sessions = await sweep(page);

      await page.getByTestId('project-thread-s-reply').click();
      await expect(page.getByTestId('messages-container')).toContainText(REPLY);
      if (vp.layout !== 'wide') await expect(page.locator('#sidebarRail')).not.toBeInViewport();
      found.chat = await sweep(page);

      expect(found).toEqual({ today: [], files: [], sessions: [], chat: [] });
    });

    test('A2 an expanded terminal keybar has no target under 44x44', async ({ page }) => {
      await openPanel(page, 'files');
      await page.getByTestId('sidebar-new-session-alpha').click();
      const dialog = page.getByTestId('dialog-shell-launcher-dialog');
      await expect(dialog.getByText('Loading terminal templates…')).toHaveCount(0);
      await dialog.getByRole('button', { name: /Shell/ }).first().click();
      await expect(page.locator('#terminal')).toBeVisible();

      const expand = page.getByRole('button', { name: 'More keys' }).filter({ visible: true });
      await expand.click();
      await expect(expand).toHaveClass(/terminal-keybar__expand--open/);
      expect(await sweep(page)).toEqual([]);
    });
  });
}
