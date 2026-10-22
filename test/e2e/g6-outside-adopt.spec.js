const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A live outside Claude session that relay calls adoptable offers Adopt (idle) or Interrupt and adopt (working)
// on the Agents board. One tap sends the row id and one boolean to eve, which asks relay to take the
// conversation over. Relay then lists a managed idle headless session with the row's name, and the outside row goes.
// fakerelay serves the rows from the world key `outside_sessions` (changed live with PUT /v1/outside-sessions) and
// picks each adopt outcome from the `adopt` object on each adoptable row. The adopted session has run no turn, so a real Drop in
// onto it is a real-app check; here the Drop in button showing is the proof.

const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();
const LIVE_AT = ago(0.1);
// A marker the browser must never see. A distinctive value, so a leak is found by plain search.
const SID = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';
const OTHER_SID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const oid = (n) => `outside:${String(n).padStart(32, '0')}`;
const ADOPT_ROUTE = 'POST /api/sessions/adopt';
const ADOPT_PATH = /\/api\/outside-sessions\/[^/]+\/adopt$/;
const CHIP = 'Sent by relay after it took over';
const OK_WORLD = { model_family: 'haiku' };
// A row that is still working: relay finds the registry entry busy until the interrupt clears it.
const BUSY_WORLD = { busy: 'registry_busy', model_family: 'haiku' };

const ON_HOST = "On a host, so it can't be adopted here.";
const NOT_REGISTERED = "Claude keeps no session record for it, so it can't be adopted.";
const NOT_INTERACTIVE = "Not an interactive session, so it can't be adopted.";
const NOT_COMMAND_LINE = "Not started from the command line, so it can't be adopted.";
const INVALID_ID = "Its conversation id is not valid, so it can't be adopted.";
const START_MISMATCH = "Its process changed, so it can't be adopted.";
const AMBIGUOUS = "Two processes hold this conversation, so it can't be adopted.";

// fakerelay takes `adopt` only on an adoptable row, and refuses a world where a non-adoptable row carries one.
function liveRow(dir, over = {}) {
  const row = {
    id: oid(1),
    name: 'Ledger notes',
    project_id: 'p_acme',
    host_id: null,
    machine: 'acme-console',
    directory: dir,
    branch: 'main',
    state: 'idle',
    since: LIVE_AT,
    updated_at: LIVE_AT,
    source: 'probe',
    outside: true,
    read_only: true,
    tmux_session: null,
    viewable: false,
    view_reason: 'not_in_tmux',
    latest_turn: { text: 'Still working.', at: LIVE_AT, complete: true },
    adoptable: true,
    adopt: OK_WORLD,
    claude_session_id: SID,
    ...over,
  };
  if (row.adoptable !== true) delete row.adopt;
  return row;
}

function endedRow(dir, over = {}) {
  return liveRow(dir, {
    id: oid(2),
    name: 'Old notes',
    state: 'ended',
    branch: null,
    since: ago(3),
    updated_at: ago(2),
    ended_at: ago(2),
    adoptable: false,
    adopt_reason: 'ended',
    claude_session_id: OTHER_SID,
    latest_turn: { text: 'Old notes final answer', at: ago(2), complete: true },
    ...over,
  });
}

function adoptWorld() {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.terminal_templates = [{ id: 'claude-code', name: 'Claude Code', command: '/bin/sh', description: 'Claude Code terminal' }];
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent: 'connected',
  }];
  w.projects.push({ id: 'p_box', name: 'Orchard', host_id: 'h_box', path: '/home/acme/orchard', mode: 'work', files: { 'todo.txt': 'one\n' } });
  w.outside_sessions = [];
  return w;
}

const railOf = (page) => page.getByRole('navigation', { name: 'Agents' });
const stripOf = (page) => page.getByRole('button', { name: /Agents$/ });
const adoptButton = (scope, name = 'Ledger notes') => scope.getByRole('button', { name: `Adopt ${name}`, exact: true });
const interruptButton = (scope, name = 'Ledger notes') => scope.getByRole('button', { name: `Interrupt and adopt ${name}`, exact: true });
const dropIn = (scope, name = 'Ledger notes') => scope.getByRole('button', { name: new RegExp(`^Drop in to ${name}`) });
const anyAdopt = (scope) => scope.getByRole('button', { name: /^(Interrupt and )?[Aa]dopt /, exact: false });
const toastOf = (page, text) => page.getByRole('status').filter({ hasText: text });
const adoptOk = (l) => l.status === 'ok';

