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
  seedTheme, stubVoiceDaemons, openSidebarIfNarrow, blurActiveElement,
  waitForSettledApp, repaintAll, settledScreenshot,
} = require('./support');

const OUT_DIR = process.env.VISUAL_MODE === 'current' ? CURRENT_DIR : BASELINE_DIR;
fs.mkdirSync(OUT_DIR, { recursive: true });

async function shoot(page, name) {
  await waitForSettledApp(page);
  // Web fonts must finish swapping or glyphs render sub-pixel shifted.
  await page.evaluate(() => document.fonts.ready);
  await repaintAll(page);
  const { buffer, captures } = await settledScreenshot(page, { name });
  if (captures > 2) console.log(`[visual] ${name}: settled after ${captures} captures`);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), buffer);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`capture ${viewport.name}/${theme}`, async ({ eve, browser }) => {
      const suffix = `${viewport.name}-${theme}`;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: !!viewport.hasTouch,
        colorScheme: theme,
      });
      await seedTheme(context, theme);
      // The Home screen greets by hour and prints today's date, and session
      // rows show "opened Nm ago" — pin the clock or the pixels drift daily.
      await context.clock.setFixedTime(new Date('2026-09-04T15:30:00'));
      await stubVoiceDaemons(context);
      await context.addInitScript({ path: path.join(__dirname, '..', 'e2e', 'hermetic-audio.js') });
      const page = await context.newPage();

      try {
        await page.goto(eve.baseUrl);
        await page.addStyleTag({ content: FREEZE_CSS });
        await expect(page.getByTestId('sidebar-project-p1')).toHaveCount(1, { timeout: 20000 });
        // Settle fonts once, up front — a font swap after Monaco's initial
        // layout pass can leave a fractional height difference that flips
        // its vertical scrollbar on or off between otherwise-identical runs.
        await page.evaluate(() => document.fonts.ready);

        // Before touching the sidebar, so mobile and ipad render their true
        // default (sheet or slide-over closed).
        await expect(page.locator('#welcomeScreen')).not.toHaveClass(/hidden/);
        await shoot(page, `welcome-${suffix}`);

        await openSidebarIfNarrow(page, viewport);
        await page.getByTestId('sidebar-project-p1').click();
        await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible({ timeout: 15000 });
        await page.getByTestId('file-tree-item-/src').click();
        await expect(page.getByTestId('file-tree-item-/src/index.js')).toBeVisible({ timeout: 15000 });
        await shoot(page, `sidebar-explorer-${suffix}`);

        await openSidebarIfNarrow(page, viewport);
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
        // The read-aloud button arrives with message_complete; shoot after it.
        await expect(messages.locator('.tts-play-btn')).toHaveCount(1, { timeout: 15000 });
        await blurActiveElement(page);
        await shoot(page, `chat-${suffix}`);

        await openSidebarIfNarrow(page, viewport);
        await page.getByTestId('sidebar-project-p1').click();
        await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible({ timeout: 15000 });
        await page.getByTestId('file-tree-item-/README.md').click();
        await page.waitForFunction(() => {
          const line = document.querySelector('#monacoEditor .view-line');
          return !!(line && line.textContent && line.textContent.trim().length > 0);
        }, { timeout: 15000 });
        // Monaco paints the text in the default foreground (mtk1) first and
        // colours it only once the markdown tokenizer has loaded, so wait for
        // any other token class before shooting.
        await page.waitForFunction(() => {
          return !!document.querySelector('#monacoEditor .view-line span[class^="mtk"]:not(.mtk1)');
        }, { timeout: 15000 });
        await blurActiveElement(page);
        await shoot(page, `file-editor-${suffix}`);

        await openSidebarIfNarrow(page, viewport);
        await page.getByTestId('sidebar-settings').click();
        const settingsDialog = page.getByTestId('dialog-settings-dialog');
        await expect(settingsDialog).toBeVisible({ timeout: 10000 });
        // SX-A1: Settings is one sheet with no tabs, so the whole sheet is shot.
        // Its Voice group reads TTSManager once at render(); stubVoiceDaemons()
        // above keeps a daemon race from changing what it shows.
        await expect(settingsDialog.getByTestId('settings-relay')).toBeVisible();
        await shoot(page, `settings-sheet-${suffix}`);
      } finally {
        await context.close();
      }
    });
  }
}
