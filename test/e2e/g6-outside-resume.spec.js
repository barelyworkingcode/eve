const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// An ended outside Claude session in a registered console project offers Resume: one tap opens a read-write
// claude-code terminal in the session's folder, resumed on the same conversation. fakerelay serves the rows
// from the world key `outside_sessions`; an ended row carries `claude_session_id`, which relay keeps private.
// fakerelay's terminal is an echo terminal with no transcript, so the history in the terminal is a real-app check.

const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();
const LIVE_AT = ago(0.1);
// The id is a marker the browser must never see. A distinctive value, so a leak is found by plain search.
const SID = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';

const RESUME ='Resume Ledger notes in a terminal';
const TAB = /Ledger notes \(resumed\)$/;
const CLOSE = /^Close .*\(resumed\)$/;
const NO_PROJECT = "Not in a project, so it can't be resumed.";
const ON_HOST = "On a host, so it can't be resumed here.";
const ROUTE = 'POST /api/terminals';

function liveRow(dir, over = {}) {
  return {
    id: 'outside:live',
    name: 'Live runner',
    project_id: 'p_acme',
    host_id: null,
    machine: 'acme-console',
    directory: dir,
    branch: 'main',
    state: 'running',
    since: LIVE_AT,
    updated_at: LIVE_AT,
    source: 'probe',
    outside: true,
    read_only: true,
    tmux_session: null,
    viewable: false,
    view_reason: 'not_in_tmux',
    latest_turn: { text: 'Still working.', at: LIVE_AT, complete: true },
    ...over,
  };
}

function endedRow(dir, over = {}) {
  return liveRow(dir, {
    id: 'outside:e1',
    name: 'Ledger notes',
    state: 'ended',
    branch: null,
    since: ago(3),
    updated_at: ago(2),
    ended_at: ago(2),
    claude_session_id: SID,
    latest_turn: { text: 'Ledger notes final answer', at: ago(2), complete: true },
    ...over,
  });
}

