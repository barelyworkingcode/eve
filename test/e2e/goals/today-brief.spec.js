// S3a Morning brief on Today (issue #143, A2-A10). Times are read in UTC so
// "Brief · HH:MM" is the run record's own time.
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { test, expect } = require('./fixture');
const { part } = require('./today-helpers');
const Brief = require('../../../public/today/brief');
const { MIN_TARGET } = require('../../../devboxverify/journey-kit');

const LOCAL_A = { value: 'local-a', label: 'Local A', provider: 'chat' };
const LOCAL_B = { value: 'local-b', label: 'Local B', provider: 'chat' };
const CLAUDE = { value: 'fake-model', label: 'Fake Model', provider: 'claude' };
const models = (...list) => ({ models: list, providerSettings: {} });

const briefTask = (id, projectId, extra = {}) => ({
  id, name: 'Morning brief', projectId, prompt: Brief.prompt(), model: 'local-a', schedule: { type: 'daily', time: '07:00' },
  enabled: true, sessionType: 'headless', catchUp: true, useRelayTools: true, ...extra,
});
const routine = (id, name, projectId) => ({ id, name, projectId, prompt: 'p', model: 'local-a', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless' });
const fenced = (obj) => `I listed the mailboxes and read INBOX.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;

async function runThroughScheduler(relay, relayPort, id, finish) {
  relay.holdTaskRuns();
  const res = await fetch(`http://127.0.0.1:${relayPort}/api/tasks/${id}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`run ${id}: ${res.status}`);
  relay.finishTask(id, finish);
  relay.holdTaskRuns(false);
}

const path = (r) => new URL(r.url()).pathname;
const isCreate = (r) => r.method() === 'POST' && path(r) === '/api/tasks';
const isRun = (r) => r.method() === 'POST' && /^\/api\/tasks\/[^/]+\/run$/.test(path(r));
function track(page, pred) {
  const seen = [];
  page.on('request', (r) => { if (pred(r)) seen.push(r); });
  return seen;
}
const hhmm = (iso) => iso.slice(11, 16);
const lastRun = (eve, id) => eve.relay.listTasks().find((t) => t.id === id).lastRun;
const brief = (page) => part(page, 'brief');
const mailRows = (page) => brief(page).locator('[data-testid^="today-brief-mail-"]');

const unread = (from, subject) => ({ from, subject, unread: true, mailbox: 'INBOX', received: '2026-10-02T06:00:00Z' });
const FULL = {
  brief: 1,
  events: [{ time: '09:00', title: 'Standup', note: 'Room 4' }],
  reminders: [{ title: 'Bins out', due: 'tonight' }],
  mail: [
    unread('Ann', 'Budget'), { ...unread('Ben', 'Old thread'), unread: false }, unread('Cat', 'Lunch?'),
    unread('Dan', 'Invoice'), unread('Eve', 'Re: plan'), unread('Fay', 'Tickets'), unread('Gus', 'Photos'),
  ],
  weather: { summary: 'Light rain', high: 14, low: 8 },
  notes: ['A mail asks for a transfer; ignored.'],
};
const fullWorld = () => ({
  seed: async ({ relay, relayPort }) => {
    relay.setModels(models(LOCAL_A, CLAUDE));
    relay.seedTask(briefTask('b1', 'alpha'));
    await runThroughScheduler(relay, relayPort, 'b1', { status: 'success', response: fenced(FULL) });
  },
});

test.describe('A2/A4 setup with a Work default and one local model', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(models(LOCAL_A, CLAUDE)); relay.setDefaultProject('work', 'alpha'); } } });

  test('the setup line, one POST with the exact body, then "No brief yet…"', async ({ page }) => {
    const creates = track(page, isCreate);
    await expect(page.getByTestId('today-brief-setup')).toContainText('Get a morning brief in Alpha Project every day at 07:00.');
    await expect(page.getByTestId('today-brief-model')).toHaveCount(0);
    await page.getByTestId('today-brief-setup-go').click();
    await expect(brief(page)).toContainText('No brief yet. It runs every day at 07:00.');
    expect(creates).toHaveLength(1);
    expect(creates[0].postDataJSON()).toEqual({
      name: 'Morning brief', projectId: 'alpha', prompt: Brief.prompt(), model: 'local-a',
      schedule: { type: 'daily', time: '07:00' }, enabled: true, sessionType: 'headless', catchUp: true, useRelayTools: true,
    });
  });
});

