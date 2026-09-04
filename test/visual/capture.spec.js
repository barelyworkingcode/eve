/**
 * Visual-regression capture harness. Uses the `eve` fixture but not its
 * `page` fixture — that's pinned to Desktop Chrome's viewport, and this
 * harness needs several viewport/theme combos against the same eve
 * instance, so it opens its own browser contexts via `browser` instead.
 *
 * The on-screen session label is assembled client-side from the project
 * name, not the fake relay's session-id counter, so nothing here depends on
 * that counter — but action order stays fixed anyway, since WS event
 * ordering can still affect layout (e.g. which folder is expanded).
 *
 * Output directory is controlled by VISUAL_MODE=baseline|current.
 */
const { test, expect } = require('../e2e/fixtures');
const fs = require('fs');
const path = require('path');
const {
  VIEWPORTS, THEMES, BASELINE_DIR, CURRENT_DIR, FREEZE_CSS,
  seedTheme, stubVoiceDaemons, openSidebarIfMobile, blurActiveElement,
} = require('./support');

const OUT_DIR = process.env.VISUAL_MODE === 'current' ? CURRENT_DIR : BASELINE_DIR;
fs.mkdirSync(OUT_DIR, { recursive: true });

async function shoot(page, name) {
  // Let web fonts finish swapping and layout settle for two paints before
  // the shutter, or text can render with sub-pixel-shifted glyphs mid
  // font-swap, showing up as stray diff pixels on an otherwise-identical run.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true, animations: 'disabled' });
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`capture ${viewport.name}/${theme}`, async ({ eve, browser }) => {
      const suffix = `${viewport.name}-${theme}`;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
      });
      await seedTheme(context, theme);
      await stubVoiceDaemons(context);
      const page = await context.newPage();

      try {
        await page.goto(eve.baseUrl);
        await page.addStyleTag({ content: FREEZE_CSS });
        await expect(page.getByTestId('sidebar-project-p1')).toHaveCount(1, { timeout: 20000 });
        // Settle fonts once, up front — a font swap after Monaco's initial
        // layout pass can leave a fractional height difference that flips
        // its vertical scrollbar on or off between otherwise-identical runs.
        await page.evaluate(() => document.fonts.ready);

        // Before touching the sidebar, so mobile renders its true default
        // (drawer closed, just the hamburger).
        await expect(page.locator('#welcomeScreen')).not.toHaveClass(/hidden/);
        await shoot(page, `welcome-${suffix}`);

        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-project-p1').click();
        await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible({ timeout: 15000 });
        await page.getByTestId('file-tree-item-/src').click();
        await expect(page.getByTestId('file-tree-item-/src/index.js')).toBeVisible({ timeout: 15000 });
        await shoot(page, `sidebar-explorer-${suffix}`);

        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-new-session-p1').click();
        const shellDialog = page.getByTestId('dialog-shell-launcher-dialog');
        await expect(shellDialog).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('shell-card-web-chat')).toBeVisible();
        await shoot(page, `modal-new-session-${suffix}`);

        await page.getByTestId('shell-card-web-chat').click();
        await page.getByRole('button', { name: 'Start Chat' }).click();
        const input = page.getByTestId('chat-input');
        await expect(input).toBeVisible({ timeout: 15000 });
        await input.fill('hello there');
        await page.getByTestId('chat-submit').click();
        const messages = page.getByTestId('messages-container');
        await expect(messages).toContainText('hello there');
        await expect(messages).toContainText('Hello from fake relay', { timeout: 15000 });
        await blurActiveElement(page);
        await shoot(page, `chat-${suffix}`);

        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-project-p1').click();
        await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible({ timeout: 15000 });
        await page.getByTestId('file-tree-item-/README.md').click();
        await page.waitForFunction(() => {
          const line = document.querySelector('#monacoEditor .view-line');
          return !!(line && line.textContent && line.textContent.trim().length > 0);
        }, { timeout: 15000 });
        await blurActiveElement(page);
        await shoot(page, `file-editor-${suffix}`);

        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-settings').click();
        const settingsDialog = page.getByTestId('dialog-settings-dialog');
        await expect(settingsDialog).toBeVisible({ timeout: 10000 });
        await settingsDialog.locator('[data-tab="voice"]').click();
        const voiceTab = settingsDialog.locator('.dialog__tab-content:not(.hidden)');
        await expect(voiceTab.getByText('TTS Backend')).toBeVisible();
        // This tab reads TTSManager once at render() with no live re-render,
        // so it would freeze on whatever transient state a daemon race left
        // behind — stubVoiceDaemons() above ensures no such race starts.
        await voiceTab.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await shoot(page, `settings-voice-${suffix}`);
      } finally {
        await context.close();
      }
    });
  }
}
