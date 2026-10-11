const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const sheet = (page) => page.getByRole('dialog', { name: 'Settings' });

async function openSettings(page) {
  await rail(page).getByRole('button', { name: 'Settings' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

// An element whose background follows the appearance: the Rail. Seen values: light rgba(246, 246, 248, .72),
// dark rgba(36, 36, 38, .6). Light means every channel is 192 or more; dark means every channel is 64 or less.
const surface = (page) => page.getByRole('complementary');
const LIGHT_CH = '(?:19[2-9]|2[0-4]\\d|25[0-5])';
const DARK_CH = '(?:[0-9]|[1-5]\\d|6[0-4])';
const rgbOf = (ch) => new RegExp(`^rgba?\\(${ch}, ${ch}, ${ch}(?:, [0-9.]+)?\\)$`);
const LIGHT = rgbOf(LIGHT_CH);
const DARK = rgbOf(DARK_CH);
const expectLight = (page) => expect(surface(page)).toHaveCSS('background-color', LIGHT);
const expectDark = (page) => expect(surface(page)).toHaveCSS('background-color', DARK);

async function pick(page, name) {
  await sheet(page).getByRole('button', { name, exact: true }).click();
  await expect(sheet(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

test.describe('settings sheet', () => {
  test('open the Settings sheet from the Rail @G14.28', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    for (const name of ['Display', 'Voice', 'Modes', 'Files', 'Relay']) {
      await expect(page.getByRole('heading', { name })).toBeVisible();
    }
  });

  test('close the Settings sheet with Done @G14.29', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeHidden();
  });

  test('close the Settings sheet with Escape @G14.30', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeHidden();
  });

  test('close the Settings sheet by clicking outside it @G14.31', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    const box = await sheet(page).boundingBox();
    await page.mouse.click(box.x - 20, box.y + box.height / 2);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeHidden();
  });

  test('Auto follows the system setting and is kept @G14.32', async ({ eve, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await eve.open('/');
    await openSettings(page);
    await pick(page, 'Light');
    await expectLight(page);
    await pick(page, 'Auto');
    // Auto under a dark system is the dark appearance; under a light system it is the light one.
    await expectDark(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expectLight(page);
    await eve.reload();
    await openSettings(page);
    await expect(sheet(page).getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectDark(page);
  });

  test('use the light appearance and keep it @G14.33', async ({ eve, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await eve.open('/');
    await expectDark(page);
    await openSettings(page);
    await pick(page, 'Light');
    await expectLight(page);
    await eve.reload();
    await expectLight(page);
    await openSettings(page);
    await expect(sheet(page).getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('use the dark appearance and keep it @G14.34', async ({ eve, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await eve.open('/');
    await expectLight(page);
    await openSettings(page);
    await pick(page, 'Dark');
    await expectDark(page);
    await eve.reload();
    await expectDark(page);
    await openSettings(page);
    await expect(sheet(page).getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  // The slider runs 10 to 20 and the text size follows it exactly, so the size is `<N>px`.
  test('make text bigger or smaller @G14.35', async ({ eve, page }) => {
    await eve.open('/');
    const note = page.getByRole('main');
    await openSettings(page);
    const slider = sheet(page).getByRole('slider', { name: 'Text size' });
    await slider.fill('20');
    await expect(sheet(page).getByText('20', { exact: true })).toBeVisible();
    await expect(note).toHaveCSS('font-size', '20px');
    await slider.fill('10');
    await expect(sheet(page).getByText('10', { exact: true })).toBeVisible();
    await expect(note).toHaveCSS('font-size', '10px');
  });

  // The size is saved a moment after the change, so a person who pauses before reloading keeps it:
  // the browser clock moves on by a second instead of waiting.
  test('the text size is kept after a reload @G14.35', async ({ eve, page }) => {
    await page.clock.install();
    await eve.open('/');
    const note = page.getByRole('main');
    await openSettings(page);
    const slider = sheet(page).getByRole('slider', { name: 'Text size' });
    await slider.fill('20');
    await expect(note).toHaveCSS('font-size', '20px');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(sheet(page)).toBeHidden();
    await page.clock.fastForward('00:01');
    await eve.reload();
    await expect(note).toHaveCSS('font-size', '20px');
    await openSettings(page);
    await expect(slider).toHaveValue('20');
  });

  test('the picked voice is kept after a reload @G14.36', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    const voices = sheet(page).getByRole('combobox', { name: 'Voice' });
    await expect(voices.getByRole('option', { name: 'George' })).toHaveCount(1);
    await expect(voices.getByRole('option', { name: 'George', selected: false })).toHaveCount(1);
    await voices.selectOption({ label: 'George' });
    await expect(voices.getByRole('option', { name: 'George', selected: true })).toHaveCount(1);
    await eve.reload();
    await openSettings(page);
    await expect(sheet(page).getByRole('combobox', { name: 'Voice' }).getByRole('option', { name: 'George', selected: true })).toHaveCount(1);
  });

  test.describe('voice view', () => {
    test.use({ mic: 'silence' });

    test('the voice choice is shared with the voice drawer @G14.36', async ({ eve, page }) => {
      await eve.open('/');
      await openSettings(page);
      const voices = sheet(page).getByRole('combobox', { name: 'Voice' });
      await expect(voices.getByRole('option', { name: 'George' })).toHaveCount(1);
      await voices.selectOption({ label: 'George' });
      await expect(voices.getByRole('option', { name: 'George', selected: true })).toHaveCount(1);
      await page.getByRole('button', { name: 'Done' }).click();
      await page.getByRole('button', { name: 'Voice', exact: true }).click();
      const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
      await launcher.getByRole('combobox', { name: 'Model' }).selectOption('haiku');
      await launcher.getByRole('button', { name: 'Start Voice Chat' }).click();
      await expect(page.getByRole('button', { name: 'Voice controls' })).toBeVisible();
      await page.getByRole('button', { name: 'Voice controls' }).click();
      await expect(page.getByRole('combobox', { name: 'Voice' }).getByRole('option', { name: 'George', selected: true })).toHaveCount(1);
    });
  });

  test('pick the speed replies are read at @G14.37', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    const speed = sheet(page).getByRole('combobox', { name: 'Speed' });
    for (const label of ['0.75×', '0.9×', '1×', '1.1×', '1.25×', '1.5×']) {
      await expect(speed.getByRole('option', { name: label, exact: true })).toHaveCount(1);
    }
    await speed.selectOption({ label: '1.25×' });
    await expect(speed.getByRole('option', { name: '1.25×', exact: true, selected: true })).toHaveCount(1);
  });

  test('read where models, tools, hosts and permissions are set @G14.39', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    await expect(sheet(page).getByText('Models, tools, hosts and permissions live in Relay on your Mac.')).toBeVisible();
  });
});

function modesWorld() {
  const w = worlds.base();
  w.projects.push({ id: 'p_harbor', name: 'Harbor', mode: 'home', files: { 'NOTES.md': '# Harbor\n' } });
  w.default_project = { home: 'p_harbor', work: 'p_acme' };
  w.projects[0].chat_templates = [
    { id: 'ct_ask', name: 'Quick ask', model: 'haiku', mode: 'default', voice: false, system_prompt: '', preset_for: ['work'] },
    { id: 'ct_voice', name: 'Talk it over', model: 'haiku', mode: 'voice', voice: true, system_prompt: '', preset_for: ['work'] },
  ];
  return w;
}

test.describe('modes with defaults', () => {
  test.use({ world: modesWorld() });

  test('read which project each mode starts in and its presets @G14.38', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    await expect(sheet(page).getByText('Home starts in Harbor')).toBeVisible();
    await expect(sheet(page).getByText('Work starts in Acme')).toBeVisible();
    await expect(sheet(page).getByText('Ask: Quick ask · Voice: Talk it over')).toBeVisible();
  });
});

test.describe('modes without a home default', () => {
  test('a mode with no default says so @G14.38', async ({ eve, page }) => {
    await eve.open('/');
    await openSettings(page);
    await expect(sheet(page).getByText('Home: no default. Ask lets you pick.')).toBeVisible();
    await expect(sheet(page).getByText('Work starts in Acme')).toBeVisible();
  });
});
