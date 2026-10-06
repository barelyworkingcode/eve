// Ask does not take focus on a coarse pointer, so the soft keyboard stays down
// and all of Today shows; a tap on the box focuses it. Fine pointers keep S1-A1.
// Issue #129; docs/design-today-s1.md A1.
const { test, expect } = require('./fixture');
const { WORLD } = require('../layout-helpers');

const ask = (page) => page.getByTestId('today-ask-input');

test.describe('touch: Ask is not focused', () => {
  test.use({ world: WORLD, viewport: { width: 390, height: 844 }, hasTouch: true });

  test('fresh open: Today shows and the Ask textarea is not the active element', async ({ page }) => {
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(ask(page)).toBeVisible();
    await expect(ask(page)).not.toBeFocused();
  });

  test('a tap on the box focuses it', async ({ page }) => {
    await expect(ask(page)).toBeVisible();
    await ask(page).tap();
    await expect(ask(page)).toBeFocused();
  });
});

test.describe('fine pointer: Ask is focused as before', () => {
  test.use({ world: WORLD, viewport: { width: 1280, height: 720 } });

  test('fresh open focuses Ask', async ({ page }) => {
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(ask(page)).toBeFocused();
  });
});