async function openCos(page) {
  // Below 600px the Bottom bar is the door a person taps.
  const compact = page.viewportSize().width < 600;
  const door = compact ? page.getByRole('navigation', { name: 'Navigation' }) : page;
  await door.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

// The rows are folder-bound to the project, as relay reports them: fakerelay's own per-instance folder, read
// from its state. The rows go in through the control socket before the page opens.
async function seed(relay, build) {
  const state = await relay.json('ctl', 'state', '--json');
  const dir = state.projects.find((p) => p.id === 'p_acme').path;
  await worlds.outside.replace(relay.dir, build(dir));
  return dir;
}

async function holdSlow(relay) {
  const added = await relay.ctl('fault', 'add', '--route', ADOPT_ROUTE, '--mode', 'slow');
  expect(added.code).toBe(0);
  return JSON.parse(added.stdout).id;
}

const idleRows = (dir, adopt = OK_WORLD) => [liveRow(dir, { adopt }), endedRow(dir)];
const workingRows = (dir, state = 'running', adopt = BUSY_WORLD) => [liveRow(dir, { state, adopt })];

// One tap on a button, then the request the browser made: its body and eve's answer.
async function tapAndCapture(page, button) {
  const sent = page.waitForRequest((r) => r.method() === 'POST' && ADOPT_PATH.test(r.url()));
  await button.click();
  const request = await sent;
  return request;
}

test.describe('an idle adoptable row', () => {
  test.use({ world: adoptWorld() });

  test('shows Adopt, and an ended row beside it has only Resume @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, idleRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const adopt = adoptButton(rail);
    await expect(adopt).toBeVisible();
    await expect(adopt).toHaveText('Adopt');
    await expect(adopt).toBeEnabled();
    await expect(interruptButton(rail)).toHaveCount(0);
    // The ended row beside it offers Resume, and no adopt button or line.
    await expect(rail.getByRole('button', { name: 'Resume Old notes in a terminal', exact: true })).toBeVisible();
    await expect(adoptButton(rail, 'Old notes')).toHaveCount(0);
    await expect(anyAdopt(rail)).toHaveCount(1);
  });

  test('the tap adopts: the outside row goes and the agent shows under Idle with Drop in @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, idleRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(dropIn(rail)).toHaveCount(0);
    const request = await tapAndCapture(page, adoptButton(rail));
    // The browser sends the row id in the path and one boolean, nothing else.
    expect(decodeURIComponent(request.url())).toContain(`/api/outside-sessions/${oid(1)}/adopt`);
    expect(request.postData()).toBe('{"interrupt":false}');

    const done = await relay.waitForEvent('session.adopt', { match: adoptOk });
    expect(done.interrupted).not.toBe(true);
    await expect(dropIn(rail)).toBeVisible();
    await expect(rail.getByRole('heading', { name: /^Idle/ })).toBeVisible();
    await expect(anyAdopt(rail)).toHaveCount(0);
    // The adopted agent is one managed session now.
    const state = await relay.json('ctl', 'state', '--json');
    expect(state.sessions.filter((s) => s.name === 'Ledger notes')).toHaveLength(1);
  });

  test('the button reads Adopting until relay answers @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, idleRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const adopt = adoptButton(rail);
    await expect(adopt).toBeVisible();
    const faultId = await holdSlow(relay);
    await adopt.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    const busy = rail.getByRole('button').filter({ hasText: 'Adopting…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(dropIn(rail)).toHaveCount(0);

    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'released' });
    await expect(dropIn(rail)).toBeVisible();
    await expect(anyAdopt(rail)).toHaveCount(0);
  });

  test('a second page sees the adopted agent under Idle with Drop in @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, idleRows);
    await eve.open('/');
    await openCos(page);
    await adoptButton(railOf(page)).click();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    const other = await eve.openAnother('/');
    await openCos(other);
    await expect(dropIn(railOf(other))).toBeVisible();
    await expect(anyAdopt(railOf(other))).toHaveCount(0);
  });
});

