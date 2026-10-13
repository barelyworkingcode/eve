const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Outside Claude sessions: sessions a person started in their own terminal, on the console or on an SSH host.
// fakerelay serves them from the world key `outside_sessions`, apart from the managed `sessions`.
// fakerelay's Chief of Staff model only echoes and reports no tools, so what the model says about an
// outside session (G6.94) cannot be driven here; the devbox journey cos-outside-simple covers it.

const LATER = '2026-10-13T10:00:00Z';

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

function hostRow(over = {}) {
  return outsideRow({
    id: 'outside:h1',
    name: 'Orchard review',
    project_id: 'p_box',
    host_id: 'h_box',
    machine: 'testbox',
    directory: '/home/acme/orchard',
    branch: 'feature/trees',
    state: 'asking',
    tmux_session: 'orchard-1',
    latest_turn: { text: 'Which tree should I prune?', at: LATER, complete: true },
    ...over,
  });
}

function outsideWorld({ rows, optIn = true, managed = true } = {}) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent: 'connected',
    show_all_tmux_sessions: optIn,
    tmux_view_supported: true,
  }];
  w.projects.push({ id: 'p_box', name: 'Orchard', host_id: 'h_box', path: '/home/acme/orchard', mode: 'work', files: { 'todo.txt': 'one\n' } });
  if (managed) {
    w.sessions = [
      { id: 's_ledger', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' }] },
    ];
  }
  w.outside_sessions = rows;
  return w;
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

const railOf = (page) => page.getByRole('navigation', { name: 'Agents' });
// An outside row is a rail button named by the session; pressing it opens the read-only view.
const rowOf = (page, name) => railOf(page).getByRole('button', { name, exact: true });

test.describe('outside sessions in the rail', () => {
  test.use({
    world: outsideWorld({
      rows: [
        outsideRow(),
        hostRow(),
        outsideRow({ id: 'outside:c2', name: 'Scratch pad', directory: '/work/scratch', branch: 'wip', state: 'idle', tmux_session: null, viewable: false, view_reason: 'not_in_tmux' }),
      ],
    }),
  });

  test('outside sessions on the console and a host are marked Outside, apart from managed ones @G6.93', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);

    // The managed session is a plain rail button with no Outside mark.
    const managed = rail.getByRole('button', { name: 'Ledger', exact: true });
    await expect(managed).toContainText('Acme · Idle');
    await expect(managed).not.toContainText('Outside');

    const consoleRow = rowOf(page, 'Ledger notes');
    await expect(consoleRow).toContainText('Outside');
    await expect(consoleRow).toContainText('acme-console');
    const hostSession = rowOf(page, 'Orchard review');
    await expect(hostSession).toContainText('Outside');
    await expect(hostSession).toContainText('testbox');
  });

  test('each outside row shows machine, folder, branch and its state @G6.93', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const working = rowOf(page, 'Ledger notes');
    await expect(working).toContainText('acme-console');
    await expect(working).toContainText('/work/acme');
    await expect(working).toContainText('main');
    await expect(working).toContainText('Working');

    const waiting = rowOf(page, 'Orchard review');
    await expect(waiting).toContainText('testbox');
    await expect(waiting).toContainText('/home/acme/orchard');
    await expect(waiting).toContainText('feature/trees');
    await expect(waiting).toContainText('Waiting on you');

    const idle = rowOf(page, 'Scratch pad');
    await expect(idle).toContainText('/work/scratch');
    await expect(idle).toContainText('wip');
    await expect(idle).toContainText('Idle');
  });

  test('a row without tmux says it cannot be opened and why @G6.93.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const row = rowOf(page, 'Scratch pad');
    await expect(row).toContainText('Cannot open from Eve');
    await expect(row).toContainText('Not in tmux');
    await expect(row).not.toContainText('View read-only');
    // A tmux row of the same rail does offer it.
    await expect(rowOf(page, 'Ledger notes')).toContainText('View read-only');
  });
});

