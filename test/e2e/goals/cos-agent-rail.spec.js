// eve#274: the Chief of Staff page lists every agent in a rail beside the thread (wide) or behind
// a strip (900px and narrower). Row notes are line 3; they never post to the thread.
// Doors: sidebar-chief-of-staff (wide). docs/design-chief-of-staff.md
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hermeticTest, gotoEve, reloadEve, expect } = require('../fixtures');
const { startEve } = require('../../integration/harness');
const { relayFrames } = require('../../integration/protocol');

const MODEL = 'claude-haiku-4-5-20251001';
const WAIT = { timeout: 20000 }; // an upper bound; the server's quiet window is 5s
const WITHIN_2S = { timeout: 2000 };
const T0 = '2026-10-05T10:00:00.000Z';
const INTERNAL_SECRET = 'e2e-internal-secret';

const sess = (dir, id, name, projectId, state, extra = {}) => ({
  sessionId: id, name, projectId, directory: dir, model: MODEL, headless: true, agent: true,
  attention: { state, since: T0 }, ...extra,
});
const localDay = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dataRegion = (text) => JSON.parse(/<agent_data>\n([\s\S]*)\n<\/agent_data>/.exec(text)[1]);

// world.sessions(dir) lists the sessions seeded before the page opens; world.cosState seeds the
// Chief of Staff state file.
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
        if (world.cosState) await fs.promises.writeFile(path.join(dataDir, 'chief-of-staff-state.json'), JSON.stringify(world.cosState));
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

const MIXED = (dir) => [
  sess(dir, 's-ask', 'Asker', 'wk', 'asking', { model: 'haiku' }), // Drop in needs a Claude alias model
  sess(dir, 's-err', 'Failer', 'rh', 'errored'),
  sess(dir, 's-stl', 'Quiet', '', 'stalled'),
  sess(dir, 's-run', 'Runner', 'wk', 'running'),
  sess(dir, 's-str', 'Starter', 'wk', 'starting'),
  sess(dir, 's-idl', 'Idler', 'hm', 'idle'),
  sess(dir, 's-end', 'Ender', 'wk', 'ended'),
];

const rail = (page) => page.getByRole('navigation', { name: 'Agents' });
const rowIn = (page, key, id) => page.getByTestId(`rail-agents-group-${key}`).getByTestId(`rail-agent-${id}`);
async function openThread(page) {
  await page.getByTestId('sidebar-chief-of-staff').click();
  await expect(page.getByTestId('cos-page')).toBeVisible();
}
const token = (page, name) => page.evaluate((t) => {
  const p = document.createElement('span');
  p.style.backgroundColor = `var(${t})`;
  document.body.appendChild(p);
  const c = getComputedStyle(p).backgroundColor;
  p.remove();
  return c;
}, name);
const fontOf = (page, testid) => page.getByTestId(testid).evaluate((el) => getComputedStyle(el).fontFamily);
const fontToken = (page, name) => page.evaluate((t) => {
  const p = document.createElement('span');
  p.style.fontFamily = `var(${t})`;
  document.body.appendChild(p);
  const f = getComputedStyle(p).fontFamily;
  p.remove();
  return f;
}, name);
// The server knows a session once a frame names it and it re-reads relay's list; the subline counts it.
async function teach(page, eve, id, count) {
  eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: id, state: 'running' }));
  await expect(page.getByTestId('cos-subline')).toContainText(`Watching ${count} agent`, WAIT);
}

