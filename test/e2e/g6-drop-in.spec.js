const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// An idle headless Claude agent comes from a Chief of Staff Start card for a chat template on model haiku.
// The pinned fakerelay cannot hold a Claude turn, so the Working state is reached the way a person reaches
// it from a second device: another page's drop-in terminal holds the session, and relay reads it as running.
// Its drop-in terminal is an echo terminal with no transcript, so the earlier history is a real-app check.

const LATER = '2026-10-13T10:00:00Z';

const DROP = /^Drop in to .*Reviewer$/;
const TAKE = /^Take over .*Reviewer after this turn$/;
const DROP_TAB = /\(drop-in\)$/;
const CLOSE_DROP = /^Close .*\(drop-in\)$/;
const REFUSED_HELD = "Can't drop in: a terminal already has this session; close it first";
const DROP_ROUTE = 'POST /api/sessions/{id}/drop-in';

function agentWorld() {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.projects[0].chat_templates = [{ id: 't_review', name: 'Reviewer', model: 'haiku' }];
  // An ordinary thread: idle, but not a headless agent.
  w.sessions = [
    { id: 's_ledger', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' }] },
  ];
  w.terminal_templates = [{ id: 'claude-code', name: 'Claude Code', command: '/bin/sh', description: 'Claude Code terminal' }];
  return w;
}

function startCard() {
  return {
    v: 1,
    id: 'c_start',
    at: new Date().toISOString(),
    kind: 'start_card',
    byModel: true,
    card: {
      state: 'pending', project: { id: 'p_acme', name: 'Acme' }, folder: null, model: null, entry: 'Reviewer',
      mode: 'headless', prompt: 'review the readme', why: 'read_not_verbatim', turnId: 't_1', result: null, error: null,
    },
  };
}

function outsideRow(over = {}) {
  return {
    id: 'outside:c1',
    name: 'Ledger notes',
    project_id: 'p_acme',
    host_id: null,
    machine: 'acme-console',
    directory: '/work/acme',
    branch: 'main',
    state: 'running',
    since: LATER,
    updated_at: LATER,
    source: 'probe',
    outside: true,
    read_only: true,
    tmux_session: 'ledger-1',
    viewable: true,
    view_reason: '',
    latest_turn: { text: 'The ledger totals match.', at: LATER, complete: true },
    ...over,
  };
}

function outsideWorld() {
  const w = agentWorld();
  w.outside_sessions = [
    outsideRow(),
    outsideRow({ id: 'outside:c2', name: 'Scratch pad', directory: '/work/scratch', branch: 'wip', state: 'idle', tmux_session: null, viewable: false, view_reason: 'not_in_tmux' }),
  ];
  return w;
}

const railOf = (page) => page.getByRole('navigation', { name: 'Agents' });
const stripOf = (page) => page.getByRole('button', { name: /Agents$/ });
const selectedDropTab = (page) => page.getByRole('tab', { name: DROP_TAB });
const toastOf = (page, text) => page.getByRole('status').filter({ hasText: text });

// A phone has no tab bar: the open terminal is the whole screen, titled with its name.
async function expectPhoneDropTerminal(page) {
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
  await expect(page.getByText('Acme - Reviewer (drop-in)', { exact: true }).filter({ visible: true })).toBeVisible();
}

async function openCos(page) {
  // Below 600px the Bottom bar is the door a person taps.
  const compact = page.viewportSize().width < 600;
  const door = compact ? page.getByRole('navigation', { name: 'Navigation' }) : page;
  await door.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

// Taps Start on the card; the agent's headless turn runs and leaves it idle.
async function startAgent(page, relay) {
  const card = page.getByRole('article');
  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await relay.waitForEvent('chief_of_staff.start');
}

// Starts the agent from a wide page and waits until it rests, so the Drop in button is the signal the turn ended.
async function startIdleOnWide(page, relay) {
  await openCos(page);
  await startAgent(page, relay);
  await expect(railOf(page).getByRole('button', { name: DROP })).toBeVisible();
}

async function holdSlow(relay) {
  const added = await relay.ctl('fault', 'add', '--route', DROP_ROUTE, '--mode', 'slow');
  expect(added.code).toBe(0);
  return JSON.parse(added.stdout).id;
}

async function refuseWith(relay, body) {
  const added = await relay.ctl('fault', 'add', '--route', DROP_ROUTE, '--mode', 'error', '--status', '409', '--body', JSON.stringify(body));
  expect(added.code).toBe(0);
}

// Page A starts the agent and drops in from the rail, so it holds the session. Returns once relay says ok.
async function holdFromPageA(page, relay) {
  await startIdleOnWide(page, relay);
  await railOf(page).getByRole('button', { name: DROP }).click();
  await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
  await expect(selectedDropTab(page)).toHaveAttribute('aria-selected', 'true');
}

test.describe('an idle agent', () => {
  test.use({ world: agentWorld(), cosPosts: [startCard()] });

  test('Today offers Drop in to an idle agent @G6.23', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    const board = await eve.openAnother('/');
    await expect(board.getByRole('heading', { name: /^Idle/, level: 4 })).toBeVisible();
    await expect(board.getByRole('button', { name: DROP })).toBeVisible();
  });

  test('the rail offers Drop in to an idle agent @G6.41', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    await expect(railOf(page).getByRole('heading', { name: /^Idle/ })).toBeVisible();
    await expect(railOf(page).getByRole('button', { name: DROP })).toBeEnabled();
  });

  test('a thread that is not a headless agent has no Drop in @G6.23.r3', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    const board = await eve.openAnother('/');
    // The agent's button is the marker that the board has loaded both rows.
    await expect(board.getByRole('button', { name: DROP })).toBeVisible();
    // Today also lists Ledger under Continue; the board's row is the one that reads its state.
    await expect(board.getByRole('button', { name: 'Ledger', exact: true }).filter({ hasText: 'idle' })).toBeVisible();
    await expect(board.getByRole('button', { name: /^Drop in to Ledger/ })).toHaveCount(0);
    await expect(board.getByRole('button', { name: /^Take over Ledger/ })).toHaveCount(0);
  });

  test('the rail has no Drop in on a thread that is not a headless agent @G6.41.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    const rail = railOf(page);
    await expect(rail.getByRole('button', { name: 'Ledger', exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: /^Drop in to Ledger/ })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /^Take over Ledger/ })).toHaveCount(0);
  });

  test('the rail shows relay\'s reason when it refuses @G6.41.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    await refuseWith(relay, { error: 'tool_running', message: 'a tool is running (Bash); wait for it to finish or stop the turn, then try again' });
    await railOf(page).getByRole('button', { name: DROP }).click();
    await expect(toastOf(page, "Can't drop in: a tool is running (Bash); wait for it to finish or stop the turn, then try again")).toBeVisible();
    await expect(selectedDropTab(page)).toHaveCount(0);
  });

  test('Drop in from the rail opens its terminal @G6.41', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    await railOf(page).getByRole('button', { name: DROP }).click();
    await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
    await expect(selectedDropTab(page)).toHaveAttribute('aria-selected', 'true');
  });

  test('closing the terminal hands the agent back to Idle with its Drop in @G6.24', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdFromPageA(page, relay);
    const board = await eve.openAnother('/');
    // Working counts the headless agent and the drop-in terminal row that holds it.
    await expect(board.getByRole('heading', { name: 'Working 2', level: 4 })).toBeVisible();
    await page.getByRole('button', { name: CLOSE_DROP }).click();
    await expect(selectedDropTab(page)).toHaveCount(0);
    await expect(board.getByRole('heading', { name: 'Idle 2', level: 4 })).toBeVisible();
    await expect(board.getByRole('heading', { name: /^Working/, level: 4 })).toBeHidden();
    await expect(board.getByRole('button', { name: DROP })).toBeVisible();
  });

  test('the button reads Dropping in until relay answers @G6.23', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    const board = await eve.openAnother('/');
    const drop = board.getByRole('button', { name: DROP });
    await expect(drop).toBeVisible();
    const faultId = await holdSlow(relay);
    await drop.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    const busy = board.getByRole('button').filter({ hasText: 'Dropping in…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
    await expect(selectedDropTab(board)).toHaveAttribute('aria-selected', 'true');
  });

  test('a tool is running: one line with relay\'s reason @G6.23.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    const board = await eve.openAnother('/');
    const drop = board.getByRole('button', { name: DROP });
    await expect(drop).toBeVisible();
    await refuseWith(relay, { error: 'tool_running', message: 'a tool is running (Bash); wait for it to finish or stop the turn, then try again' });
    await drop.click();
    await expect(toastOf(board, "Can't drop in: a tool is running (Bash); wait for it to finish or stop the turn, then try again")).toBeVisible();
    await expect(selectedDropTab(board)).toHaveCount(0);
    await expect(drop).toBeEnabled();
  });

  test('no conversation yet: one line with relay\'s reason @G6.23.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await startIdleOnWide(page, relay);
    const board = await eve.openAnother('/');
    const drop = board.getByRole('button', { name: DROP });
    await expect(drop).toBeVisible();
    await refuseWith(relay, { error: 'no_conversation', message: 'the session has not run a turn yet;\n  there is nothing to take over' });
    await drop.click();
    // Relay's text had a line break; the toast shows it as one line.
    const toast = toastOf(board, "Can't drop in: the session has not run a turn yet");
    await expect(toast).toBeVisible();
    // Locator text matching normalizes whitespace, so read the raw text (less the toast's close mark).
    expect((await toast.textContent()).replace(/×$/, '')).toBe("Can't drop in: the session has not run a turn yet; there is nothing to take over");
    await expect(selectedDropTab(board)).toHaveCount(0);
  });
});