function resumeWorld() {
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
const resumeButton = (scope, name = RESUME) => scope.getByRole('button', { name, exact: true });
const anyResume = (scope) => scope.getByRole('button', { name: /^Resume /, exact: false });
const toastOf = (page, text) => page.getByRole('status').filter({ hasText: text });
const resumedTab = (page) => page.getByRole('tab', { name: TAB });

async function openCos(page) {
  // Below 600px the Bottom bar is the door a person taps.
  const compact = page.viewportSize().width < 600;
  const door = compact ? page.getByRole('navigation', { name: 'Navigation' }) : page;
  await door.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

// The ended row's folder is the project's folder, as relay reports it: fakerelay's own per-instance folder,
// read from its state. The rows go in through the control socket before the page opens.
async function seed(relay, build) {
  const state = await relay.json('ctl', 'state', '--json');
  const dir = state.projects.find((p) => p.id === 'p_acme').path;
  await worlds.outside.replace(relay.dir, build(dir));
  return dir;
}

const resumeLaunch = (l) => l.kind === 'terminal' && Array.isArray(l.extra_args) && l.extra_args[0] === '--resume';

// The rows of the standard world: one live, one ended in a console project.
const consoleRows = (dir) => [liveRow(dir), endedRow(dir)];

test.describe('an ended row in a console project', () => {
  test.use({ world: resumeWorld() });

  test('a tap opens a read-write claude-code terminal resumed on the same conversation @G6.106', async ({ eve, page, relay }) => {
    const dir = await seed(relay, consoleRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const resume = resumeButton(rail);
    await expect(resume).toBeVisible();
    await expect(resume).toHaveText('Resume');
    await expect(resume).toBeEnabled();
    // A live row beside it has none.
    await expect(rail.getByRole('button', { name: 'Live runner', exact: true })).toBeVisible();
    await expect(resumeButton(rail, 'Resume Live runner in a terminal')).toHaveCount(0);

    await resume.click();
    const launch = await relay.waitForEvent('session.launch', { match: resumeLaunch });
    expect(launch.template_id).toBe('claude-code');
    expect(launch.directory).toBe(dir);
    expect(launch.extra_args).toEqual(['--resume', SID]);

    await expect(resumedTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.type('hello resumed');
    await expect(page.getByText('hello resumed', { exact: true })).toBeVisible();
  });

  test('the button reads Resuming until relay answers, then Resumed @G6.106', async ({ eve, page, relay }) => {
    await seed(relay, consoleRows);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    const resume = resumeButton(rail);
    await expect(resume).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', ROUTE, '--mode', 'slow');
    expect(added.code).toBe(0);
    const faultId = JSON.parse(added.stdout).id;

    await resume.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    const busy = rail.getByRole('button').filter({ hasText: 'Resuming…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(resumedTab(page)).toHaveCount(0);

    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'released' });
    await expect(resumedTab(page)).toHaveAttribute('aria-selected', 'true');

    // Back on the Chief of Staff tab the row says the conversation is resumed, and offers no second terminal.
    await page.getByRole('tab', { name: 'Chief of Staff', exact: true }).click();
    const done = rail.getByRole('button').filter({ hasText: /^Resumed$/ });
    await expect(done).toBeVisible();
    await expect(done).toBeDisabled();
  });

  test('closing the resumed terminal brings the Resume button back @G6.106', async ({ eve, page, relay }) => {
    await seed(relay, consoleRows);
    await eve.open('/');
    await openCos(page);
    await resumeButton(railOf(page)).click();
    await relay.waitForEvent('session.launch', { match: resumeLaunch });
    await expect(resumedTab(page)).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: CLOSE }).click();
    await expect(resumedTab(page)).toHaveCount(0);
    await expect.poll(async () => (await relay.json('ctl', 'state', '--json')).terminals ?? []).toEqual([]);
    await openCos(page);
    const back = resumeButton(railOf(page));
    await expect(back).toBeVisible();
    await expect(back).toBeEnabled();
    await expect(back).toHaveText('Resume');
  });

  test('relay refuses: the toast gives its reason and the button is back @G6.106.r3', async ({ eve, page, relay }) => {
    await seed(relay, consoleRows);
    await eve.open('/');
    await openCos(page);
    const resume = resumeButton(railOf(page));
    await expect(resume).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', ROUTE, '--mode', 'error', '--status', '500', '--body', '{"error":"no room"}');
    expect(added.code).toBe(0);
    await resume.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(toastOf(page, "Can't resume: no room")).toBeVisible();
    await expect(resumedTab(page)).toHaveCount(0);
    await expect(resume).toBeEnabled();
    await expect(resume).toHaveText('Resume');
  });
});

test.describe('the browser never sees the Claude session id', () => {
  test.use({ world: resumeWorld() });

  test('no frame, response or page text carries the id @G6.106', async ({ eve, page, relay }) => {
    await seed(relay, consoleRows);
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
    const resume = resumeButton(railOf(page));
    await expect(resume).toBeVisible();
    await resume.click();
    await relay.waitForEvent('session.launch', { match: resumeLaunch });
    await expect(resumedTab(page)).toHaveAttribute('aria-selected', 'true');
    // The row reached the page, so the search below looks at real traffic.
    expect(frames.some((f) => f.includes('Ledger notes'))).toBe(true);
    expect(frames.filter((f) => f.includes(SID))).toEqual([]);
    const texts = await Promise.all(bodies);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((t) => t.includes(SID))).toEqual([]);
    // Nor does the screen.
    await expect(page.getByText(SID)).toHaveCount(0);
  });
});

test.describe('an ended row with no project', () => {
  test.use({ world: resumeWorld() });

  test('no button, one line says why @G6.106.r1', async ({ eve, page, relay }) => {
    await seed(relay, (dir) => [endedRow(dir), endedRow(dir, { id: 'outside:e2', name: 'Orphan notes', project_id: null, directory: '/elsewhere' })]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    // The row in a project has its button: the marker that the rail has loaded both rows.
    await expect(resumeButton(rail)).toBeVisible();
    await expect(rail.getByText('Orphan notes', { exact: true })).toBeVisible();
    await expect(rail.getByText(NO_PROJECT)).toBeVisible();
    await expect(resumeButton(rail, 'Resume Orphan notes in a terminal')).toHaveCount(0);
    await expect(anyResume(rail)).toHaveCount(1);
  });
});

test.describe('an ended row on a host', () => {
  test.use({ world: resumeWorld() });

  test('no button, one line says why @G6.106.r2', async ({ eve, page, relay }) => {
    await seed(relay, (dir) => [
      endedRow(dir),
      endedRow(dir, { id: 'outside:e3', name: 'Orchard review', project_id: 'p_box', host_id: 'h_box', machine: 'testbox', directory: '/home/acme/orchard' }),
    ]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(resumeButton(rail)).toBeVisible();
    await expect(rail.getByText('Orchard review', { exact: true })).toBeVisible();
    await expect(rail.getByText(ON_HOST)).toBeVisible();
    await expect(resumeButton(rail, 'Resume Orchard review in a terminal')).toHaveCount(0);
    await expect(anyResume(rail)).toHaveCount(1);
  });

  test('a row with no host in a project on a host: no button, the same line @G6.106.r2', async ({ eve, page, relay }) => {
    await seed(relay, (dir) => [
      endedRow(dir),
      endedRow(dir, { id: 'outside:e4', name: 'Orchard notes', project_id: 'p_box', host_id: null, directory: '/home/acme/orchard' }),
    ]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(resumeButton(rail)).toBeVisible();
    await expect(rail.getByText('Orchard notes', { exact: true })).toBeVisible();
    await expect(rail.getByText(ON_HOST)).toBeVisible();
    await expect(resumeButton(rail, 'Resume Orchard notes in a terminal')).toHaveCount(0);
    await expect(anyResume(rail)).toHaveCount(1);
  });
});

test.describe('a live row', () => {
  test.use({ world: resumeWorld() });

  test('never shows Resume or a reason, and a row that goes live loses its button @G6.106', async ({ eve, page, relay }) => {
    const dir = await seed(relay, (d) => [endedRow(d), liveRow(d, { id: 'outside:live', name: 'Live runner' })]);
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(resumeButton(rail)).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Live runner', exact: true })).toBeVisible();
    await expect(resumeButton(rail, 'Resume Live runner in a terminal')).toHaveCount(0);
    await expect(rail.getByText(NO_PROJECT)).toHaveCount(0);
    await expect(rail.getByText(ON_HOST)).toHaveCount(0);

    // The same conversation runs again: relay lists it live, with no Claude session id.
    await worlds.outside.replace(relay.dir, [
      liveRow(dir, { id: 'outside:e1', name: 'Ledger notes', state: 'running' }),
      liveRow(dir, { id: 'outside:live', name: 'Live runner' }),
    ]);
    const nowLive = rail.getByRole('button', { name: 'Ledger notes', exact: true });
    await expect(nowLive).toBeVisible();
    await expect(anyResume(rail)).toHaveCount(0);
    await expect(rail.getByText(NO_PROJECT)).toHaveCount(0);
    await expect(rail.getByText(ON_HOST)).toHaveCount(0);
  });
});

test.describe('the resume route refuses bad requests', () => {
  test.use({ world: resumeWorld() });

  // The button always sends a good request, so a call to the route is the only door to these refusals.
  async function resumeCall(eve, id, body) {
    const answer = await fetch(`${eve.url}/api/outside-sessions/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: answer.status, body: await answer.json() };
  }

  test('a bad session id answers 400 and calls no relay @G6.106', async ({ eve, relay }) => {
    await seed(relay, consoleRows);
    const mark = await relay.mark();
    for (const id of ['nope', 'outside:', 'outside:a b', 'inside:e1']) {
      const answer = await resumeCall(eve, id, { cols: 80, rows: 24 });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('invalid_request');
    }
    expect(await relay.logs({ event: 'session.launch', since: mark })).toHaveLength(0);
  });

  test('cols or rows that are not whole numbers from 1 to 500 answer 400 and call no relay @G6.106', async ({ eve, relay }) => {
    await seed(relay, consoleRows);
    const mark = await relay.mark();
    const bad = [
      { cols: 0, rows: 24 }, { cols: 80, rows: 0 }, { cols: 501, rows: 24 }, { cols: 80, rows: 501 },
      { cols: 1.5, rows: 24 }, { cols: 80, rows: 2.5 }, { cols: '80', rows: 24 }, { cols: 80, rows: '24' },
      { cols: -1, rows: 24 }, { rows: 24 }, { cols: 80 }, {},
    ];
    for (const body of bad) {
      const answer = await resumeCall(eve, 'outside:e1', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error, JSON.stringify(body)).toBe('cols and rows must be whole numbers from 1 to 500');
    }
    expect(await relay.logs({ event: 'session.launch', since: mark })).toHaveLength(0);
  });
});

test.describe('on a tablet', () => {
  test.use({ ...profiles.tablet, world: resumeWorld() });

  test('tap Resume, type into the terminal @G6.106', async ({ eve, page, relay }) => {
    await seed(relay, consoleRows);
    await eve.open('/');
    // The Chief of Staff door sits in the Rail, which is closed at tablet width: open it from a wide window,
    // then use the Agents strip and sheet at tablet width.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openCos(page);
    await page.setViewportSize({ width: 712, height: 1138 });
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const resume = resumeButton(sheet);
    await expect(resume).toBeVisible();
    expect((await resume.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await resume.tap();
    const launch = await relay.waitForEvent('session.launch', { match: resumeLaunch });
    expect(launch.template_id).toBe('claude-code');
    expect(launch.extra_args).toEqual(['--resume', SID]);
    await expect(resumedTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.type('hello resumed');
    await expect(page.getByText('hello resumed', { exact: true })).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use({ ...profiles.phone, world: resumeWorld() });

  test('tap Resume in the agents sheet @G6.106', async ({ eve, page, relay }) => {
    const dir = await seed(relay, consoleRows);
    await eve.open('/');
    await openCos(page);
    await stripOf(page).tap();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    const resume = resumeButton(sheet);
    await expect(resume).toBeVisible();
    expect((await resume.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await resume.tap();
    const launch = await relay.waitForEvent('session.launch', { match: resumeLaunch });
    expect(launch.template_id).toBe('claude-code');
    expect(launch.directory).toBe(dir);
    expect(launch.extra_args).toEqual(['--resume', SID]);
    await expect(sheet).toBeHidden();
    // A phone has no tab bar: the open terminal is the whole screen, titled with its name.
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
    await expect(page.getByText(/Ledger notes \(resumed\)/).filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
  });
});
