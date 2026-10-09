// eve#274: on a phone the agent rail is a 44px strip above the composer that opens the same rows in
// a modal sheet. Door: nav-chief-of-staff. docs/design-chief-of-staff.md
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hermeticTest, gotoEve, reloadEve, expect } = require('../fixtures');
const { startEve } = require('../../integration/harness');
const { relayFrames } = require('../../integration/protocol');

const MODEL = 'claude-haiku-4-5-20251001';
const WAIT = { timeout: 20000 }; // an upper bound
const T0 = '2026-10-05T10:00:00.000Z';
const INTERNAL_SECRET = 'e2e-internal-secret';

const sess = (dir, id, name, projectId, state, extra = {}) => ({
  sessionId: id, name, projectId, directory: dir, model: MODEL, headless: true, agent: true,
  attention: { state, since: T0 }, ...extra,
});
const dataRegion = (text) => JSON.parse(/<agent_data>\n([\s\S]*)\n<\/agent_data>/.exec(text)[1]);

// world.sessions(dir) lists the sessions seeded before the page opens.
const test = hermeticTest.extend({
  world: [{}, { option: true }],
  eve: async ({ world }, use) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cos-rail-')));
    const eve = await startEve({
      projects: [
        { id: 'wk', name: 'Acme', path: dir, mode: 'work' },
        { id: 'hm', name: 'Garden', path: dir, mode: 'home' },
        { id: 'rh', name: 'Remote Box', path: '/srv/acme', host_id: 'h1', mode: 'work' },
      ],
      hosts: [{ id: 'h1', name: 'Acme box' }],
      env: { EVE_INTERNAL_SECRET: INTERNAL_SECRET },
      seedDataDir: async (dataDir) => {
        await fs.promises.writeFile(path.join(dataDir, 'settings.json'),
          JSON.stringify({ chiefOfStaff: { model: 'haiku', projectId: 'wk', dailyModelCalls: 100 } }));
      },
    });
    try {
      eve.relay.setCosModel({
        reply: (text, n) => {
          if (n === 1) return 'ready';
          if (text.startsWith('Chief of Staff row')) {
            const rows = dataRegion(text).map((e) => ({ sessionId: e.sessionId, line: `Row line for ${e.sessionId}.` }));
            return '```json\n' + JSON.stringify({ rows }) + '\n```';
          }
          return null;
        },
      });
      await eve.relay.waitForScopedRelay();
      for (const s of (world.sessions ? world.sessions(dir) : [])) eve.relay.seedSession(s);
      await use(eve);
    } finally {
      await eve.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

const MIXED = (dir) => [
  sess(dir, 's-ask', 'Asker', 'wk', 'asking'),
  sess(dir, 's-err', 'Failer', 'rh', 'errored'),
  sess(dir, 's-run', 'Runner', 'wk', 'running'),
  sess(dir, 's-idl', 'Idler', 'hm', 'idle'),
];

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const strip = (page) => page.getByTestId('cos-agents-strip');
const sheet = (page) => page.getByTestId('cos-agents-sheet');
async function openThread(page) {
  await page.getByTestId('nav-chief-of-staff').click();
  await expect(page.getByTestId('cos-page')).toBeVisible();
}
async function openSheet(page) {
  await strip(page).tap();
  await expect(sheet(page)).toHaveAttribute('open', '');
  await expect(page.getByTestId('cos-agents-sheet-close')).toBeFocused();
}

test.describe('the strip', () => {
  test.use({ world: { sessions: MIXED } });

  test('is 44px high, counts the red rows and hides red at 0', async ({ page, eve }) => {
    await openThread(page);
    await expect(strip(page)).toBeVisible();
    expect((await strip(page).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId('cos-agents-strip-red')).toHaveText(/^2/);
    await expect(page.getByTestId('cos-agents-strip-amber')).toHaveText(/^1/);
    await expect(page.getByTestId('cos-agents-strip-green')).toHaveText(/^1/);
    await openSheet(page);
    await expect(page.getByTestId('sheet-agents-group-needs-count')).toHaveText('2');
    await page.getByTestId('cos-agents-sheet-close').click();

    for (const id of ['s-ask', 's-err']) eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: id, state: 'running' }));
    await expect(page.getByTestId('cos-agents-strip-red')).toBeHidden(WAIT);
    await expect(page.getByTestId('cos-agents-strip-amber')).toHaveText(/^3/);
  });

  test('a tap opens the sheet with the same rows; Tab stays inside it', async ({ page }) => {
    await openThread(page);
    await openSheet(page);
    await expect(page.getByTestId('sheet-agents-group-needs').getByTestId('sheet-agent-s-ask')).toBeVisible();
    await expect(page.getByTestId('sheet-agents-group-idle').getByTestId('sheet-agent-s-idl')).toBeVisible();
    // Forward past the last control and back past the first: focus never leaves the dialog.
    for (const key of [...Array(8).fill('Tab'), ...Array(16).fill('Shift+Tab')]) {
      await page.keyboard.press(key);
      await expect(sheet(page).locator(':focus')).toHaveCount(1);
    }
  });

  const closers = {
    'the close button': (page) => page.getByTestId('cos-agents-sheet-close').click(),
    'Escape': (page) => page.keyboard.press('Escape'),
    'a click above the sheet': (page) => page.mouse.click(195, 20),
    'a mouse drag of the handle down 200px': async (page) => {
      const b = await page.getByTestId('cos-agents-sheet-handle').boundingBox();
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 100, { steps: 5 });
      await page.mouse.move(x, y + 200, { steps: 5 });
      await page.mouse.up();
    },
  };
  for (const [what, close] of Object.entries(closers)) {
    test(`${what} closes the sheet and puts focus back on the strip`, async ({ page }) => {
      await openThread(page);
      await openSheet(page);
      await close(page);
      await expect(sheet(page)).not.toHaveAttribute('open', '');
      await expect(strip(page)).toBeFocused();
    });
  }

  test('a row tap closes the sheet and opens the session', async ({ page, eve }) => {
    await openThread(page);
    await openSheet(page);
    await page.getByTestId('sheet-agent-s-run').tap();
    await expect(sheet(page)).not.toHaveAttribute('open', '');
    await eve.relay.waitForInbound((m) => m.type === 'join_session' && m.sessionId === 's-run');
    await expect(page).toHaveURL(/#session\/s-run$/);
  });
});

test.describe('the need-you button', () => {
  test.use({ world: { sessions: (dir) => [sess(dir, 'n1', 'Zed asks', 'wk', 'running'), sess(dir, 'n2', 'Other', 'wk', 'running')] } });

  test('opens the sheet with the Needs you group in view', async ({ page, eve }) => {
    await openThread(page);
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 'n1', state: 'asking' }));
    const button = page.getByTestId('cos-need-you');
    await expect(button).toBeVisible(WAIT);
    await button.tap();
    await expect(sheet(page)).toHaveAttribute('open', '');
    await expect(page.getByTestId('sheet-agents-group-needs-head')).toBeInViewport();
    await expect(page.getByTestId('sheet-agent-n1')).toBeVisible();
  });
});

test.describe('relay unreachable', () => {
  test.use({ world: { sessions: MIXED } });

  test('the strip reads Agents with no counts', async ({ page, eve }) => {
    await eve.relay.close();
    await reloadEve(page);
    await openThread(page);
    await expect(strip(page)).toContainText('Agents');
    for (const c of ['red', 'amber', 'green']) await expect(page.getByTestId(`cos-agents-strip-${c}`)).toBeHidden();
  });
});