test.describe('a working adoptable row', () => {
  test.use({ world: adoptWorld() });

  for (const state of ['running', 'asking']) {
    test(`a ${state} row shows Interrupt and adopt instead of Adopt @G6.108`, async ({ eve, page, relay }) => {
      await seed(relay, (dir) => workingRows(dir, state));
      await eve.open('/');
      await openCos(page);
      const rail = railOf(page);
      const interrupt = interruptButton(rail);
      await expect(interrupt).toBeVisible();
      await expect(interrupt).toHaveText('Interrupt and adopt');
      await expect(interrupt).toBeEnabled();
      await expect(adoptButton(rail)).toHaveCount(0);
    });
  }

  test('the tap interrupts, adopts, and the thread opens with relay\'s marked message @G6.108', async ({ eve, page, relay }) => {
    await seed(relay, workingRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const request = await tapAndCapture(page, interruptButton(rail));
    expect(decodeURIComponent(request.url())).toContain(`/api/outside-sessions/${oid(1)}/adopt`);
    expect(request.postData()).toBe('{"interrupt":true}');

    const done = await relay.waitForEvent('session.adopt', { match: adoptOk });
    expect(done.interrupted).toBe(true);
    await expect(dropIn(rail)).toBeVisible();
    await expect(anyAdopt(rail)).toHaveCount(0);

    // Relay sent one message as the owner could not; the thread marks it.
    await rail.getByRole('button', { name: 'Ledger notes', exact: true }).click();
    await expect(page.getByText(CHIP, { exact: true })).toBeVisible();
  });

  test('the button reads Interrupting until relay answers @G6.108', async ({ eve, page, relay }) => {
    await seed(relay, workingRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const interrupt = interruptButton(rail);
    await expect(interrupt).toBeVisible();
    const faultId = await holdSlow(relay);
    await interrupt.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    const busy = rail.getByRole('button').filter({ hasText: 'Interrupting…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');

    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'released' });
    await expect(dropIn(rail)).toBeVisible();
  });
});

test.describe('a row relay says is not adoptable', () => {
  test.use({ world: adoptWorld() });

  const refused = (dir) => [
    liveRow(dir),
    liveRow(dir, { id: oid(11), name: 'Orphan notes', project_id: null, directory: '/elsewhere', adoptable: false, adopt_reason: 'not_registered', claude_session_id: OTHER_SID }),
    liveRow(dir, { id: oid(12), name: 'Orchard review', project_id: 'p_box', host_id: 'h_box', machine: 'testbox', directory: '/home/acme/orchard', adoptable: false, adopt_reason: 'host_unsupported' }),
    liveRow(dir, { id: oid(13), name: 'Piped run', adoptable: false, adopt_reason: 'not_interactive', claude_session_id: OTHER_SID }),
    liveRow(dir, { id: oid(14), name: 'Editor run', state: 'running', adoptable: false, adopt_reason: 'not_command_line', claude_session_id: OTHER_SID }),
    liveRow(dir, { id: oid(16), name: 'Moved run', adoptable: false, adopt_reason: 'start_mismatch', claude_session_id: OTHER_SID }),
    liveRow(dir, { id: oid(17), name: 'Odd id run', adoptable: false, adopt_reason: 'invalid_id', claude_session_id: OTHER_SID }),
    liveRow(dir, { id: oid(18), name: 'Twin run', adoptable: false, adopt_reason: 'ambiguous', claude_session_id: OTHER_SID }),
  ];

  async function expectRefusedRows(scope) {
    // The adoptable row has its button: the marker that the board has loaded every row.
    await expect(adoptButton(scope)).toBeVisible();
    await expect(scope.getByRole('button', { name: 'Orphan notes', exact: true })).toBeVisible();
    await expect(scope.getByRole('button', { name: 'Twin run', exact: true })).toBeVisible();
    await expect(scope.getByText(ON_HOST)).toBeVisible();
    await expect(scope.getByText(NOT_INTERACTIVE)).toBeVisible();
    await expect(scope.getByText(NOT_COMMAND_LINE)).toBeVisible();
    await expect(scope.getByText(NOT_REGISTERED)).toBeVisible();
    await expect(scope.getByText(START_MISMATCH)).toBeVisible();
    await expect(scope.getByText(INVALID_ID)).toBeVisible();
    await expect(scope.getByText(AMBIGUOUS)).toBeVisible();
    for (const name of ['Orphan notes', 'Orchard review', 'Piped run', 'Editor run', 'Moved run', 'Odd id run', 'Twin run']) {
      await expect(adoptButton(scope, name)).toHaveCount(0);
      await expect(interruptButton(scope, name)).toHaveCount(0);
    }
    await expect(anyAdopt(scope)).toHaveCount(1);
  }

  test('no button, one line says why @G6.107.r1', async ({ eve, page, relay }) => {
    await seed(relay, refused);
    await eve.open('/');
    await openCos(page);
    await expectRefusedRows(railOf(page));
  });

  test('a working row has no Interrupt and adopt, and the same line @G6.108.r1', async ({ eve, page, relay }) => {
    await seed(relay, refused);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(adoptButton(rail)).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Editor run', exact: true })).toBeVisible();
    await expect(rail.getByText(NOT_COMMAND_LINE)).toBeVisible();
    await expect(interruptButton(rail, 'Editor run')).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /^Interrupt and adopt /, exact: false })).toHaveCount(0);
  });
});

