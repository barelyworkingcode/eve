// S6-A7 read-aloud on touch (issue #158): under a coarse pointer every assistant
// answer shows "Read aloud" with no hover, at least 44x44; a fine pointer at wide
// still reveals it on hover.
const { test, expect } = require('./fixture');
const { gotoEve } = require('../fixtures');
const { WORLD, REPLY, openThreadFromToday } = require('../layout-helpers');
const { MIN_TARGET } = require('../../../devboxverify/journey-kit');

const world = { seed: (eve) => { WORLD.seed(eve); eve.relay.setDefaultProject('work', 'alpha'); } };
const readAloud = (page) => page.getByTestId('messages-container').getByRole('button', { name: 'Read aloud' }).last();
const opacity = (loc) => loc.evaluate((el) => Number(getComputedStyle(el).opacity));
const awayFromReplies = (page) => page.mouse.move(0, 0);

const SOURCES = {
  history: { text: REPLY, open: (page) => openThreadFromToday(page) },
  live: {
    text: 'Hello from fake relay',
    open: async (page) => {
      await page.getByTestId('today-ask-input').fill('plan the week');
      await page.getByTestId('today-ask-input').press('Enter');
      await expect(page.getByTestId('messages-container')).toContainText('Hello from fake relay', { timeout: 15000 });
    },
  },
};

for (const vp of [{ name: 'regular', width: 834, height: 1194 }, { name: 'wide', width: 1366, height: 1024 }]) {
  for (const [source, { text, open }] of Object.entries(SOURCES)) {
    test.describe(`A7 touch, ${vp.name}, ${source} reply`, () => {
      test.use({ world, viewport: { width: vp.width, height: vp.height }, hasTouch: true });

      test('Read aloud shows without hover, is at least 44x44, and a tap sends tts_speak', async ({ page, eve }) => {
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        const speaks = [];
        page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
          try { const f = JSON.parse(String(payload)); if (f.type === 'tts_speak') speaks.push(f); } catch {}
        }));
        await gotoEve(page, eve.baseUrl); // the socket opened before this listener existed
        await open(page);
        await awayFromReplies(page);
        const btn = readAloud(page);
        await expect(btn).toBeInViewport();
        await expect.poll(() => opacity(btn)).toBeGreaterThanOrEqual(0.99);
        const box = await btn.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET);

        await btn.tap();
        await expect.poll(() => speaks.length).toBe(1);
        expect(speaks[0].text).toContain(text);
      });
    });
  }
}

test.describe('A7 fine pointer, wide', () => {
  test.use({ world, viewport: { width: 1366, height: 1024 } });

  test('Read aloud stays hidden until the reply is hovered', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
    await openThreadFromToday(page);
    await awayFromReplies(page);
    const btn = readAloud(page);
    await expect.poll(() => opacity(btn)).toBe(0);
    await page.getByTestId('messages-container').getByText(REPLY).hover();
    await expect.poll(() => opacity(btn)).toBeGreaterThan(0.5);
  });
});
