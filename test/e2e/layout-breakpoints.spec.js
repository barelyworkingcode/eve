// S2-A1 three layouts and S2-A4 the wordmark, per width (docs/design-today-s2.md).
const { test, expect } = require('./goals/fixture');
const { VIEWPORTS, vpName, viewport, WORLD, layoutOf, openThreadFromToday } = require('./layout-helpers');

test.use({ world: WORLD, hasTouch: true });

for (const vp of VIEWPORTS) {
  test.describe(`at ${vpName(vp)}`, () => {
    test.use({ viewport: viewport(vp) });

    test(`A1 ${vp.layout}: data-layout, sidebar, main area, tab bar`, async ({ page }) => {
      expect(await layoutOf(page)).toBe(vp.layout);
      const rail = page.locator('#sidebarRail');

      if (vp.layout === 'wide') {
        await expect(rail).toBeInViewport();
      } else if (vp.layout === 'regular') {
        await expect(page.getByTestId('home-screen')).toBeVisible();
        await expect(rail).not.toBeInViewport();
        const main = await page.locator('.main').boundingBox();
        const home = await page.locator('#homeContent').boundingBox();
        expect(main.width).toBeCloseTo(vp.width, 0);
        expect(home.width).toBeLessThanOrEqual(720);
        expect(Math.abs((home.x - main.x) - (main.x + main.width - home.x - home.width))).toBeLessThanOrEqual(2);

        await page.getByTestId('welcome-sidebar-open').click();
        await expect(rail).toBeInViewport();
        await expect(page.getByTestId('sidebar-scrim')).toBeVisible();
        await page.getByTestId('sidebar-scrim').click({ position: { x: vp.width - 20, y: vp.height / 2 } });
        await expect(rail).not.toBeInViewport();
      } else {
        await expect(page.getByTestId('bottom-bar')).toBeVisible();
        for (const id of ['nav-chief-of-staff', 'nav-today', 'nav-threads', 'nav-projects']) await expect(page.getByTestId(id)).toBeVisible();
      }

      await openThreadFromToday(page);
      if (vp.layout === 'compact') {
        await expect(page.getByTestId('tab-bar')).toBeHidden();
        await expect(page.getByTestId('bottom-bar')).toBeHidden();
      } else {
        await expect(page.getByTestId('tab-s-reply')).toBeVisible();
      }
    });

    test('A4 one wordmark, in its slot, reading Home|Work; Home flips aria-checked', async ({ page }) => {
      const slot = vp.layout === 'wide' ? 'sidebar' : 'today';
      await expect(page.getByTestId('mode-switch')).toHaveCount(1);
      const sw = page.locator(`[data-wordmark-slot="${slot}"] [data-testid="mode-switch"]`);
      await expect(sw).toBeVisible();
      expect((await sw.textContent()).replace(/\s+/g, '')).toBe('Home|Work');

      await page.getByTestId('mode-home').click();
      await expect(page.getByTestId('mode-home')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'false');
    });
  });
}

test.describe('resizing across a breakpoint', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('A1 1024->1023 and 600->599 each flip data-layout with one LAYOUT_CHANGED', async ({ page }) => {
    await page.evaluate(() => {
      window.__layoutEvents = [];
      window.client.bus.on(EVT.LAYOUT_CHANGED, (e) => window.__layoutEvents.push(e));
    });
    const events = () => page.evaluate(() => window.__layoutEvents);
    const steps = [[1023, 'regular', 1], [600, 'regular', 1], [599, 'compact', 2]];
    for (const [width, layout, count] of steps) {
      await page.setViewportSize({ width, height: 768 });
      await expect.poll(() => layoutOf(page)).toBe(layout);
      await expect.poll(async () => (await events()).length).toBe(count);
    }
    expect(await events()).toEqual([
      { name: 'regular', previous: 'wide', coarse: true },
      { name: 'compact', previous: 'regular', coarse: true },
    ]);
  });
});