test.describe('an ended row', () => {
  test.use({ world: adoptWorld() });

  test('never has an adopt button or line @G6.107.r1', async ({ eve, page, relay }) => {
    await seed(relay, (dir) => [endedRow(dir), endedRow(dir, { id: oid(24), name: 'Older notes' })]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(rail.getByRole('button', { name: 'Resume Old notes in a terminal', exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Resume Older notes in a terminal', exact: true })).toBeVisible();
    await expect(anyAdopt(rail)).toHaveCount(0);
    await expect(rail.getByText(/can't be adopted/)).toHaveCount(0);
  });
});

test.describe('relay refuses the adopt', () => {
  test.describe('with the process changed, idle', () => {
    test.use({ world: adoptWorld() });

    test('the toast gives its reason on one line and the button is back @G6.107.r2', async ({ eve, page, relay }) => {
      await seed(relay, (dir) => idleRows(dir, { ...OK_WORLD, refuse: 'changed' }));
      await eve.open('/');
      await openCos(page);
      const rail = railOf(page);
      const adopt = adoptButton(rail);
      await expect(adopt).toBeVisible();
      await adopt.click();
      const logged = await relay.waitForEvent('session.adopt');
      expect(logged.status).not.toBe('ok');
      const toast = toastOf(page, "Can't adopt: the process or its registry entry changed");
      await expect(toast).toBeVisible();
      expect((await toast.textContent()).replace(/×$/, '')).toBe("Can't adopt: the process or its registry entry changed");
      await expect(adopt).toBeEnabled();
      await expect(adopt).toHaveText('Adopt');
      await expect(dropIn(rail)).toHaveCount(0);
    });
  });

  test.describe('with the process changed, working', () => {
    test.use({ world: adoptWorld() });

    test('Interrupt and adopt: the same toast and the button is back @G6.108.r2', async ({ eve, page, relay }) => {
      await seed(relay, (dir) => workingRows(dir, 'running', { ...BUSY_WORLD, refuse: 'changed' }));
      await eve.open('/');
      await openCos(page);
      const rail = railOf(page);
      const interrupt = interruptButton(rail);
      await expect(interrupt).toBeVisible();
      await interrupt.click();
      const logged = await relay.waitForEvent('session.adopt');
      expect(logged.status).not.toBe('ok');
      await expect(toastOf(page, "Can't adopt: the process or its registry entry changed")).toBeVisible();
      await expect(interrupt).toBeEnabled();
      await expect(interrupt).toHaveText('Interrupt and adopt');
      await expect(dropIn(rail)).toHaveCount(0);
    });
  });

  test.describe('with no model known', () => {
    test.use({ world: adoptWorld() });

    test('relay\'s model text shows as the reason @G6.107.r2', async ({ eve, page, relay }) => {
      await seed(relay, (dir) => idleRows(dir, {}));
      await eve.open('/');
      await openCos(page);
      const adopt = adoptButton(railOf(page));
      await expect(adopt).toBeVisible();
      await adopt.click();
      const logged = await relay.waitForEvent('session.adopt');
      expect(logged.status).not.toBe('ok');
      const toast = toastOf(page, /^Can't adopt: .*model/);
      await expect(toast).toBeVisible();
      expect((await toast.textContent())).not.toMatch(/\n/);
      await expect(adopt).toBeEnabled();
      await expect(dropIn(railOf(page))).toHaveCount(0);
    });
  });

  test.describe('with the session busy', () => {
    test.use({ world: adoptWorld() });

    test('Adopt on an idle row that relay finds busy: the busy reason, and eve sent no interrupt @G6.107.r2', async ({ eve, page, relay }) => {
      await seed(relay, (dir) => idleRows(dir, BUSY_WORLD));
      await eve.open('/');
      await openCos(page);
      const rail = railOf(page);
      const adopt = adoptButton(rail);
      await expect(adopt).toBeVisible();
      const request = await tapAndCapture(page, adopt);
      expect(request.postData()).toBe('{"interrupt":false}');
      const logged = await relay.waitForEvent('session.adopt');
      expect(logged.status).not.toBe('ok');
      expect(logged.interrupted).not.toBe(true);
      await expect(toastOf(page, /^Can't adopt: /)).toBeVisible();
      await expect(adopt).toBeEnabled();
      await expect(dropIn(rail)).toHaveCount(0);
    });
  });
});

test.describe('the browser sends only the row id', () => {
  test.use({ world: adoptWorld() });

  test('no frame, response or page text carries the Claude session id @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, idleRows);
    const frames = [];
    const bodies = [];
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => { frames.push(String(frame.payload)); });
    });
    page.on('response', (res) => {
      bodies.push(res.text().catch(() => ''));
    });
    await eve.open('/');
    await openCos(page);
    const adopt = adoptButton(railOf(page));
    await expect(adopt).toBeVisible();
    const sent = page.waitForResponse((r) => ADOPT_PATH.test(r.url()));
    await adopt.click();
    const answer = await sent;
    expect(answer.status()).toBe(201);
    const body = await answer.json();
    expect(typeof body.sessionId).toBe('string');
    expect(Object.keys(body)).not.toContain('claudeSessionId');
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(dropIn(railOf(page))).toBeVisible();
    // The row reached the page, so the search below looks at real traffic.
    expect(frames.some((f) => f.includes('Ledger notes'))).toBe(true);
    expect(frames.filter((f) => f.includes(SID) || f.includes(OTHER_SID))).toEqual([]);
    const texts = await Promise.all(bodies);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((t) => t.includes(SID) || t.includes(OTHER_SID))).toEqual([]);
    await expect(page.getByText(SID)).toHaveCount(0);
  });
});

test.describe('the adopt route', () => {
  test.use({ world: adoptWorld() });

  // The button always sends a good request, so a call to the route is the only door to these refusals.
  async function adoptCall(eve, id, body) {
    const answer = await fetch(`${eve.url}/api/outside-sessions/${encodeURIComponent(id)}/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: answer.status, body: await answer.json() };
  }

  test('a bad row id answers 400 and calls no relay @G6.107.r2', async ({ eve, relay }) => {
    await seed(relay, idleRows);
    const mark = await relay.mark();
    const upper = `outside:${'A'.repeat(32)}`;
    const short = `outside:${'a'.repeat(31)}`;
    const long = `outside:${'a'.repeat(33)}`;
    for (const id of ['nope', 'outside:', 'outside:a b', 'inside:e1', upper, short, long, 'outside:e1']) {
      const answer = await adoptCall(eve, id, { interrupt: false });
      expect(answer.status, id).toBe(400);
      expect(answer.body.error, id).toBe('invalid_request');
    }
    expect(await relay.logs({ event: 'session.adopt', since: mark })).toHaveLength(0);
  });

  test('an interrupt that is not true or false answers 400 and calls no relay @G6.107.r2', async ({ eve, relay }) => {
    await seed(relay, idleRows);
    const mark = await relay.mark();
    const bad = [{}, { interrupt: 'true' }, { interrupt: 'false' }, { interrupt: 1 }, { interrupt: 0 }, { interrupt: null }, { interrupt: [] }, { interrupt: {} }, { other: true }];
    for (const body of bad) {
      const answer = await adoptCall(eve, oid(1), body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error, JSON.stringify(body)).toBe('interrupt must be true or false');
    }
    expect(await relay.logs({ event: 'session.adopt', since: mark })).toHaveLength(0);
  });

  test('a good call answers 201 without the Claude session id, and extra body keys are not forwarded @G6.107', async ({ eve, relay }) => {
    await seed(relay, idleRows);
    // fakerelay refuses the chief-of-staff scope on this door, so a 201 shows eve sent none.
    const answer = await adoptCall(eve, oid(1), { interrupt: false, claudeSessionId: OTHER_SID, model: 'opus', scope: 'chief-of-staff' });
    expect(answer.status).toBe(201);
    expect(typeof answer.body.sessionId).toBe('string');
    expect(answer.body.interrupted).toBe(false);
    expect(answer.body.recoverySent).toBe(false);
    expect(Object.keys(answer.body)).not.toContain('claudeSessionId');
    expect(JSON.stringify(answer.body)).not.toContain(SID);
    expect(JSON.stringify(answer.body)).not.toContain(OTHER_SID);
    // Relay judged the row it holds, not the id the caller named.
    const logged = await relay.waitForEvent('session.adopt', { match: adoptOk });
    expect(logged.outside_id).toBe(oid(1));
    expect(logged.claude_session_id).toBe(SID);
  });

  test('a refusal from relay keeps its status and reason @G6.107.r2', async ({ eve, relay }) => {
    await seed(relay, idleRows);
    const answer = await adoptCall(eve, oid(99), { interrupt: false });
    expect(answer.status).toBe(404);
    expect(answer.body.error).toBe('outside_session_not_found');
    expect(typeof answer.body.message).toBe('string');
    const logged = await relay.waitForEvent('session.adopt');
    expect(logged.status).not.toBe('ok');
  });
});

test.describe('on a phone, an idle row', () => {
  test.use({ ...profiles.phone, world: adoptWorld() });

  test('tap Adopt in the agents sheet: the sheet stays open and shows Drop in @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, idleRows);
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const adopt = adoptButton(sheet);
    await expect(adopt).toBeVisible();
    const box = await adopt.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(interruptButton(sheet)).toHaveCount(0);
    await adopt.tap();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(dropIn(sheet)).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: /^Idle/ })).toBeVisible();
    await expect(anyAdopt(sheet)).toHaveCount(0);
  });

});

test.describe('on a phone, a working row', () => {
  test.use({ ...profiles.phone, world: adoptWorld() });

  test('the sheet shows Interrupt and adopt, 44 px tall @G6.108', async ({ eve, page, relay }) => {
    await seed(relay, workingRows);
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const interrupt = interruptButton(sheet);
    await expect(interrupt).toBeVisible();
    expect((await interrupt.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(adoptButton(sheet)).toHaveCount(0);
    await interrupt.tap();
    const done = await relay.waitForEvent('session.adopt', { match: adoptOk });
    expect(done.interrupted).toBe(true);
    await expect(dropIn(sheet)).toBeVisible();
    await expect(sheet).toBeVisible();
  });
});

test.describe('on a phone, rows relay says are not adoptable', () => {
  test.use({ ...profiles.phone, world: adoptWorld() });

  test('the sheet shows each line and no button @G6.107.r1', async ({ eve, page, relay }) => {
    await seed(relay, (dir) => [
      liveRow(dir),
      liveRow(dir, { id: oid(11), name: 'Orphan notes', project_id: null, directory: '/elsewhere', adoptable: false, adopt_reason: 'not_registered', claude_session_id: OTHER_SID }),
      liveRow(dir, { id: oid(13), name: 'Piped run', adoptable: false, adopt_reason: 'not_interactive', claude_session_id: OTHER_SID }),
    ]);
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await expect(adoptButton(sheet)).toBeVisible();
    await expect(sheet.getByText(NOT_REGISTERED)).toBeVisible();
    await expect(sheet.getByText(NOT_INTERACTIVE)).toBeVisible();
    await expect(adoptButton(sheet, 'Orphan notes')).toHaveCount(0);
    await expect(adoptButton(sheet, 'Piped run')).toHaveCount(0);
    await expect(anyAdopt(sheet)).toHaveCount(1);
  });
});

test.describe('on a phone, when relay refuses', () => {
  test.use({ ...profiles.phone, world: adoptWorld() });

  test('the sheet closes and the toast shows the reason @G6.107.r2', async ({ eve, page, relay }) => {
    await seed(relay, (dir) => idleRows(dir, { ...OK_WORLD, refuse: 'changed' }));
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const adopt = adoptButton(sheet);
    await expect(adopt).toBeVisible();
    await adopt.tap();
    await relay.waitForEvent('session.adopt');
    await expect(toastOf(page, "Can't adopt: the process or its registry entry changed")).toBeVisible();
    await expect(sheet).toBeHidden();
    await stripOf(page).tap();
    await expect(adoptButton(page.getByRole('dialog', { name: 'Agents' }))).toBeEnabled();
  });
});

// A Claude in no project: relay marks it adoptable like any other, runs it with no sandbox and no project
// policy, and lists the managed session and its drop-in terminal with `unsandboxed: true`. fakerelay sets the
// mark only through that adopt, so every chip below is reached by tapping Adopt.
const LOOSE_DIR = '/elsewhere/loose-notes';
const CHIP_TEXT = 'Unsandboxed';
const CHIP_WHY = 'Runs with no sandbox and no project policy.';
const DROP_TAB = /\(drop-in\)$/;
const CLOSE_DROP = /^Close .*\(drop-in\)$/;

const looseRow = (over = {}) => liveRow(null, {
  id: oid(3),
  name: 'Loose notes',
  project_id: null,
  directory: LOOSE_DIR,
  claude_session_id: OTHER_SID,
  ...over,
});
const chipsOf = (scope) => scope.getByText(CHIP_TEXT, { exact: true });
const bothRows = (dir) => [liveRow(dir), looseRow()];

test.describe('an idle Claude row in no project', () => {
  test.use({ world: adoptWorld() });

  test('offers Adopt, and the tap sends only the interrupt flag with no confirm step @G6.107', async ({ eve, page, relay }) => {
    await seed(relay, () => [looseRow()]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const adopt = adoptButton(rail, 'Loose notes');
    await expect(adopt).toBeVisible();
    await expect(adopt).toHaveText('Adopt');
    await expect(adopt).toBeEnabled();
    await expect(interruptButton(rail, 'Loose notes')).toHaveCount(0);
    await expect(rail.getByText(/can't be adopted/)).toHaveCount(0);
    const request = await tapAndCapture(page, adopt);
    expect(decodeURIComponent(request.url())).toContain(`/api/outside-sessions/${oid(3)}/adopt`);
    expect(request.postData()).toBe('{"interrupt":false}');
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(dropIn(rail, 'Loose notes')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('a working Claude row in no project', () => {
  test.use({ world: adoptWorld() });

  test('offers Interrupt and adopt, and the tap sends interrupt true with no confirm step @G6.108', async ({ eve, page, relay }) => {
    await seed(relay, () => [looseRow({ state: 'running', adopt: BUSY_WORLD })]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const interrupt = interruptButton(rail, 'Loose notes');
    await expect(interrupt).toBeVisible();
    await expect(interrupt).toHaveText('Interrupt and adopt');
    await expect(adoptButton(rail, 'Loose notes')).toHaveCount(0);
    const request = await tapAndCapture(page, interrupt);
    expect(request.postData()).toBe('{"interrupt":true}');
    const done = await relay.waitForEvent('session.adopt', { match: adoptOk });
    expect(done.interrupted).toBe(true);
    await expect(dropIn(rail, 'Loose notes')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('adopting a Claude in no project', () => {
  test.use({ world: adoptWorld() });

  test('the outside row goes and the managed row shows the chip and Drop in @G6.109', async ({ eve, page, relay }) => {
    await seed(relay, () => [looseRow()]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(rail.getByText(/Outside · /)).toBeVisible();
    await expect(chipsOf(rail)).toHaveCount(0);
    await adoptButton(rail, 'Loose notes').click();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(dropIn(rail, 'Loose notes')).toBeVisible();
    await expect(rail.getByText(/Outside · /)).toHaveCount(0);
    await expect(anyAdopt(rail)).toHaveCount(0);
    await expect(chipsOf(rail)).toHaveCount(1);
  });
});

test.describe('on a phone, adopting a Claude in no project', () => {
  test.use({ ...profiles.phone, world: adoptWorld() });

  test('on a phone the Agents dialog shows the chip @G6.109', async ({ eve, page, relay }) => {
    await seed(relay, () => [looseRow()]);
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await adoptButton(sheet, 'Loose notes').tap();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(dropIn(sheet, 'Loose notes')).toBeVisible();
    await expect(chipsOf(sheet)).toHaveCount(1);
  });
});

test.describe('a session relay marks unsandboxed', () => {
  test.use({ world: adoptWorld() });

  test('shows the chip with its name and description; an unmarked session beside it shows none @G6.109', async ({ eve, page, relay }) => {
    await seed(relay, bothRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    // The project row first: its managed session carries no mark, so no chip.
    await adoptButton(rail).click();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(dropIn(rail)).toBeVisible();
    await expect(chipsOf(rail)).toHaveCount(0);
    await adoptButton(rail, 'Loose notes').click();
    await expect(dropIn(rail, 'Loose notes')).toBeVisible();
    const chip = chipsOf(rail);
    await expect(chip).toHaveCount(1);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAccessibleDescription(CHIP_WHY);
    // Not a control: nothing to tap or tab to.
    await expect(rail.getByRole('button', { name: CHIP_TEXT })).toHaveCount(0);
  });

  test('the chip stays after a reload @G6.109', async ({ eve, page, relay }) => {
    await seed(relay, () => [looseRow()]);
    await eve.open('/');
    await openCos(page);
    await adoptButton(railOf(page), 'Loose notes').click();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(chipsOf(railOf(page))).toHaveCount(1);
    await eve.reload();
    await openCos(page);
    const rail = railOf(page);
    await expect(dropIn(rail, 'Loose notes')).toBeVisible();
    await expect(chipsOf(rail)).toHaveCount(1);
    await expect(chipsOf(rail)).toHaveAccessibleDescription(CHIP_WHY);
  });

  test('the chip stays through drop in and hand back, and shows on the drop-in terminal row @G6.109', async ({ eve, page, relay }) => {
    await seed(relay, () => [looseRow()]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await adoptButton(rail, 'Loose notes').click();
    await relay.waitForEvent('session.adopt', { match: adoptOk });
    await expect(chipsOf(rail)).toHaveCount(1);

    await dropIn(rail, 'Loose notes').click();
    await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
    await expect(page.getByRole('tab', { name: DROP_TAB })).toHaveAttribute('aria-selected', 'true');
    // The held session row and the drop-in terminal row each carry the chip.
    await expect(chipsOf(rail)).toHaveCount(2);

    await page.getByRole('button', { name: CLOSE_DROP }).click();
    await expect(page.getByRole('tab', { name: DROP_TAB })).toHaveCount(0);
    // Hand back: the session is Idle again with its Drop in, and the terminal row is gone.
    await expect(dropIn(rail, 'Loose notes')).toBeVisible();
    await expect(rail.getByRole('heading', { name: /^Idle/ })).toBeVisible();
    await expect(chipsOf(rail)).toHaveCount(1);
  });
});