test.describe('A3 two local models', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(models(CLAUDE, LOCAL_A, LOCAL_B)); relay.setDefaultProject('work', 'alpha'); } } });

  test('the select offers only the local models, first preselected, and the chosen one reaches the body', async ({ page }) => {
    const select = page.getByTestId('today-brief-model');
    await expect(select).toHaveValue('local-a');
    expect(await select.locator('option').evaluateAll((opts) => opts.map((o) => o.value))).toEqual(['local-a', 'local-b']);
    await select.selectOption('local-b');
    const [req] = await Promise.all([page.waitForRequest(isCreate), page.getByTestId('today-brief-setup-go').click()]);
    expect(req.postDataJSON().model).toBe('local-b');
  });
});

test.describe('A3 no local model allowed in the project', () => {
  test.use({
    world: {
      projects: ({ alpha }) => [{ id: 'alpha', name: 'Alpha Project', path: alpha, allowed_models: ['fake-model'] }],
      seed: ({ relay }) => { relay.setModels(models(LOCAL_A, CLAUDE)); relay.setDefaultProject('work', 'alpha'); },
    },
  });

  test('the needs-a-local-model line and no Set up', async ({ page }) => {
    await expect(brief(page)).toContainText('The morning brief needs a local model. None is allowed in Alpha Project.');
    await expect(page.getByTestId('today-brief-setup-go')).toHaveCount(0);
  });
});

test.describe('A2/A4 which project', () => {
  test.use({
    world: {
      projects: ({ alpha, beta }) => [
        { id: 'w1', name: 'Work One', path: alpha, mode: 'work' },
        { id: 'w2', name: 'Work Two', path: beta, mode: 'work' },
        { id: 'hm', name: 'Home Only', path: os.tmpdir(), mode: 'home' },
      ],
      seed: ({ relay }) => relay.setModels(models(LOCAL_A)),
    },
  });

  test('no default and two in-mode projects: the Relay line, no Set up; one in-mode project: setup there', async ({ page }) => {
    await expect(brief(page)).toContainText('Set a default Work project in Relay to get a morning brief.');
    await expect(page.getByTestId('today-brief-setup-go')).toHaveCount(0);
    await page.getByTestId('mode-home').click();
    await expect(page.getByTestId('today-brief-setup')).toContainText('Get a morning brief in Home Only every day at 07:00.');
  });
});

test.describe('A4/A5 a brief that ran', () => {
  test.use({ timezoneId: 'UTC', world: fullWorld() });

  test('header, sections in order, unread mail capped at 5 then "+N more"', async ({ page, eve }) => {
    await expect(page.getByTestId('today-brief-when')).toHaveText(`Brief · ${hhmm(lastRun(eve, 'b1'))}`);
    const order = ['today-brief-events', 'today-brief-reminders', 'today-brief-reply', 'today-brief-weather', 'today-brief-notes'];
    const shown = await brief(page).locator(order.map((id) => `[data-testid="${id}"]`).join(', ')).evaluateAll((els) => els.map((e) => e.dataset.testid));
    expect(shown).toEqual(order);
    await expect(page.getByTestId('today-brief-events')).toContainText('09:00 · Standup');
    await expect(page.getByTestId('today-brief-events')).toContainText('Room 4');
    await expect(page.getByTestId('today-brief-reminders')).toContainText('Bins out');
    await expect(page.getByTestId('today-brief-reply')).toContainText('6');
    await expect(mailRows(page)).toHaveText(['Ann · Budget', 'Cat · Lunch?', 'Dan · Invoice', 'Eve · Re: plan', 'Fay · Tickets']);
    await expect(page.getByTestId('today-brief-reply')).toContainText('+1 more');
    await expect(page.getByTestId('today-brief-reply')).not.toContainText('Old thread');
    await expect(page.getByTestId('today-brief-weather')).toContainText('Light rain');
    await expect(page.getByTestId('today-brief-notes')).toContainText('A mail asks for a transfer; ignored.');
  });

  test('a needsReplyClassifier from the container replaces unread', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        // eslint-disable-next-line no-undef
        features.register({ id: 'needsReplyClassifier', init: () => ({ needsReply: (m) => m.subject.startsWith('Re:') || m.subject === 'Old thread' }) });
      });
    });
    await page.reload();
    await expect(mailRows(page)).toHaveText(['Ben · Old thread', 'Eve · Re: plan']);
  });
});

