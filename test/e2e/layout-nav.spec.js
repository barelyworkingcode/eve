// S2-A3 Back on compact: Today -> thread -> Back (in-app or browser) is Today,
// with no hash, and the thread's tab stays open. Wide adds no history entries.
const { test, expect } = require('./goals/fixture');
const { WORLD, REPLY, hash, tabCount, openThreadFromToday } = require('./layout-helpers');

test.use({ world: WORLD, hasTouch: true });

async function expectToday(page) {
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect.poll(() => hash(page)).toBe('');
}

for (const width of [390, 320]) {
  test.describe(`compact at ${width}`, () => {
    test.use({ viewport: { width, height: width === 320 ? 568 : 844 } });

    test('A3 Continue -> thread -> Back, then browser Back and Forward', async ({ page }) => {
      await openThreadFromToday(page);
      await expect.poll(() => hash(page)).toBe('#session/s-reply');
      const tabs = await tabCount(page);
      expect(tabs).toBe(1);

      await page.getByTestId('nav-back').click();
      await expectToday(page);
      expect(await tabCount(page)).toBe(tabs);

      await openThreadFromToday(page);
      await expect.poll(() => hash(page)).toBe('#session/s-reply');
      await page.goBack();
      await expectToday(page);
      expect(await tabCount(page)).toBe(tabs);

      await page.goForward();
      await expect(page.getByTestId('messages-container')).toBeVisible();
      await expect(page.getByTestId('messages-container')).toContainText(REPLY);
      await expect.poll(() => hash(page)).toBe('#session/s-reply');
      await expect(page.getByTestId('home-screen')).toBeHidden();
    });

    test('A3 Threads -> sheet -> row -> Back', async ({ page }) => {
      await page.getByTestId('nav-threads').click();
      await page.getByTestId('sidebar-session-s-reply').click();
      await expect(page.getByTestId('messages-container')).toContainText(REPLY);
      await expect(page.getByTestId('nav-back')).toBeVisible();

      await page.getByTestId('nav-back').click();
      await expectToday(page);
      expect(await tabCount(page)).toBe(1);
    });
  });
}

test.describe('wide at 1366', () => {
  test.use({ viewport: { width: 1366, height: 1024 } });

  test('A3 opening threads and switching tabs adds no history entry', async ({ page }) => {
    const length = () => page.evaluate(() => history.length);
    const before = await length();
    await openThreadFromToday(page);
    await page.getByTestId('panel-tab-sessions').click();
    await page.getByTestId('sidebar-session-s-two').click();
    await expect.poll(() => hash(page)).toBe('#session/s-two');
    await page.getByTestId('tab-s-reply').click();
    await expect.poll(() => hash(page)).toBe('#session/s-reply');
    expect(await length()).toBe(before);
  });
});
