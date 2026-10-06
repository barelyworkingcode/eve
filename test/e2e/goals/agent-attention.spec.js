// eve#195: the agent board says which agents need me. Sessions arrive from relay's
// `attention` on the list and its `session_state` frames; the board groups them
// Needs you / Working / Done on Today and on the project page, with one state
// dot per row, and the phone's Today button counts the Needs-you rows.
// docs/design-workbench.md
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');
const { nav } = require('./today-helpers');
const { relayFrames } = require('../../integration/protocol');

const MODEL = 'claude-haiku-4-5-20251001';
const WITHIN_2S = { timeout: 2000 };
const T0 = '2026-10-05T10:00:00.000Z';

const session = (id, name, extra = {}) => ({ sessionId: id, name, projectId: 'alpha', directory: '/tmp', model: MODEL, ...extra });
const seedWith = (...sessions) => ({ relay }) => {
  for (const s of sessions) relay.seedSession(s);
};
const frame = (relay, sessionId, state, since = new Date().toISOString()) =>
  relay.emitToRelay(relayFrames.sessionState({ sessionId, state, since }));

const group = (page, prefix, key) => page.getByTestId(`${prefix}-agents-group-${key}`);
const rowIn = (page, prefix, key, id) => group(page, prefix, key).getByTestId(`${prefix}-agent-${id}`);

async function openAlphaPage(page) {
  await nav(page).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('panel-project-page').click();
  await expect(page.getByTestId('project-page-alpha')).toBeVisible();
}

const world = {
  seed: seedWith(
    session('s-run', 'Runner', { attention: { state: 'running', since: T0 } }),
    session('s-idle', 'Idler', { attention: { state: 'idle', since: T0 } }),
    session('s-old', 'Old thread', { live: false }),
  ),
};

test.describe('agent board states', () => {
  test.use({ world });

  for (const state of ['asking', 'errored', 'stalled']) {
    test(`a running session moves to Needs you within 2 s of an ${state} frame, on Today and on the project page`, async ({ page, eve }) => {
      await expect(rowIn(page, 'today', 'working', 's-run')).toBeVisible();
      await frame(eve.relay, 's-run', state);
      await expect(rowIn(page, 'today', 'needs', 's-run')).toBeVisible(WITHIN_2S);
      await expect(group(page, 'today', 'working').getByTestId('today-agent-s-run')).toHaveCount(0);
      await expect(rowIn(page, 'today', 'working', 's-idle')).toBeVisible();

      await openAlphaPage(page);
      await frame(eve.relay, 's-run', 'running');
      await expect(rowIn(page, 'project', 'working', 's-run')).toBeVisible(WITHIN_2S);
      await frame(eve.relay, 's-run', state);
      await expect(rowIn(page, 'project', 'needs', 's-run')).toBeVisible(WITHIN_2S);
      await expect(page.getByTestId('project-agents-group-needs-count')).toHaveText('1');
    });
  }

  test('running, idle and starting frames put a session in Working', async ({ page, eve }) => {
    await frame(eve.relay, 's-idle', 'asking');
    await expect(rowIn(page, 'today', 'needs', 's-idle')).toBeVisible(WITHIN_2S);
    for (const state of ['running', 'idle', 'starting']) {
      await frame(eve.relay, 's-idle', state);
      await expect(rowIn(page, 'today', 'working', 's-idle')).toHaveAttribute('data-state', state, WITHIN_2S);
    }
  });

  test('an ended frame moves a session to Done, a resume\'s starting frame brings it back, and after a reload a dead session with no attention is not listed', async ({ page, eve }) => {
    await frame(eve.relay, 's-run', 'ended');
    await expect(rowIn(page, 'today', 'done', 's-run')).toBeVisible(WITHIN_2S);
    await frame(eve.relay, 's-run', 'starting');
    await expect(rowIn(page, 'today', 'working', 's-run')).toBeVisible(WITHIN_2S);
    await frame(eve.relay, 's-run', 'ended');
    await expect(rowIn(page, 'today', 'done', 's-run')).toBeVisible(WITHIN_2S);

    eve.relay.seedSession(session('s-run', 'Runner', { live: false }));
    await reloadEve(page);
    await expect(rowIn(page, 'today', 'working', 's-idle')).toBeVisible();
    await expect(page.getByTestId('today-agent-s-run')).toHaveCount(0);
    await expect(page.getByTestId('today-agent-s-old')).toHaveCount(0);
    await expect(group(page, 'today', 'done')).toHaveCount(0);
  });

  test('a terminal that exits 1 goes to Needs you; one that exits 0 goes to Done', async ({ page, eve }) => {
    for (const id of ['t-bad', 't-ok']) {
      eve.relay.seedTerminal({ terminalId: id, templateId: 'shell', name: id, directory: eve.folders.alpha });
    }
    await reloadEve(page);
    await expect(rowIn(page, 'today', 'working', 't-bad')).toBeVisible();
    await expect(rowIn(page, 'today', 'working', 't-ok')).toBeVisible();
    for (const [id, code] of [['t-bad', 1], ['t-ok', 0]]) {
      eve.relay.seedTerminal({ terminalId: id, templateId: 'shell', name: id, directory: eve.folders.alpha, state: 'stopped' });
      await eve.relay.emitToRelay({ type: 'terminal_exit', terminalId: id, exitCode: code });
    }
    await expect(rowIn(page, 'today', 'needs', 't-bad')).toContainText('exited 1', WITHIN_2S);
    await expect(rowIn(page, 'today', 'done', 't-ok')).toContainText('exited 0', WITHIN_2S);
  });

  test('a frame for a session the refreshed list names shows a row; one the list never names shows none; turn_done changes nothing', async ({ page, eve }) => {
    await expect(rowIn(page, 'today', 'working', 's-run')).toBeVisible();
    eve.relay.seedSession(session('s-late', 'Latecomer'));
    await frame(eve.relay, 's-late', 'asking');
    await frame(eve.relay, 's-ghost', 'asking');
    await expect(rowIn(page, 'today', 'needs', 's-late')).toBeVisible(WITHIN_2S);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('today-agent-s-ghost')).toHaveCount(0);

    await eve.relay.emitToRelay({ type: 'turn_done', sessionId: 's-run' });
    await page.waitForTimeout(500);
    await expect(rowIn(page, 'today', 'working', 's-run')).toHaveAttribute('data-state', 'running');
  });

  test('a tap on a session row joins that session and opens its chat', async ({ page, eve }) => {
    await page.getByTestId('today-agent-s-run').click();
    const join = await eve.relay.waitForInbound((m) => m.type === 'join_session' && m.sessionId === 's-run');
    expect(join.sessionId).toBe('s-run');
    await expect(page).toHaveURL(/#session\/s-run$/);
    await expect(page.getByTestId('chat-input')).toBeVisible();
  });
});