test.describe('a working agent', () => {
  test.use({ world: agentWorld(), cosPosts: [startCard()] });

  test('Take over waits for the turn to end, then opens a terminal @G6.105', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdFromPageA(page, relay);
    const other = await eve.openAnother('/');
    await expect(other.getByRole('heading', { name: /^Working/, level: 4 })).toBeVisible();
    const take = other.getByRole('button', { name: TAKE });
    await expect(take).toBeVisible();
    await expect(other.getByRole('button', { name: DROP })).toHaveCount(0);

    const faultId = await holdSlow(relay);
    const mark = await relay.mark();
    await take.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    const waiting = other.getByRole('button').filter({ hasText: 'Waiting for the turn to end…' });
    await expect(waiting).toBeDisabled();
    await expect(waiting).toHaveAttribute('aria-busy', 'true');
    await expect(selectedDropTab(other)).toHaveCount(0);

    // Page A closes its terminal: the turn is over, then relay may answer.
    await page.getByRole('button', { name: CLOSE_DROP }).click();
    // Ledger already sits under Idle, so the Working group emptying is the hand-back signal.
    await expect(other.getByRole('heading', { name: /^Working/, level: 4 })).toBeHidden();
    // The busy text follows the kind fixed at the tap, not the row's new state.
    await expect(waiting).toBeDisabled();
    await expect(waiting).toHaveText('Waiting for the turn to end…');
    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await relay.waitForEvent('session.drop_in', { since: mark, match: (l) => l.status === 'ok' });
    await expect(selectedDropTab(other)).toHaveAttribute('aria-selected', 'true');
  });

  test('relay refuses a take over while another terminal holds it @G6.105.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdFromPageA(page, relay);
    const other = await eve.openAnother('/');
    const take = other.getByRole('button', { name: TAKE });
    await expect(take).toBeVisible();
    await take.click();
    await expect(toastOf(other, REFUSED_HELD)).toBeVisible();
    await expect(selectedDropTab(other)).toHaveCount(0);
    await expect(take).toBeEnabled();
  });

  test('a session this page holds has no Take over here @G6.105.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdFromPageA(page, relay);
    // Another page shows Take over for the same session: that is the marker that the group is Working.
    const other = await eve.openAnother('/');
    await expect(other.getByRole('button', { name: TAKE })).toBeVisible();
    await page.getByRole('tab', { name: 'Chief of Staff', exact: true }).click();
    const rail = railOf(page);
    await expect(rail.getByRole('heading', { name: /^Working/ })).toBeVisible();
    await expect(rail.getByRole('button', { name: /^(?!Take over|Drop in)(?!.*\(drop-in\)).*Reviewer/ })).toBeVisible();
    await expect(rail.getByRole('button', { name: /^Take over / })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /^Drop in to / })).toHaveCount(0);
  });
});

