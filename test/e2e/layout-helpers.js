// Shared by the S2 layout specs (docs/design-today-s2.md, "Specs").
// Worlds come from goals/fixture.js; the probes implement the contract's
// Sweep and Overflow methods as written.
const { expect } = require('@playwright/test');

// The layout each width must get, from S2-A1 (>= 1024 wide, 600-1023 regular).
const VIEWPORTS = [
  { width: 320, height: 568, layout: 'compact' },
  { width: 390, height: 844, layout: 'compact' },
  { width: 768, height: 1024, layout: 'regular' },
  { width: 834, height: 1194, layout: 'regular' },
  { width: 1024, height: 768, layout: 'wide' },
  { width: 1366, height: 1024, layout: 'wide' },
];
const vpName = (vp) => `${vp.width}x${vp.height}`;
const viewport = (vp) => ({ width: vp.width, height: vp.height });

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const MODELS = { models: [{ value: 'fake-model', label: 'Fake Model', provider: 'claude' }], providerSettings: {} };
const REPLY = 'Start with the release notes.';

// One thread in Alpha with a reply (Continue lists it), a second thread, an
// image beside README.md, and a shell template for the terminal keybar.
const WORLD = {
  seed: ({ relay, folders }) => {
    relay.files.seed('alpha', { 'photo.png': TINY_PNG });
    relay.setModels(MODELS);
    relay.setTerminalTemplates([{ id: 'shell', name: 'Shell', description: 'Plain shell', sandbox: true }]);
    const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();
    relay.seedSession({
      sessionId: 's-reply', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Plan the launch',
      history: [
        { timestamp: iso(2), role: 'user', content: 'Plan the launch checklist' },
        { timestamp: iso(2), role: 'assistant', content: [{ type: 'text', text: REPLY }] },
      ],
      live: false, createdAt: iso(3), lastMessageAt: iso(1), messageCount: 2,
    });
    relay.seedSession({
      sessionId: 's-two', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Second thread',
      history: [], live: false, createdAt: iso(5), lastMessageAt: iso(4), messageCount: 0,
    });
  },
};

const layoutOf = (page) => page.evaluate(() => document.documentElement.dataset.layout);
const hash = (page) => page.evaluate(() => location.hash);
const tabCount = (page) => page.evaluate(() => window.client.tabManager.tabs.length);

// The sidebar's door at each layout: always shown on wide, the menu on
// regular, the bottom bar (from Today) on compact.
async function openSidebar(page) {
  const layout = await layoutOf(page);
  if (layout === 'wide') return;
  if (layout === 'compact') {
    if (await page.getByTestId('nav-back').isVisible()) await page.getByTestId('nav-back').click();
    await page.getByTestId('nav-projects').click();
  } else {
    await page.locator('[data-testid="welcome-sidebar-open"], [data-testid="sidebar-open"]').filter({ visible: true }).click();
  }
  await expect(page.locator('#sidebarRail')).toBeInViewport();
}

async function openPanel(page, tab) {
  await openSidebar(page);
  await page.getByTestId('sidebar-project-alpha').click();
  await page.getByTestId(`panel-tab-${tab}`).click();
}

// The project page's door (S5a-A1): the panel header's button.
async function openProjectPage(page) {
  await openSidebar(page);
  await page.getByTestId('sidebar-project-alpha').click();
  await page.getByTestId('panel-project-page').click();
  await expect(page.getByTestId('project-page-alpha')).toBeVisible();
}

async function openThreadFromToday(page, id = 's-reply') {
  await page.getByTestId(`home-session-${id}`).click();
  await expect(page.getByTestId('messages-container')).toContainText(REPLY);
}

// Contract "Sweep": every visible, in-viewport interactive control below 44x44.
function sweep(page) {
  return page.evaluate(() => {
    const ROLES = ['button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'];
    const selector = ['button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
      '[tabindex]:not([tabindex="-1"])', ...ROLES.map((r) => `[role="${r}"]`)].join(', ');
    const candidates = new Set(document.querySelectorAll(selector));
    for (const el of document.querySelectorAll('body *')) {
      const parent = el.parentElement;
      if (getComputedStyle(el).cursor === 'pointer' && parent && getComputedStyle(parent).cursor !== 'pointer') {
        candidates.add(el);
      }
    }
    const offenders = [];
    for (const el of candidates) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (el.closest('[inert], [aria-hidden="true"]') || el.matches('.message-content a')) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      if (r.width < 43.99 || r.height < 43.99) {
        const id = el.dataset.testid || el.id || el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 20);
        offenders.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${id}" ${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
      }
    }
    return offenders;
  });
}

// Contract "Overflow": no page scroll, and nothing visible past the right edge
// outside the containers that scroll on their own.
function overflow(page) {
  return page.evaluate(() => {
    const EXEMPT = 'pre, .monaco-editor, .xterm, .terminal-keybar__keys, .tab-bar, .sidebar-rail__projects';
    const offenders = [];
    const sw = document.documentElement.scrollWidth;
    if (sw > innerWidth) offenders.push(`documentElement.scrollWidth ${sw} > ${innerWidth}`);
    for (const el of document.querySelectorAll('body *')) {
      if (el.parentElement?.closest(EXEMPT)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1) {
        const id = el.dataset?.testid || el.id || '';
        offenders.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${id}" right ${r.right.toFixed(1)}`);
      }
    }
    return offenders;
  });
}

module.exports = {
  VIEWPORTS, vpName, viewport, WORLD, REPLY,
  layoutOf, hash, tabCount, openSidebar, openPanel, openProjectPage, openThreadFromToday, sweep, overflow,
};