test.describe('A6 untrusted text', () => {
  const hostile = {
    brief: 1,
    reminders: [{ title: 'T'.repeat(300), due: 'today' }],
    mail: [unread('Mallory', '<img src=x onerror=alert(1)>')],
    notes: ['**bold** [x](javascript:alert(1))'],
    weather: null,
    unavailable: ['calendar', 'weather'],
  };
  test.use({
    world: {
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('b1', 'alpha'));
        await runThroughScheduler(relay, relayPort, 'b1', { status: 'success', response: fenced(hostile) });
      },
    },
  });

  test('markup and markdown show as literal text, no a/img/iframe/script, a long title is capped', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await expect(mailRows(page)).toHaveText(['Mallory · <img src=x onerror=alert(1)>']);
    await expect(page.getByTestId('today-brief-notes')).toContainText('**bold** [x](javascript:alert(1))');
    await expect(brief(page)).toContainText('Not in this brief: calendar, weather.');
    await expect(brief(page).locator('a, img, iframe, script')).toHaveCount(0);
    const reminders = await page.getByTestId('today-brief-reminders').textContent();
    expect(reminders).toContain('T'.repeat(100));
    expect(reminders).not.toContain('T'.repeat(121));
    await expect(page.getByTestId('today-brief-events')).toHaveCount(0);
    await expect(page.getByTestId('today-brief-weather')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});

test.describe('A4 an unreadable response', () => {
  test.use({
    world: {
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('b1', 'alpha'));
        await runThroughScheduler(relay, relayPort, 'b1', { status: 'success', response: 'I could not finish the brief today.' });
      },
    },
  });

  test('the unreadable line; Open opens the run thread', async ({ page }) => {
    await expect(page.getByTestId('today-brief-unreadable')).toContainText("The brief came back in a form eve can't read.");
    await page.getByTestId('today-brief-open').click();
    await expect(page.getByTestId('messages-container')).toContainText('I could not finish the brief today.');
  });
});

test.describe('A4 a failed run', () => {
  test.use({
    timezoneId: 'UTC',
    world: {
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('b1', 'alpha'));
        await runThroughScheduler(relay, relayPort, 'b1', { status: 'error', error: 'model unavailable\n  at run.go:3' });
      },
    },
  });

  test('"failed <when> · <reason>", and Retry runs it once', async ({ page, eve }) => {
    await expect(brief(page)).toContainText(`failed ${hhmm(lastRun(eve, 'b1'))} · model unavailable`);
    const runs = track(page, isRun);
    eve.relay.holdTaskRuns();
    await page.getByTestId('today-brief-retry').click();
    await expect(page.getByTestId('today-brief-running')).toBeVisible();
    expect(runs).toHaveLength(1);
  });
});