test.describe('outside rows', () => {
  test.use({ world: outsideWorld() });

  test('a read-only outside row never shows Drop in or Take over @G6.23.r3 @G6.105.r3', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    // One working and one idle outside row; both rows are the marker that the rail has loaded.
    await expect(rail.getByRole('button', { name: 'Ledger notes', exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Scratch pad', exact: true })).toBeVisible();
    await expect(rail.getByRole('button', { name: /^Drop in/ })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /^Take over/ })).toHaveCount(0);
  });
});

test.describe('on a tablet', () => {
  test.use({ ...profiles.tablet, world: agentWorld(), cosPosts: [startCard()] });

  test('tap Drop in on Today, type into the terminal, close it @G6.23', async ({ eve, page, relay }) => {
    await eve.open('/');
    // The agent is started from a wide window; the board below is read at tablet width.
    await page.setViewportSize({ width: 1280, height: 800 });
    await startIdleOnWide(page, relay);
    const board = await eve.openAnother('/');
    const drop = board.getByRole('button', { name: DROP });
    await expect(drop).toBeVisible();
    await drop.tap();
    await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
    await expect(selectedDropTab(board)).toHaveAttribute('aria-selected', 'true');
    await expect(board.getByText('Read-only')).toHaveCount(0);
    await board.getByRole('textbox', { name: 'Terminal input' }).focus();
    await board.keyboard.type('hello agent');
    await expect(board.getByText('hello agent', { exact: true })).toBeVisible();

    await board.getByRole('button', { name: CLOSE_DROP }).tap();
    await expect(board.getByRole('button', { name: DROP })).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use({ ...profiles.phone, world: agentWorld(), cosPosts: [startCard()] });

  test('tap Drop in in the agents sheet @G6.41', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await startAgent(page, relay);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const drop = sheet.getByRole('button', { name: DROP });
    await expect(drop).toBeVisible();
    const box = await drop.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await drop.tap();
    await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
    await expect(sheet).toBeHidden();
    await expectPhoneDropTerminal(page);
  });

  test('Take over in the sheet keeps it open while it waits @G6.105', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await startAgent(page, relay);
    const board = await eve.openAnother('/');
    await board.getByRole('button', { name: DROP }).tap();
    await relay.waitForEvent('session.drop_in', { match: (l) => l.status === 'ok' });
    await expectPhoneDropTerminal(board);

    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const take = sheet.getByRole('button', { name: TAKE });
    await expect(take).toBeVisible();
    const faultId = await holdSlow(relay);
    await take.tap();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button').filter({ hasText: 'Waiting for the turn to end…' })).toBeDisabled();

    // Relay answers with its refusal, because the other page still holds the session; the sheet then closes.
    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await expect(toastOf(page, REFUSED_HELD)).toBeVisible();
    await expect(sheet).toBeHidden();
  });
});

test.describe('outside rows on a phone', () => {
  test.use({ ...profiles.phone, world: outsideWorld() });

  test('the agents sheet shows no button on an outside row @G6.23.r3', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await expect(sheet.getByRole('button', { name: 'Scratch pad', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Ledger notes', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /^Drop in/ })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /^Take over/ })).toHaveCount(0);
  });
});