const STATES = ['running', 'asking', 'stalled', 'errored', 'idle', 'ended', 'starting'];
const TOKEN = { running: '--success', asking: '--warning', errored: '--danger', idle: '--accent', ended: '--text-muted', starting: '--text-muted' };

test.describe('agent dots', () => {
  test.use({
    world: { seed: seedWith(...STATES.map((s) => session(`d-${s}`, `Dot ${s}`, { attention: { state: s, since: T0 } }))) },
  });

  const read = (page) => page.evaluate((states) => {
    const out = {};
    for (const s of states) {
      const dot = document.querySelector(`[data-testid="today-agent-d-${s}"] .agent-row__dot`);
      const cs = getComputedStyle(dot);
      out[s] = {
        n: document.querySelectorAll(`[data-testid="today-agent-d-${s}"] .agent-row__dot`).length,
        bg: cs.backgroundColor, shadow: cs.boxShadow, anim: cs.animationName,
        ring: getComputedStyle(dot, '::after').animationName,
      };
    }
    return out;
  }, STATES);
  const token = (page, name) => page.evaluate((t) => {
    const p = document.createElement('span');
    p.style.backgroundColor = `var(${t})`;
    document.body.appendChild(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  }, name);

  test('each state has one dot in its colour; stalled is hollow with a warning ring', async ({ page }) => {
    await expect(page.getByTestId('today-agent-d-ended')).toBeVisible();
    const dots = await read(page);
    for (const s of STATES) expect(dots[s].n).toBe(1);
    for (const [s, t] of Object.entries(TOKEN)) expect(dots[s].bg).toBe(await token(page, t));
    expect(dots.stalled.bg).toBe('rgba(0, 0, 0, 0)');
    expect(dots.stalled.shadow).toContain(await token(page, '--warning'));
  });

  test('only asking and running animate', async ({ page }) => {
    await expect(page.getByTestId('today-agent-d-ended')).toBeVisible();
    const dots = await read(page);
    for (const s of STATES) {
      expect(dots[s].anim !== 'none').toBe(s === 'asking');
      expect(dots[s].ring !== 'none').toBe(s === 'running');
    }
  });

  test('with reduced motion nothing animates', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('today-agent-d-ended')).toBeVisible();
    const dots = await read(page);
    for (const s of STATES) {
      expect(dots[s].anim).toBe('none');
      expect(dots[s].ring).toBe('none');
    }
  });
});

test.describe('phone badge', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    world: {
      seed: seedWith(
        session('b-ask', 'Asker', { attention: { state: 'asking', since: T0 } }),
        session('b-err', 'Failer', { attention: { state: 'errored', since: T0 } }),
        session('b-run', 'Worker', { attention: { state: 'running', since: T0 } }),
      ),
    },
  });

  test('the Today button counts the Needs-you rows, follows frames within 2 s, hides at 0 and is still named Today', async ({ page, eve }) => {
    const badge = page.getByTestId('nav-today-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('2');
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();

    await frame(eve.relay, 'b-run', 'stalled');
    await expect(badge).toContainText('3', WITHIN_2S);
    await frame(eve.relay, 'b-ask', 'running');
    await frame(eve.relay, 'b-err', 'ended');
    await frame(eve.relay, 'b-run', 'idle');
    await expect(badge).toBeHidden(WITHIN_2S);
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
  });
});
