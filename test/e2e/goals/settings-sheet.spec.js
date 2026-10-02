// Settings is one short sheet: Display, Voice, Modes, Files, then a line that
// points to Relay. Admin settings live in Relay, not here.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixture');
const { nav } = require('./today-helpers');
const { openSidebar } = require('../layout-helpers');

const RELAY_TEXT = 'Models, tools, hosts and permissions live in Relay on your Mac.';
const SPEEDS = ['0.75', '0.9', '1', '1.1', '1.25', '1.5'];
const sheetOf = (page) => page.getByTestId('dialog-settings-dialog');

async function openSheet(page) {
  await page.getByTestId('sidebar-settings').click();
  await expect(sheetOf(page)).toBeVisible();
  return sheetOf(page);
}

// Settings are saved on a short debounce; a person does not reload inside it.
const saved = (page, key) => expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem('eve-settings') || '{}')[k], key));

const testids = (scope, selector) => scope.locator(selector).evaluateAll((els) => els.map((e) => e.dataset.testid));

test.describe('settings sheet', () => {
  test('one sheet with no tabs: Display, Voice, Modes, Files, then the Relay line; Done and Escape close it', async ({ page }) => {
    const sheet = await openSheet(page);
    await expect(sheet.getByText('Settings', { exact: true })).toBeVisible();
    await expect(sheet.locator('.dialog__tab')).toHaveCount(0);
    const headings = await sheet.getByRole('heading').allTextContents();
    const at = ['Display', 'Voice', 'Modes', 'Files'].map((g) => headings.indexOf(g));
    expect(at.every((i) => i >= 0) && at.every((i, n) => n === 0 || i > at[n - 1])).toBe(true);
    const relay = sheet.getByTestId('settings-relay');
    await expect(relay).toHaveText(RELAY_TEXT);
    await expect(relay.locator('button, a, input, select')).toHaveCount(0);
    const filesFirst = await sheet.getByRole('heading', { name: 'Files', exact: true })
      .evaluate((h, r) => !!(h.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING), await relay.elementHandle());
    expect(filesFirst).toBe(true);
    await sheet.getByTestId('settings-done').click();
    await expect(sheet).toBeHidden();

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('Settings');
    await page.getByTestId('palette-item').filter({ hasText: /^Settings/ }).first().click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('in a browser it offers only the voice and speed selects; palettes, fonts, prompt tags, Reset and engine text are gone', async ({ page }) => {
    const sheet = await openSheet(page);
    expect(await testids(sheet, 'select')).toEqual(['settings-voice', 'settings-voice-speed']);
    await expect(sheet.locator('input:not([type=range]):not([type=checkbox])')).toHaveCount(0);
    await expect(sheet.getByText(/Dark themes|Light themes|UI Font|Terminal Font|Prompt Tag|Reset to Defaults|Backend|Qwen3|Kokoro|Whisper/)).toHaveCount(0);
  });

  test.describe('with a dark system scheme', () => {
    test.use({ colorScheme: 'dark' });

    test('Light and text size 16 apply at once and survive a reload', async ({ page }) => {
      const rootFont = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--root-font-size').trim());
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await rootFont()).not.toBe('16px');
      let sheet = await openSheet(page);
      await sheet.getByTestId('settings-appearance-light').click();
      await sheet.getByTestId('settings-text-size').fill('16');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect.poll(rootFont).toBe('16px');
      await saved(page, 'fontSize').toBe(16);

      await page.reload();
      await page.waitForFunction(() => !!window.client?.state);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect.poll(rootFont).toBe('16px');
      sheet = await openSheet(page);
      const pressed = await Promise.all(['auto', 'light', 'dark'].map((m) => sheet.getByTestId(`settings-appearance-${m}`).getAttribute('aria-pressed')));
      expect(pressed).toEqual(['false', 'true', 'false']);
      await expect(sheet.getByTestId('settings-text-size')).toHaveValue('16');
      await expect(sheet.getByTestId('settings-text-size')).toHaveAttribute('min', '10');
      await expect(sheet.getByTestId('settings-text-size')).toHaveAttribute('max', '20');
    });
  });

  test('voice and speed are stored and the composer\'s selects follow with no reload', async ({ page }) => {
    await expect.poll(() => page.locator('#voiceSelect option').count()).toBeGreaterThan(1);
    const sheet = await openSheet(page);
    const voice = sheet.getByTestId('settings-voice');
    const speed = sheet.getByTestId('settings-voice-speed');
    expect(await speed.locator('option').evaluateAll((os) => os.map((o) => o.value))).toEqual(SPEEDS);
    const current = await voice.inputValue();
    const target = (await voice.locator('option').evaluateAll((os) => os.map((o) => o.value))).find((v) => v !== current);
    await voice.selectOption(target);
    await speed.selectOption('1.25');
    expect(await page.evaluate(() => [localStorage.getItem('eve-voice-preset'), Number(localStorage.getItem('eve-voice-speed'))]))
      .toEqual([target, 1.25]);
    await expect(page.locator('#voiceSelect')).toHaveValue(target);
    await expect(page.locator('#voiceSpeedSelect')).toHaveValue('1.25');
    await expect(page.locator('#voiceChatSpeedSelect')).toHaveValue('1.25');
  });

  test.describe('with Beta as Work\'s default and no Home default', () => {
    test.use({ world: { seed: ({ relay }) => relay.setDefaultProject('work', 'beta') } });

    test('Modes names the project each mode starts in, or says Ask lets you pick', async ({ page }) => {
      const sheet = await openSheet(page);
      await expect(sheet.getByTestId('settings-default-work')).toHaveText('Work starts in Beta Project');
      await expect(sheet.getByTestId('settings-default-home')).toHaveText('Home: no default. Ask lets you pick.');
    });
  });

  test.describe('with a dotfile in Alpha', () => {
    test.use({ world: { seed: ({ folders }) => fs.writeFileSync(path.join(folders.alpha, '.acme-env'), 'x=1\n') } });

    test('Show hidden files persists and the dotfile shows in the tree', async ({ page }) => {
      const openFiles = async () => {
        await nav(page).getByTitle('Alpha Project', { exact: true }).click();
        await page.getByTestId('panel-tab-files').click();
        await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible();
      };
      await openFiles();
      await expect(page.getByTestId('file-tree-item-/.acme-env')).toHaveCount(0);
      const sheet = await openSheet(page);
      await expect(sheet.getByTestId('settings-hidden-files')).not.toBeChecked();
      await sheet.getByTestId('settings-hidden-files').check();
      await sheet.getByTestId('settings-done').click();
      await saved(page, 'showHiddenFiles').toBe(true);

      await page.reload();
      await page.waitForFunction(() => !!window.client?.state);
      await openFiles();
      await expect(page.getByTestId('file-tree-item-/.acme-env')).toBeVisible();
      await expect((await openSheet(page)).getByTestId('settings-hidden-files')).toBeChecked();
    });
  });
});

test.describe('settings sheet in the native app', () => {
  // IS_NATIVE_APP reads this at load. The default backend stays "server", so
  // nothing calls into the stub plugin.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true, Plugins: { EveVoice: {} }, nativePromise: () => Promise.reject(new Error('no device')) };
    });
  });

  test('shows the speech and dictation engine pickers', async ({ page }) => {
    const sheet = await openSheet(page);
    expect(await testids(sheet, 'select')).toEqual(['settings-voice', 'settings-voice-speed', 'settings-tts-engine', 'settings-stt-engine']);
  });
});

test.describe('settings sheet on a touch iPad', () => {
  test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true });

  test('every visible control is at least 44x44', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await openSidebar(page);
    const sheet = await openSheet(page);
    // Measure the sheet at rest: while it slides in, nothing is visible yet.
    await sheet.evaluate((root) => Promise.all(root.getAnimations({ subtree: true }).map((a) => a.finished)));
    // A checkbox's touch target is its whole label row (decision 10).
    const sizes = await sheet.evaluate((root) => [...root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=switch]')]
      .filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      .map((el) => {
        const r = (el.closest('.dialog__checkbox-row') || el).getBoundingClientRect();
        return { id: el.dataset.testid || (el.textContent || '').trim().slice(0, 20), w: r.width, h: r.height };
      }));
    expect(sizes.map((s) => s.id)).toEqual(expect.arrayContaining(['settings-done', 'settings-appearance-auto', 'settings-text-size', 'settings-voice', 'settings-hidden-files']));
    expect(sizes.filter((s) => s.w < 43.99 || s.h < 43.99).map((s) => `${s.id} ${s.w.toFixed(1)}x${s.h.toFixed(1)}`)).toEqual([]);
  });
});