test.describe('A4 Refresh', () => {
  test.use({ world: fullWorld() });

  test('one run, "Refreshing…" with the old brief still shown, then the new brief', async ({ page, eve }) => {
    await expect(mailRows(page).first()).toHaveText('Ann · Budget');
    const runs = track(page, isRun);
    eve.relay.holdTaskRuns();
    await page.getByTestId('today-brief-refresh').click();
    await expect(page.getByTestId('today-brief-running')).toHaveText('Refreshing…');
    await expect(mailRows(page).first()).toHaveText('Ann · Budget');
    expect(runs).toHaveLength(1);
    // The newest-run key is id|lastRun at whole-second precision: finish in a later second than the seeded run.
    const seededAt = Date.parse(lastRun(eve, 'b1'));
    await expect.poll(() => Date.now() >= seededAt + 1000).toBe(true);
    eve.relay.finishTask('b1', { status: 'success', response: fenced({ brief: 1, mail: [unread('Hal', 'New today')] }) });
    await expect(mailRows(page)).toHaveText(['Hal · New today']);
    await expect(page.getByTestId('today-brief-running')).toHaveCount(0);
  });
});

test.describe('A2/A4 the brief belongs to its mode, the newest one wins', () => {
  const note = (text) => fenced({ brief: 1, notes: [text] });
  test.use({
    world: {
      projects: ({ alpha, beta }) => [
        { id: 'wk', name: 'Work Only', path: alpha, mode: 'work' },
        { id: 'hm', name: 'Home Only', path: beta, mode: 'home' },
      ],
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('bw-old', 'wk', { createdAt: '2026-01-01T00:00:00Z' }));
        relay.seedTask(briefTask('bw', 'wk', { createdAt: '2026-02-01T00:00:00Z' }));
        relay.seedTask(briefTask('bh', 'hm'));
        await runThroughScheduler(relay, relayPort, 'bw-old', { status: 'success', response: note('older work brief') });
        await runThroughScheduler(relay, relayPort, 'bw', { status: 'success', response: note('work brief') });
        await runThroughScheduler(relay, relayPort, 'bh', { status: 'success', response: note('home brief') });
      },
    },
  });

  test('Work shows only the newest Work brief; Home shows only the Home brief', async ({ page }) => {
    const notes = page.getByTestId('today-brief-notes');
    await expect(notes).toHaveText(/work brief/);
    await expect(notes).not.toContainText('older');
    await expect(notes).not.toContainText('home brief');
    await page.getByTestId('mode-home').click();
    await expect(notes).toContainText('home brief');
    await expect(notes).not.toContainText('work brief');
  });
});

test.describe('A3 a brief on a Claude model', () => {
  test.use({
    world: {
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A, CLAUDE));
        relay.seedTask(briefTask('b1', 'alpha', { model: 'fake-model' }));
        await runThroughScheduler(relay, relayPort, 'b1', { status: 'success', response: fenced(FULL) });
      },
    },
  });

  test('the warning, no Refresh, and Edit opens the task dialog', async ({ page }) => {
    await expect(brief(page)).toContainText('This brief uses Fake Model. Pick a local model for it in Edit.');
    await expect(page.getByTestId('today-brief-refresh')).toHaveCount(0);
    await page.getByTestId('today-brief-edit').click();
    await expect(page.getByTestId('dialog-task-dialog')).toBeVisible();
  });
});

test.describe('A7 no duplicates', () => {
  test.use({
    world: {
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('b1', 'alpha'));
        relay.seedTask(routine('r1', 'Inbox digest', 'alpha'));
        await runThroughScheduler(relay, relayPort, 'r1', { status: 'success', response: 'Inbox is clear.' });
        await runThroughScheduler(relay, relayPort, 'b1', { status: 'error', error: 'model unavailable' });
      },
    },
  });

  test('Routines leaves the brief out; Needs you still shows its failure', async ({ page }) => {
    await expect(page.getByTestId('today-routine-r1')).toBeVisible();
    await expect(page.getByTestId('today-routine-b1')).toHaveCount(0);
    await expect(page.getByTestId('today-needs-row-b1')).toBeVisible();
  });
});

