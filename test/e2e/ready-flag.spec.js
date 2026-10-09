// <html data-ready="1"> marks a finished boot, and gotoEve/reloadEve wait on it.
const base = require('@playwright/test');
const { startEve } = require('../integration/harness');
const { hermeticTest, gotoEve, reloadEve } = require('./fixtures');

const { expect } = base;
const SID = 's-ready';

const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const dir = '/work/acme'; // a neutral path; no file is read in this spec
    const eve = await startEve({ projects: [{ id: 'p1', name: 'Acme', path: dir }] });
    eve.relay.seedSession({
      sessionId: SID, directory: dir, projectId: 'p1', model: 'chat-a', name: 'Ready Chat', createdAt: new Date().toISOString(),
    });
    try { await use(eve); } finally { await eve.stop(); }
  },

  // No pre-navigated page: each test drives the first navigation itself.
  page: async ({ page }, use) => {
    await page.addInitScript((sid) => {
      localStorage.setItem('eve-open-sessions', JSON.stringify({ [sid]: Date.now() }));
      localStorage.setItem('eve-last-active', String(Date.now()));
      window.__sent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        window.__sent.push(data);
        return send.call(this, data);
      };
      // Records the app's state at the instant the flag first appears.
      new MutationObserver(() => {
        if (window.__atReady || document.documentElement.dataset.ready !== '1') return;
        const c = window.client;
        window.__atReady = {
          hasSession: !!c?.sessions?.has(sid),
          tabIds: (c?.tabManager?.tabs || []).map((t) => t.id),
          joinIds: window.__sent.map((d) => { try { return JSON.parse(d); } catch { return {}; } })
            .filter((f) => f.type === 'join_session').map((f) => f.sessionId),
        };
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-ready'] });
    }, SID);
    await use(page);
  },
});

// Holds GET /api/sessions until released; `hit` resolves when the request arrives.
async function holdSessions(page) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let signalHit;
  const hit = new Promise((r) => { signalHit = r; });
  const pattern = /\/api\/sessions(\?|$)/;
  await page.route(pattern, async (route) => {
    signalHit();
    await gate;
    await route.continue();
  });
  return { hit, release, done: () => page.unroute(pattern) };
}

const flag = (page) => page.evaluate(() => document.documentElement.dataset.ready ?? null);

// Drives a navigation while sessions are held; asserts the flag is absent until
// release and that everything the criteria name is in place when it appears.
async function expectReadyOnlyAfterBoot(page, navigate) {
  const held = await holdSessions(page);
  let returned = false;
  const nav = navigate().then(() => { returned = true; });
  await held.hit;
  expect(await flag(page)).toBeNull();
  expect(returned).toBe(false);
  held.release();
  await nav;
  await held.done();

  expect(await flag(page)).toBe('1');
  expect(await page.evaluate((sid) => window.client.sessions.has(sid), SID)).toBe(true);
  const atReady = await page.evaluate(() => window.__atReady);
  expect(atReady.hasSession).toBe(true);
  expect(atReady.joinIds).toContain(SID);
  expect(atReady.tabIds).toContain('project:p1');
}

test.describe('ready flag', () => {
  test('gotoEve returns only after sessions loaded, tabs restored and the hash handled', async ({ page, eve }) => {
    await expectReadyOnlyAfterBoot(page, () => gotoEve(page, `${eve.baseUrl}/#project/p1`));
  });

  test('reloadEve reloads, then returns only after the same boot work', async ({ page, eve }) => {
    await gotoEve(page, eve.baseUrl);
    // The restored session's join reply lands after the flag and activates its
    // tab; wait for it, or it can take the tab back from the hash below.
    await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe('s-ready');
    // The URL keeps the hash across the reload, so the reload has one to handle.
    await page.evaluate(() => { window.location.hash = '#project/p1'; });
    await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe('project:p1');
    await expectReadyOnlyAfterBoot(page, () => reloadEve(page));
  });

  test('the flag adds no text, element or style', async ({ page, eve }) => {
    await gotoEve(page, eve.baseUrl);
    const snapshot = () => page.evaluate(() => new Promise((resolve) => {
      const css = (el) => { const s = getComputedStyle(el); return Array.from(s, (p) => `${p}:${s.getPropertyValue(p)}`).join(';'); };
      // Two frames: any style the flag toggles has been applied by then.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        text: document.body.innerText,
        count: document.getElementsByTagName('*').length,
        html: css(document.documentElement),
        body: css(document.body),
      })));
    }));
    const withFlag = await snapshot();
    await page.evaluate(() => { delete document.documentElement.dataset.ready; });
    const withoutFlag = await snapshot();
    await page.evaluate(() => { document.documentElement.dataset.ready = '1'; });
    expect(withoutFlag).toEqual(withFlag);

    const selectors = await page.evaluate(() => {
      const found = [];
      const walk = (rules) => {
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('data-ready')) found.push(r.selectorText);
          if (r.cssRules) walk(r.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
        walk(rules);
      }
      return found;
    });
    expect(selectors).toEqual([]);
  });

  test('a boot whose relay is unreachable still sets the flag', async ({ page, eve }) => {
    await eve.relay.close();
    await gotoEve(page, eve.baseUrl);
    expect(await flag(page)).toBe('1');
    await expect(page.getByTestId('today-retry-projects')).toBeVisible();
  });
});