test.describe('the rail', () => {
  test.use({ world: { sessions: MIXED } });

  test('is a nav named Agents to the right of the thread', async ({ page }) => {
    await openThread(page);
    await expect(rail(page)).toBeVisible();
    await expect(page.getByTestId('cos-agents-rail')).toBeVisible();
    const r = await rail(page).boundingBox();
    const t = await page.getByTestId('cos-thread').boundingBox();
    const d = await page.getByTestId('cos-rail-divider').boundingBox();
    expect(t.x + t.width).toBeLessThanOrEqual(d.x + 1);
    expect(d.x + d.width).toBeLessThanOrEqual(r.x + 1);
    expect(r.width).toBe(280);
    await expect(page.getByTestId('cos-agents-strip')).toBeHidden();
  });

  test('shows work, home-mode, hosted and project-less rows while Today hides the out-of-mode one', async ({ page }) => {
    await expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('today-agent-s-run')).toBeVisible();
    await expect(page.getByTestId('today-agent-s-idl')).toHaveCount(0);
    await openThread(page);
    for (const id of ['s-ask', 's-err', 's-stl', 's-run', 's-str', 's-idl']) await expect(rail(page).getByTestId(`rail-agent-${id}`)).toBeVisible();
    await expect(page.getByTestId('rail-agent-meta-s-err')).toHaveText('Remote Box · Stopped with an error');
    await expect(page.getByTestId('rail-agent-meta-s-idl')).toHaveText('Garden · Idle');
    await expect(page.getByTestId('rail-agent-meta-s-stl')).toHaveText('Gone quiet');
  });

  test('puts Needs you first, then Working and Idle, and keeps Done collapsed until the toggle opens it', async ({ page }) => {
    await openThread(page);
    await expect(rowIn(page, 'idle', 's-idl')).toBeVisible();
    const sections = rail(page).locator('section');
    await expect(sections).toHaveCount(4);
    expect(await sections.evaluateAll((els) => els.map((e) => e.dataset.testid))).toEqual([
      'rail-agents-group-needs', 'rail-agents-group-working', 'rail-agents-group-idle', 'rail-agents-group-done']);
    for (const id of ['s-ask', 's-err', 's-stl']) await expect(rowIn(page, 'needs', id)).toBeVisible();
    for (const id of ['s-run', 's-str']) await expect(rowIn(page, 'working', id)).toBeVisible();

    const toggle = page.getByTestId('rail-agents-group-done-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('rail-agent-s-end')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rowIn(page, 'done', 's-end')).toBeVisible();
  });

  test('each state has its dot colour: red asking, errored and stalled (ring), amber running and starting, green idle, grey ended', async ({ page }) => {
    await openThread(page);
    await page.getByTestId('rail-agents-group-done-toggle').click();
    await expect(page.getByTestId('rail-agent-s-end')).toBeVisible();
    const ids = { 's-ask': ['asking', '--danger'], 's-err': ['errored', '--danger'], 's-run': ['running', '--warning'], 's-str': ['starting', '--warning'], 's-idl': ['idle', '--success'], 's-end': ['ended', '--text-muted'] };
    for (const [id, [state, tok]] of Object.entries(ids)) {
      const dot = page.getByTestId(`rail-agent-${id}`).locator('.agent-row__dot');
      await expect(dot).toHaveAttribute('data-state', state);
      expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, tok));
    }
    const stalled = page.getByTestId('rail-agent-s-stl').locator('.agent-row__dot');
    expect(await stalled.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await stalled.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(await token(page, '--danger'));
  });

  test('a tap on a row opens that session', async ({ page, eve }) => {
    await openThread(page);
    await page.getByTestId('rail-agent-s-run').click();
    await eve.relay.waitForInbound((m) => m.type === 'join_session' && m.sessionId === 's-run');
    await expect(page).toHaveURL(/#session\/s-run$/);
    await expect(page.getByTestId('chat-input')).toBeVisible();
  });

  test('Drop in sits on a headless Claude row under Needs you', async ({ page }) => {
    await openThread(page);
    await expect(rowIn(page, 'needs', 's-ask')).toBeVisible();
    await expect(page.getByTestId('rail-drop-in-s-ask')).toBeVisible();
    await expect(page.getByTestId('rail-drop-in-s-run')).toHaveCount(0);
  });
});

test.describe('the viewport switch', () => {
  test.use({ world: { sessions: MIXED } });

  test('at 901px the rail shows and the strip does not; at 900px the strip shows and the rail does not', async ({ page }) => {
    await openThread(page);
    await page.setViewportSize({ width: 901, height: 800 });
    await expect(rail(page)).toBeVisible();
    await expect(page.getByTestId('cos-agents-strip')).toBeHidden();
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId('cos-agents-strip')).toBeVisible();
    await expect(rail(page)).toBeHidden();
  });
});