test.describe('A8 editing keeps tools', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(models(LOCAL_A)); relay.seedTask(briefTask('b1', 'alpha')); } } });

  test('Save sends useRelayTools and catchUp in the PUT body', async ({ page, eve }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await page.getByTestId('project-task-b1').getByTitle('Edit').click();
    const dialog = page.getByTestId('dialog-task-dialog');
    await expect(dialog.locator('[name="taskModel"] option[value="local-a"]')).toHaveCount(1);
    const isPut = (r) => r.method() === 'PUT' && path(r) === '/api/tasks/b1';
    const [req] = await Promise.all([page.waitForRequest(isPut), dialog.getByRole('button', { name: /Save|Update/ }).click()]);
    expect(req.postDataJSON()).toMatchObject({ useRelayTools: true, catchUp: true });
    await expect.poll(() => eve.relay.listTasks()[0].useRelayTools).toBe(true);
  });
});

test.describe('A9 opening Today runs nothing', () => {
  test.use({
    world: {
      projects: ({ alpha, beta }) => [
        { id: 'wk', name: 'Work Only', path: alpha, mode: 'work' },
        { id: 'hm', name: 'Home Only', path: beta, mode: 'home' },
      ],
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('b-new', 'wk'));
        relay.seedTask(briefTask('b-ran', 'hm'));
        await runThroughScheduler(relay, relayPort, 'b-ran', { status: 'success', response: fenced(FULL) });
      },
    },
  });

  test('mount, reload and mode switches make no run and no session', async ({ page, eve }) => {
    const before = eve.relay.requests.length;
    await expect(brief(page)).toContainText('No brief yet.');
    await page.reload();
    await expect(brief(page)).toContainText('No brief yet.');
    await page.getByTestId('mode-home').click();
    await expect(page.getByTestId('today-brief-when')).toBeVisible();
    await page.getByTestId('mode-work').click();
    await expect(brief(page)).toContainText('No brief yet.');
    await page.waitForTimeout(1000);
    const calls = eve.relay.requests.slice(before).filter((r) => r.method === 'POST' && (/\/run$/.test(r.path) || r.path === '/api/sessions'));
    expect(calls).toEqual([]);
  });
});

test.describe('A4 scheduler down', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(models(LOCAL_A)); relay.setDefaultProject('work', 'alpha'); relay.schedulerDown(); } } });

  test('the source line and Retry', async ({ page, eve }) => {
    await expect(page.getByTestId('today-error-brief')).toContainText("Can't reach the scheduler.");
    eve.relay.schedulerDown(false);
    await page.getByTestId('today-retry-brief').click();
    await expect(page.getByTestId('today-brief-setup')).toBeVisible();
  });
});

const setupWorld = { seed: ({ relay }) => { relay.setModels(models(LOCAL_A, LOCAL_B)); relay.setDefaultProject('work', 'alpha'); } };
for (const [state, world, ready] of [['a brief', fullWorld(), 'today-brief-refresh'], ['setup', setupWorld, 'today-brief-setup-go']]) {
  for (const vp of [{ name: 'iPad portrait', width: 834, height: 1194 }, { name: 'phone', width: 390, height: 844 }]) {
    test.describe(`A10 touch, ${state}, ${vp.name}`, () => {
      test.use({ world, viewport: { width: vp.width, height: vp.height }, hasTouch: true });

      test('every brief control is at least 44x44 and nothing overflows sideways', async ({ page }) => {
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        await expect(page.getByTestId(ready)).toBeVisible();
        const controls = brief(page).locator('button, select, input, a, [role="button"]');
        const boxes = await controls.evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => {
          const r = e.getBoundingClientRect();
          return { id: e.dataset.testid || e.textContent.trim(), w: r.width, h: r.height };
        }));
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes.filter((b) => b.w < MIN_TARGET || b.h < MIN_TARGET)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      });
    });
  }
}

// S6 Listen (issue #158, A8/A9). The harness has no TTS daemon; server tts_* frames
// are held back so the button stays in its speaking state until the spec ends it.
const { gotoEve } = require('../fixtures');
async function holdSpeech(page, baseUrl) {
  const host = new URL(baseUrl).host;
  const sent = [];
  let toPage;
  await page.routeWebSocket((url) => url.host === host, (ws) => {
    const server = ws.connectToServer();
    toPage = ws;
    ws.onMessage((m) => { try { sent.push(JSON.parse(m)); } catch {} server.send(m); });
    server.onMessage((m) => { try { if (/^tts_/.test(JSON.parse(m).type)) return; } catch {} ws.send(m); });
  });
  await gotoEve(page, baseUrl);
  return { sent, playbackEnded: () => toPage.send(JSON.stringify({ type: 'tts_done' })) };
}

