const { test, expect } = require('./support/fixtures');

const PALETTE = 'Jump to a session, project, file or action…';

async function openPalette(page) {
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.getByRole('textbox', { name: PALETTE });
  await expect(box).toBeVisible();
  return box;
}

async function chooseAppearance(page, choice) {
  const box = await openPalette(page);
  await box.fill('Appearance');
  await page.getByRole('option', { name: `Appearance: ${choice}`, exact: true }).click();
  await expect(box).toBeHidden();
}

test('open the Settings sheet from the Command palette @G14.40', async ({ eve, page }) => {
  await eve.open('/');
  const box = await openPalette(page);
  await box.fill('Settings');
  await page.getByRole('option', { name: 'Settings', exact: true }).click();
  await expect(box).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

// The palette starts on Auto, so Auto is reached from another choice to show a change.
for (const [id, choice, from] of [['G14.41', 'Auto', 'Dark'], ['G14.42', 'Light', null], ['G14.43', 'Dark', null]]) {
  test(`set the appearance to ${choice} from the Command palette @${id}`, async ({ eve, page }) => {
    await eve.open('/');
    if (from) await chooseAppearance(page, from);
    await chooseAppearance(page, choice);
    const box = await openPalette(page);
    await box.fill('Appearance');
    // Every Appearance option carries the current choice as its second line.
    await expect(page.getByText(`currently ${choice.toLowerCase()}`)).toHaveCount(3);
    await expect(page.getByText(/^currently /)).toHaveCount(3);
  });
}