// eve#321: the divider between thread and rail resizes the rail and folds it into the strip.
test.describe('the rail divider', () => {
  test.use({ world: { sessions: MIXED } });
  const divider = (page) => page.getByTestId('cos-rail-divider');
  const railWidth = async (page) => (await rail(page).boundingBox()).width;
  async function dragTo(page, x) {
    const d = await divider(page).boundingBox();
    const y = d.y + d.height / 2;
    await page.mouse.move(d.x + d.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    await page.mouse.up();
  }
  const pageRight = async (page) => {
    const b = await page.getByTestId('cos-page').boundingBox();
    return b.x + b.width;
  };

  test('a drag resizes the rail and the thread, within 220-480px, and a reload keeps the width', async ({ page }) => {
    await openThread(page);
    const threadBefore = (await page.getByTestId('cos-thread').boundingBox()).width;
    const right = await pageRight(page);
    await dragTo(page, right - 400);
    expect(Math.abs(await railWidth(page) - 400)).toBeLessThanOrEqual(4);
    expect((await page.getByTestId('cos-thread').boundingBox()).width).toBeLessThan(threadBefore);
    await dragTo(page, right - 900);
    expect(await railWidth(page)).toBe(480);
    await dragTo(page, right - 190);
    expect(await railWidth(page)).toBe(220);
    await expect(divider(page)).toHaveAttribute('aria-valuenow', '220');
    await reloadEve(page);
    await openThread(page);
    expect(await railWidth(page)).toBe(220);
  });

  test('is a focusable separator: arrows step 16px, Home and End jump, a double-click resets to 280px', async ({ page }) => {
    await openThread(page);
    const d = divider(page);
    await expect(d).toHaveAttribute('role', 'separator');
    await expect(d).toHaveAttribute('aria-label', 'Resize agents');
    await d.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(d).toHaveAttribute('aria-valuenow', '296');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(d).toHaveAttribute('aria-valuenow', '264');
    await page.keyboard.press('End');
    await expect(d).toHaveAttribute('aria-valuenow', '480');
    expect(await railWidth(page)).toBe(480);
    await page.keyboard.press('Home');
    await expect(d).toHaveAttribute('aria-valuenow', '220');
    await d.dblclick();
    expect(await railWidth(page)).toBe(280);
  });

  test('a drag under 160px folds the rail into the strip; the strip and Enter unfold it at its last width', async ({ page }) => {
    await openThread(page);
    const right = await pageRight(page);
    await dragTo(page, right - 360);
    await dragTo(page, right - 60);
    await expect(rail(page)).toBeHidden();
    await expect(page.getByTestId('cos-agents-strip')).toBeVisible();
    await expect(divider(page)).toBeVisible();
    await expect(divider(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('cos-agents-strip-red')).toHaveText(/3/);

    await reloadEve(page);
    await openThread(page);
    await expect(rail(page)).toBeHidden();
    await page.getByTestId('cos-agents-strip').click();
    await expect(page.getByTestId('cos-agents-sheet')).toBeHidden();
    await expect(rail(page)).toBeVisible();
    expect(Math.abs(await railWidth(page) - 360)).toBeLessThanOrEqual(4);
    await expect(page.getByTestId('cos-agents-strip')).toBeHidden();
    await expect(divider(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(rail(page)).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(rail(page)).toBeVisible();
  });

  test('folded, "need you" unfolds the rail at its Needs you rows', async ({ page, eve }) => {
    await openThread(page);
    await divider(page).focus();
    await page.keyboard.press('Enter');
    await expect(rail(page)).toBeHidden();
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's-ask', state: 'asking' }));
    await page.getByTestId('cos-need-you').click(WAIT);
    await expect(rail(page)).toBeVisible();
    await expect(page.getByTestId('rail-agents-group-needs-head')).toBeFocused();
  });

  test('at 900px and under there is no divider, and a folded rail still opens the sheet from the strip', async ({ page }) => {
    await openThread(page);
    await divider(page).focus();
    await page.keyboard.press('Enter');
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(divider(page)).toBeHidden();
    await page.getByTestId('cos-agents-strip').click();
    await expect(page.getByTestId('cos-agents-sheet')).toBeVisible();
  });
});

test.describe('line 3 of an idle agent', () => {
  test.use({ world: { sessions: (dir) => [sess(dir, 's1', 'Agent s1', 'wk', 'running')] } });

  test('shows the last words in mono at once, then the model line in prose, and the thread gets no post', async ({ page, eve }) => {
    await openThread(page);
    await teach(page, eve, 's1', 1);
    eve.relay.emitToRelay(relayFrames.turnDone({ sessionId: 's1', excerpt: 'Merged the branch.' }));
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'idle' }));
    const line = page.getByTestId('rail-agent-line-s1');
    await expect(line).toHaveAttribute('data-source', 'pending', WAIT);
    await expect(line).toHaveText('Merged the branch.');
    expect(await fontOf(page, 'rail-agent-line-s1')).toBe(await fontToken(page, '--font-mono'));

    await expect(line).toHaveAttribute('data-source', 'model', WAIT);
    await expect(line).toHaveText('Row line for s1.');
    expect(await fontOf(page, 'rail-agent-line-s1')).toBe(await fontToken(page, '--font-ui'));
    // The turn is over once the avatar is no longer busy; only then does "no post" mean anything.
    await expect(page.getByTestId('cos-pill').getByTestId('cos-avatar')).not.toHaveAttribute('data-busy', WAIT);
    await expect(page.locator('[data-testid^="cos-post-"]')).toHaveCount(0);
  });
});