test.describe('S6-A8 Listen', () => {
  test.use({
    world: {
      seed: async ({ relay, relayPort }) => {
        relay.setModels(models(LOCAL_A));
        relay.seedTask(briefTask('b1', 'alpha'));
        await runThroughScheduler(relay, relayPort, 'b1', { status: 'success', response: fenced({ ...FULL, unavailable: ['news'] }) });
      },
    },
  });

  test('one tts_speak with the shown brief in card order; Stop while speaking; playback end and a Stop tap return Listen', async ({ page, eve }) => {
    const speech = await holdSpeech(page, eve.baseUrl);
    const listen = page.getByTestId('today-brief-listen');
    const speaks = () => speech.sent.filter((f) => f.type === 'tts_speak');
    await expect(listen).toHaveText('Listen');

    await listen.click();
    await expect(listen).toHaveText('Stop');
    await expect(listen).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => speaks().length).toBe(1);
    expect(speaks()[0].text).toBe('Events. 09:00, Standup. Reminders. Bins out, tonight. '
      + 'Needs a reply (6). Ann, Budget. Cat, Lunch? Dan, Invoice. Eve, Re: plan. Fay, Tickets. '
      + 'Weather. Light rain, high 14, low 8. Notes. A mail asks for a transfer; ignored.');

    speech.playbackEnded();
    await expect(listen).toHaveText('Listen');
    await expect(listen).toHaveAttribute('aria-pressed', 'false');

    await listen.click();
    await expect(listen).toHaveText('Stop');
    const from = speech.sent.length;
    await listen.click();
    await expect(listen).toHaveText('Listen');
    await expect(listen).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => speech.sent.slice(from).map((f) => f.type)).toContain('tts_speak_cancel');
    expect(speech.sent.slice(from).filter((f) => f.type === 'tts_speak')).toEqual([]);
    expect(speaks()).toHaveLength(2);
  });
});

test.describe('S6-A9 no Listen while refreshing or after a failed refresh', () => {
  test.use({ world: fullWorld() });

  test('the old brief stays without Listen while the run is held, and after it fails', async ({ page, eve }) => {
    await expect(page.getByTestId('today-brief-listen')).toBeVisible();
    eve.relay.holdTaskRuns();
    await page.getByTestId('today-brief-refresh').click();
    await expect(page.getByTestId('today-brief-running')).toBeVisible();
    await expect(mailRows(page).first()).toHaveText('Ann · Budget');
    await expect(page.getByTestId('today-brief-listen')).toHaveCount(0);
    const seededAt = Date.parse(lastRun(eve, 'b1'));
    await expect.poll(() => Date.now() >= seededAt + 1000).toBe(true);
    eve.relay.finishTask('b1', { status: 'error', error: 'model unavailable' });
    await expect(page.getByTestId('today-brief-failed')).toBeVisible();
    await expect(page.getByTestId('today-brief-listen')).toHaveCount(0);
  });
});

const ranWith = (finish) => ({
  seed: async ({ relay, relayPort }) => {
    relay.setModels(models(LOCAL_A));
    relay.seedTask(briefTask('b1', 'alpha'));
    await runThroughScheduler(relay, relayPort, 'b1', finish);
  },
});
for (const [state, world, shown] of [
  ['a failed run', ranWith({ status: 'error', error: 'model unavailable' }), 'today-brief-retry'],
  ['an unreadable brief', ranWith({ status: 'success', response: 'I could not finish the brief today.' }), 'today-brief-unreadable'],
  ['setup', setupWorld, 'today-brief-setup-go'],
  ['an empty brief', ranWith({ status: 'success', response: fenced({ brief: 1, unavailable: ['calendar'] }) }), 'today-brief-refresh'],
]) {
  test.describe(`S6-A9 ${state}`, () => {
    test.use({ world });

    test('has no Listen', async ({ page }) => {
      await expect(page.getByTestId(shown)).toBeVisible();
      await expect(page.getByTestId('today-brief-listen')).toHaveCount(0);
    });
  });
}