test.describe('outside sessions that need me', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow({ state: 'asking' }), hostRow({ state: 'running' })], managed: true }) });

  test('a waiting outside session counts once toward need you @G6.93', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(rail.getByRole('heading', { name: 'Needs you 1', level: 4 })).toBeVisible();
    await expect(rowOf(page, 'Ledger notes')).toContainText('Waiting on you');
    await expect(page.getByRole('button', { name: '1 needs you', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '2 need you', exact: true })).toHaveCount(0);
  });
});

test.describe('outside sessions change', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow(), hostRow()] }) });

  test('a new snapshot re-renders a changed row and drops a removed one @G6.93', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(rowOf(page, 'Ledger notes')).toContainText('Working');
    await expect(rowOf(page, 'Orchard review')).toContainText('Waiting on you');

    // The first snapshot: the console session now waits on me; the host session is gone.
    await worlds.outside.replace(relay.dir, [outsideRow({ state: 'asking' })]);
    await expect(rowOf(page, 'Ledger notes')).toContainText('Waiting on you');
    await expect(rowOf(page, 'Orchard review')).toHaveCount(0);

    // And back to an empty inventory.
    await worlds.outside.replace(relay.dir, []);
    await expect(rowOf(page, 'Ledger notes')).toHaveCount(0);
  });
});

test.describe('watch an outside tmux session', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow()], managed: false }) });

  test('View read-only opens a labelled terminal that sends no input @G6.95', async ({ eve, page, relay }) => {
    const sent = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        try { sent.push(JSON.parse(String(frame.payload)).type); } catch { /* binary or non-JSON frame */ }
      });
    });
    await eve.open('/');
    await openCos(page);
    const viewable = rowOf(page, 'Ledger notes');
    await expect(viewable).toContainText('View read-only');
    await viewable.click();
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible();

    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await input.focus();
    await page.keyboard.type('rm -rf nothing');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Control+c');

    // Close detaches the viewer. The close frame is the marker that every earlier keystroke was handled.
    await page.getByRole('button', { name: 'Close ledger-1', exact: true }).click();
    await expect.poll(() => sent.includes('terminal_close')).toBe(true);
    expect(sent.filter((t) => t === 'terminal_input' || t === 'terminal_resize')).toEqual([]);
    await expect.poll(async () => (await relay.json('ctl', 'state', '--json')).terminals ?? []).toEqual([]);
  });
});

test.describe('a host that has not opted in', () => {
  test.use({ world: outsideWorld({ rows: [hostRow({ state: 'idle' })], optIn: false, managed: false }) });

  test('viewing is refused when the host has not opted in @G6.95.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Orchard review').click();
    await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /./ })).toBeVisible();
    expect((await relay.json('ctl', 'state', '--json')).terminals ?? []).toEqual([]);
  });
});

function sendCard(id, sessionId, label) {
  return {
    v: 1,
    id,
    at: new Date().toISOString(),
    kind: 'send_card',
    byModel: true,
    card: { state: 'pending', sessionId, label, text: 'please stop', why: 'read_target_not_named', turnId: 't_1', error: null },
  };
}

test.describe('eve never sends to an outside session', () => {
  test.use({
    world: outsideWorld({ rows: [outsideRow()], managed: false }),
    cosPosts: [sendCard('c_send', 'outside:c1', 'Ledger notes')],
  });

  test('a Send card for an outside session is refused @G6.95.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(card.getByText('Failed: Outside sessions are read-only.')).toBeVisible();
    await expect(card.getByText('Sent', { exact: true })).toHaveCount(0);
    expect(await relay.logs({ event: 'chief_of_staff.send' })).toHaveLength(0);
  });

  test('Drop in on an outside session answers 403 @G6.95.r2', async ({ eve, relay }) => {
    // Drop in is an HTTP route with no button for an outside row, so this call is the only door.
    const answer = await fetch(`${eve.url}/api/sessions/outside:c1/drop-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(answer.status).toBe(403);
    const body = await answer.json();
    expect(JSON.stringify(body)).toContain('outside_session_read_only');
    expect(await relay.logs({ event: 'session.drop_in' })).toHaveLength(0);
  });
});