test.describe('line 3 at the daily limit', () => {
  test.use({ world: { sessions: (dir) => [sess(dir, 's1', 'Agent s1', 'wk', 'running')], cosState: { day: localDay(), calls: 100 } } });

  test('is the last words in mono, and no row prompt is sent', async ({ page, eve }) => {
    await openThread(page);
    await teach(page, eve, 's1', 1);
    eve.relay.emitToRelay(relayFrames.turnDone({ sessionId: 's1', excerpt: 'Merged the branch.' }));
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 's1', state: 'idle' }));
    const line = page.getByTestId('rail-agent-line-s1');
    await expect(line).toHaveAttribute('data-source', 'template', WAIT);
    await expect(line).toHaveText('Merged the branch.');
    expect(await fontOf(page, 'rail-agent-line-s1')).toBe(await fontToken(page, '--font-mono'));
    await expect(page.getByTestId('cos-pill').getByTestId('cos-avatar')).not.toHaveAttribute('data-busy', WAIT);
    expect(eve.relay.cosModelTurns.filter((t) => t.text.startsWith('Chief of Staff row'))).toHaveLength(0);
    await expect(page.locator('[data-testid^="cos-post-"]')).toHaveCount(0);
  });
});

test.describe('the need-you button', () => {
  const MANY = (dir) => [
    sess(dir, 'n1', 'Zed asks', 'wk', 'running'),
    ...Array.from({ length: 30 }, (_, i) => sess(dir, `w${String(i).padStart(2, '0')}`, `Worker ${String(i).padStart(2, '0')}`, 'wk', 'running')),
  ];
  test.use({ world: { sessions: MANY } });

  test('scrolls the Needs you header into view and focuses it', async ({ page, eve }) => {
    await openThread(page);
    eve.relay.emitToRelay(relayFrames.sessionState({ sessionId: 'n1', state: 'asking' }));
    const button = page.getByTestId('cos-need-you');
    await expect(button).toBeVisible(WAIT);
    await expect(button).toHaveText('1 needs you');
    await expect(page.getByTestId('rail-agent-w29')).toBeVisible();
    await page.getByTestId('cos-agents-rail-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByTestId('rail-agents-group-needs-head')).not.toBeInViewport();
    await button.click();
    await expect(page.getByTestId('rail-agents-group-needs-head')).toBeInViewport();
    await expect(page.getByTestId('rail-agents-group-needs-head')).toBeFocused();
  });
});

test.describe('states', () => {
  test.describe('no agents', () => {
    test.use({ world: { sessions: () => [] } });
    test('the rail says No agents running', async ({ page }) => {
      await openThread(page);
      await expect(page.getByTestId('rail-agents-empty')).toHaveText('No agents running');
    });
  });

  test.describe('relay unreachable', () => {
    test.use({ world: { sessions: MIXED } });
    test('the rail says Can\'t reach relay.', async ({ page, eve }) => {
      await eve.relay.close();
      await reloadEve(page);
      await openThread(page);
      await expect(page.getByTestId('rail-agents-offline')).toHaveText("Can't reach relay.");
    });
  });
});