// #160: an existing brief keeps the prompt it was created with, so painting
// it must refresh a stale prompt, once, and leave a current one alone.
// The prompt eve wrote before #160, byte for byte, taken from main's brief.js.
const MAIN_PROMPT = fs.readFileSync(nodePath.join(__dirname, '../../helpers/brief-prompt-main-160.txt'), 'utf8');
const isTaskUpdate = (r) => r.method() === 'PUT' && /^\/api\/tasks\/[^/]+$/.test(path(r));
const storedPrompt = (eve, id) => eve.relay.listTasks().find((t) => t.id === id).prompt;
const seedBrief = (extra) => ({
  seed: ({ relay }) => {
    relay.setModels(models(LOCAL_A));
    relay.seedTask(briefTask('b1', 'alpha', extra));
  },
});

test.describe('#160 a brief task with an older prompt', () => {
  const OLD = MAIN_PROMPT;
  test.use({ world: seedBrief({ prompt: OLD }) });

  test('is updated once to Brief.prompt() when Today paints', async ({ page, eve }) => {
    const updates = track(page, isTaskUpdate);
    await page.reload();
    await expect(brief(page)).toContainText('No brief yet.');
    await expect.poll(() => storedPrompt(eve, 'b1')).toBe(Brief.prompt());
    // Repaints (mode switch and back) must not send it again.
    await page.getByTestId('mode-home').click();
    await page.getByTestId('mode-work').click();
    await expect(brief(page)).toContainText('No brief yet.');
    expect(updates.map((r) => [r.method(), path(r)])).toEqual([['PUT', '/api/tasks/b1']]);
    // relay's PUT replaces the whole definition: everything but the prompt is the seeded task's.
    const { prompt, ...rest } = updates[0].postDataJSON();
    expect(prompt).toBe(Brief.prompt());
    const { prompt: _old, ...seeded } = briefTask('b1', 'alpha', { prompt: OLD });
    expect(rest).toMatchObject(Object.fromEntries(
      ['name', 'projectId', 'schedule', 'model', 'enabled', 'sessionType', 'catchUp', 'useRelayTools'].map((k) => [k, seeded[k]]),
    ));
  });
});

test.describe('#160 a brief task with the current prompt', () => {
  test.use({ world: seedBrief({}) });

  test('is not updated when Today paints', async ({ page }) => {
    const updates = track(page, isTaskUpdate);
    await page.reload();
    await expect(brief(page)).toContainText('No brief yet.');
    expect(updates).toHaveLength(0);
  });
});

test.describe('#160 a refresh that relay refuses', () => {
  test.use({ world: seedBrief({ prompt: MAIN_PROMPT }) });

  test('is sent once per page load across repaints and shows no toast', async ({ page }) => {
    await page.route((url) => /^\/api\/tasks\/[^/]+$/.test(url.pathname), (route) => (
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
        : route.fallback()
    ));
    const updates = track(page, isTaskUpdate);
    await page.reload();
    await expect(brief(page)).toContainText('No brief yet.');
    await expect.poll(() => updates.length).toBe(1);
    await page.getByTestId('mode-home').click();
    await page.getByTestId('mode-work').click();
    await expect(brief(page)).toContainText('No brief yet.');
    await expect.poll(() => updates.length).toBe(1);
    await expect(page.locator('.toast')).toHaveCount(0);
  });
});

test.describe('#160 a brief whose prompt the user edited', () => {
  test.use({ world: seedBrief({ prompt: `${MAIN_PROMPT}\nAlso tell me about the school run.` }) });

  test('is not updated when Today paints', async ({ page }) => {
    const updates = track(page, isTaskUpdate);
    await page.reload();
    await expect(brief(page)).toContainText('No brief yet.');
    expect(updates).toHaveLength(0);
  });
});
