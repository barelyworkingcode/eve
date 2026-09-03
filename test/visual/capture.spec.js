/**
 * Visual-regression capture harness.
 *
 * Boots eve via the same `eve` fixture the Playwright e2e suite uses
 * (test/e2e/fixtures.js -> test/integration/harness.js: real eve + fake relay,
 * loopback-trusted, seeded project on a real temp dir). We intentionally do
 * NOT use that file's `page` fixture — it's pinned to Desktop Chrome's
 * viewport, and this harness needs to drive several viewport/theme
 * combinations against the same eve instance, so it opens its own browser
 * contexts via the `browser` fixture instead.
 *
 * One test per (viewport, theme) combo. Each walks a FIXED, deterministic
 * sequence of UI actions to reach six surfaces — welcome screen, sidebar file
 * explorer, the new-session modal, an active chat, a file open in the editor,
 * and the settings dialog's Voice tab — screenshotting each as it goes.
 *
 * Determinism note: the fake relay assigns session ids from an in-process
 * counter starting at 0 (test/integration/fake-relay.js). Nothing here
 * relies on that counter for on-screen text — the one visible session label
 * ("<project name> - Web Chat") is assembled client-side in
 * shell-launcher-dialog.js from the project name, not the session id — but
 * keeping action order fixed matters anyway for any WS event ordering that
 * touches layout (e.g. which folder is expanded when).
 *
 * Output directory is controlled by VISUAL_MODE=baseline|current (see
 * package.json's test:visual:baseline / test:visual scripts).
 */
const { test, expect } = require('../e2e/fixtures');
const fs = require('fs');
const path = require('path');
const {
  VIEWPORTS, THEMES, BASELINE_DIR, CURRENT_DIR, FREEZE_CSS,
  seedTheme, stubTtsVoices, openSidebarIfMobile, blurActiveElement,
} = require('./support');

const OUT_DIR = process.env.VISUAL_MODE === 'current' ? CURRENT_DIR : BASELINE_DIR;
fs.mkdirSync(OUT_DIR, { recursive: true });

async function shoot(page, name) {
  // Let web fonts finish swapping and the layout settle for two paints before
  // the shutter — text (esp. Monaco's) can render with a few sub-pixel-shifted
  // glyphs if captured mid font-swap, which otherwise shows up as a handful of
  // stray diff pixels on an otherwise-identical run.
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
      await stubTtsVoices(context);
      const page = await context.newPage();

      try {
        await page.goto(eve.baseUrl);
        await page.addStyleTag({ content: FREEZE_CSS });
        await expect(page.getByTestId('sidebar-project-p1')).toHaveCount(1, { timeout: 20000 });
        // Settle fonts before anything measures text — Monaco in particular
        // takes a layout pass (line-height, scrollbar-visibility threshold)
        // as soon as it mounts, and a font swap after that pass leaves a
        // fractional height difference that can flip its vertical scrollbar
        // on or off between otherwise-identical runs. Doing this once, up
        // front, is more robust than waiting it out per-surface later.
        await page.evaluate(() => document.fonts.ready);

        // 1. Welcome / empty screen — before touching the sidebar, so mobile
        // renders its true default (drawer closed, just the hamburger).
        await expect(page.locator('#welcomeScreen')).not.toHaveClass(/hidden/);
        await shoot(page, `welcome-${suffix}`);

        // 2. Sidebar / file explorer, project expanded with a subfolder open.
        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-project-p1').click();
        await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible({ timeout: 15000 });
        await page.getByTestId('file-tree-item-/src').click();
        await expect(page.getByTestId('file-tree-item-/src/index.js')).toBeVisible({ timeout: 15000 });
        await shoot(page, `sidebar-explorer-${suffix}`);

        // 3. New-session modal (easiest modal surface).
        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-new-session-p1').click();
        const shellDialog = page.getByTestId('dialog-shell-launcher-dialog');
        await expect(shellDialog).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('shell-card-web-chat')).toBeVisible();
        await shoot(page, `modal-new-session-${suffix}`);

        // 4. Main chat screen with a user + assistant message rendered.
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

        // 5. File editor tab open on a text file.
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

        // 6. Settings dialog, Voice tab scrolled into view (the WS2 surface).
        await openSidebarIfMobile(page, viewport);
        await page.getByTestId('sidebar-settings').click();
        const settingsDialog = page.getByTestId('dialog-settings-dialog');
        await expect(settingsDialog).toBeVisible({ timeout: 10000 });
        await settingsDialog.locator('[data-tab="voice"]').click();
        const voiceTab = settingsDialog.locator('.dialog__tab-content:not(.hidden)');
        await expect(voiceTab.getByText('TTS Backend')).toBeVisible();
        // This tab's backend <select> + status line are read from TTSManager
        // once at render() time with no live re-render, so they'd freeze on
        // whatever transient state a background TTS backend race left behind
        // if one were running — stubTtsVoices() above is what keeps this
        // deterministic, by making sure no such race ever starts.
        await voiceTab.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await shoot(page, `settings-voice-${suffix}`);
      } finally {
        await context.close();
      }
    });
  }
}
