// S2-A5 front door: 60 minutes or more away (or never stamped) opens Today with
// Ask focused and no tabs; otherwise tabs restore; a deep link still wins; a
// page resumed after an hour shows Today and keeps its tabs.
// Pages come from `context`, not the fixture's `page`, which would load (and
// stamp) before the seed is in place.
const { test, expect } = require('./goals/fixture');
const { gotoEve } = require('./fixtures');
const { WORLD, REPLY, tabCount, openThreadFromToday } = require('./layout-helpers');

const MIN = 60000;
test.use({ world: WORLD });

// minutesAgo null leaves eve-last-active unset.
async function open(context, eve, { minutesAgo, storedTabs = false, hash = '' }) {
  const page = await context.newPage();
  await page.addInitScript(({ minutesAgo, storedTabs, MIN }) => {
    const now = Date.now();
    if (minutesAgo !== null) localStorage.setItem('eve-last-active', String(now - minutesAgo * MIN));
    if (storedTabs) {
      localStorage.setItem('eve-open-sessions', JSON.stringify({ 's-reply': now }));
      localStorage.setItem('eve-open-files', JSON.stringify({ 'alpha:/README.md': { projectId: 'alpha', path: '/README.md', ts: now } }));
    }
  }, { minutesAgo, storedTabs, MIN });
  await gotoEve(page, `${eve.baseUrl}/${hash}`);
  return page;
}

const stored = (page) => page.evaluate(() => ({
  sessions: localStorage.getItem('eve-open-sessions'),
  files: localStorage.getItem('eve-open-files'),
  stamp: Number(localStorage.getItem('eve-last-active')),
  now: Date.now(),
}));

async function expectTodayNoTabs(page) {
  await expect(page.getByTestId('home-session-s-reply')).toBeVisible();
  await expect(page.getByTestId('today-ask-input')).toBeFocused();
  // The restore runs once sessions load; give it time to (wrongly) open a tab.
  await page.waitForTimeout(1000);
  expect(await tabCount(page)).toBe(0);
  await expect(page.getByTestId('home-screen')).toBeVisible();
}

test('A5 away 61 minutes: Today, Ask focused, no tab, both stored keys gone, stamped now', async ({ context, eve }) => {
  const page = await open(context, eve, { minutesAgo: 61, storedTabs: true });
  await expectTodayNoTabs(page);
  const s = await stored(page);
  expect(s.sessions).toBeNull();
  expect(s.files).toBeNull();
  expect(s.now - s.stamp).toBeLessThan(MIN);
});

test('A5 away 59 minutes: the stored thread restores', async ({ context, eve }) => {
  const page = await open(context, eve, { minutesAgo: 59, storedTabs: true });
  await expect(page.getByTestId('tab-s-reply')).toBeVisible({ timeout: 15000 });
});

test('A5 no stamp counts as away: Today, no tab', async ({ context, eve }) => {
  const page = await open(context, eve, { minutesAgo: null, storedTabs: true });
  await expectTodayNoTabs(page);
});

test('A5 away 61 minutes with #session/<id>: the deep link opens the thread', async ({ context, eve }) => {
  const page = await open(context, eve, { minutesAgo: 61, hash: '#session/s-reply' });
  await expect(page.getByTestId('messages-container')).toContainText(REPLY, { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe('s-reply');
});

// Headless Chromium never hides a page, so visibility is driven by hand.
for (const vp of [{ width: 1280, height: 720 }, { width: 390, height: 844, hasTouch: true }]) {
  test.describe(`resume at ${vp.width}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.hasTouch });

    test('A5 a page resumed after 61 minutes shows Today with Ask focused and keeps the tab', async ({ context, eve }) => {
      const page = await context.newPage();
      await page.clock.install();
      await gotoEve(page, eve.baseUrl);
      await openThreadFromToday(page);
      await page.evaluate(() => {
        let state = 'visible';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
        window.__setVisibility = (s) => { state = s; document.dispatchEvent(new Event('visibilitychange')); };
      });

      await page.evaluate(() => window.__setVisibility('hidden'));
      await page.clock.fastForward(61 * MIN);
      await page.evaluate(() => window.__setVisibility('visible'));

      await expect(page.getByTestId('home-screen')).toBeVisible();
      if (vp.hasTouch) await expect(page.getByTestId('bottom-bar')).toBeVisible();
      expect(await tabCount(page)).toBe(1);
      const s = await stored(page);
      expect(s.now - s.stamp).toBeLessThan(MIN);
      await expect(page.getByTestId('today-ask-input')).toBeFocused();
    });
  });
}
