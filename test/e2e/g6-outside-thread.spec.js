const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// The read-only thread of an outside Claude session (G6.96): a tab with the session's conversation,
// read from relay's transcript route. fakerelay serves it from the row's `transcript` entries,
// oldest first; a PUT of new rows (worlds.outside.replace) swaps the transcripts with them.
// The thread's ready signal is its `data-fetches` count and `aria-busy`, carried by the Conversation log.

const LATER = '2026-10-13T10:00:00Z';

function entries(n, from = 0) {
  const roles = ['user', 'assistant', 'tool'];
  return Array.from({ length: n }, (_, i) => ({
    role: roles[(from + i) % 3],
    text: `Entry ${String(from + i).padStart(3, '0')}`,
    at: new Date(Date.UTC(2026, 9, 13, 9, 0, 0) + (from + i) * 60000).toISOString(),
  }));
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
    tmux_session: null,
    viewable: false,
    view_reason: 'not_in_tmux',
    latest_turn: { text: 'The ledger totals match.', at: LATER, complete: true },
    transcript: entries(3),
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
    viewable: true,
    view_reason: '',
    latest_turn: { text: 'Which tree should I prune?', at: LATER, complete: true },
    transcript: [
      { role: 'user', text: 'Prune the orchard plan', at: LATER },
      { role: 'assistant', text: 'Which tree should I prune?', at: LATER },
    ],
    ...over,
  });
}

function outsideWorld({ rows }) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent: 'connected',
    show_all_tmux_sessions: true,
    tmux_view_supported: true,
  }];
  w.projects.push({ id: 'p_box', name: 'Orchard', host_id: 'h_box', path: '/home/acme/orchard', mode: 'work', files: { 'todo.txt': 'one\n' } });
  w.outside_sessions = rows;
  return w;
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

const railOf = (page) => page.getByRole('navigation', { name: 'Agents' });
const rowOf = (page, name) => railOf(page).getByRole('button', { name, exact: true });
const threadOf = (page) => page.getByRole('log', { name: 'Conversation' });

// A request has settled: the count reached n and nothing is in flight.
async function fetched(thread, n) {
  await expect(thread).toHaveAttribute('data-fetches', String(n));
  await expect(thread).toHaveAttribute('aria-busy', 'false');
}

test.describe('open a thread', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow(), hostRow()] }) });

  test('G6.96 an outside row opens a read-only thread, on the console and on a host @G6.96', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);

    // A console row that is not in tmux: it still opens its conversation.
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await expect(thread).toBeVisible();
    await fetched(thread, 1);
    await expect(thread).toContainText('Entry 000');
    await expect(page.getByText('Outside · acme-console · /work/acme')).toBeVisible();
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible();

    // A session on an SSH host.
    await openCos(page);
    await rowOf(page, 'Orchard review').click();
    await expect(thread).toContainText('Prune the orchard plan');
    await expect(thread).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByText('Outside · testbox · /home/acme/orchard')).toBeVisible();
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  });
});

test.describe('the conversation', () => {
  test.use({
    world: outsideWorld({
      rows: [outsideRow({
        transcript: [
          { role: 'user', text: 'What changed in the ledger?', at: '2026-10-13T09:00:00Z' },
          { role: 'assistant', text: 'Totals now match.', at: '2026-10-13T09:01:00Z' },
          { role: 'tool', text: 'Bash: ls ledger', at: '2026-10-13T09:02:00Z' },
        ],
      })],
    }),
  });

  test('G6.96 the thread lists user, assistant and tool entries in time order @G6.96', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await fetched(thread, 1);
    await expect(thread).toHaveText(/You.*What changed in the ledger\?.*Claude.*Totals now match\..*Tool.*Bash: ls ledger/s);
  });
});

test.describe('older entries', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow({ transcript: entries(120) })] }) });

  test('G6.96 Load older adds the previous page above @G6.96', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    const older = page.getByRole('button', { name: 'Load older', exact: true });
    await fetched(thread, 1);
    await expect(thread).toContainText('Entry 119');
    await expect(thread).toContainText('Entry 070');
    await expect(thread).not.toContainText('Entry 069');

    await older.click();
    await fetched(thread, 2);
    await expect(thread).toContainText('Entry 020');
    await expect(thread).not.toContainText('Entry 019');
    await expect(older).toBeVisible();

    await older.click();
    await fetched(thread, 3);
    await expect(thread).toContainText('Entry 000');
    await expect(older).toHaveCount(0);
  });
});

test.describe('a running session', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow({ transcript: entries(3) })] }) });

  test('G6.96 new entries show at the next probe interval @G6.96', async ({ eve, page, relay }) => {
    await page.clock.install();
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await fetched(thread, 1);
    await expect(thread).toContainText('Entry 002');

    // The session grew, but the page has not asked again yet.
    await worlds.outside.replace(relay.dir, [outsideRow({ transcript: entries(5) })]);
    await expect(thread).not.toContainText('Entry 004');

    await page.clock.runFor(15000);
    await fetched(thread, 2);
    await expect(thread).toContainText('Entry 004');
  });
});

test.describe('plain text', () => {
  const hostile = [
    { role: 'user', text: '[docs](https://acme.invalid)', at: '2026-10-13T09:00:00Z' },
    { role: 'assistant', text: '<img src=x onerror=alert(1)>', at: '2026-10-13T09:01:00Z' },
    { role: 'tool', text: '**bold**', at: '2026-10-13T09:02:00Z' },
  ];
  test.use({ world: outsideWorld({ rows: [outsideRow({ transcript: hostile })] }) });

  test('G6.96 agent text shows as plain text @G6.96', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await fetched(thread, 1);
    // The text reads exactly as sent: no link, picture or bold was made from it.
    await expect(thread).toContainText('[docs](https://acme.invalid)');
    await expect(thread).toContainText('<img src=x onerror=alert(1)>');
    await expect(thread).toContainText('**bold**');
    await expect(thread.getByRole('link')).toHaveCount(0);
    await expect(thread.getByRole('img')).toHaveCount(0);
  });
});

test.describe('nothing to type into', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow({ transcript: entries(120) })] }) });

  test('G6.96 the thread has no input, send or stop control @G6.96', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await fetched(thread, 1);
    // The older page is there to ask for, so the buttons below are all the pane has.
    await expect(page.getByRole('button', { name: 'Load older', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /send|stop/i })).toHaveCount(0);
  });
});

test.describe('a session leaves the list', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow(), hostRow()] }) });

  test('G6.96 a session that leaves the list closes its thread with a notice @G6.96 @G6.96.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await fetched(thread, 1);
    await expect(thread).toContainText('Entry 000');

    await worlds.outside.replace(relay.dir, [hostRow()]);
    await expect(thread).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Ledger notes left the Agents list, so its thread closed.' })).toBeVisible();
  });
});

test.describe('the row says whether a thread is available', () => {
  test.use({ world: outsideWorld({ rows: [outsideRow(), hostRow()] }) });

  test('G6.96 the rail row says whether a thread is available @G6.96 @G6.96.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(rowOf(page, 'Ledger notes')).toContainText('Read-only thread');
    await expect(rowOf(page, 'Orchard review')).toContainText('Read-only thread');

    // The host drops: its row says so, and pressing it opens nothing.
    await relay.ctl('host', 'status', '--id', 'h_box', '--status', 'unreachable', '--error', 'offline');
    await worlds.outside.replace(relay.dir, [outsideRow(), hostRow()]);
    await expect(rowOf(page, 'Orchard review')).toContainText('Thread unavailable: Host is unreachable');
    await expect(rowOf(page, 'Ledger notes')).toContainText('Read-only thread');

    await rowOf(page, 'Orchard review').click();
    // The reachable row opens as a marker that the press on the unreachable one has been handled.
    await rowOf(page, 'Ledger notes').click();
    const thread = threadOf(page);
    await expect(thread).toBeVisible();
    await expect(thread).toContainText('Entry 000');
    await expect(thread).toHaveCount(1);
    await expect(page.getByText('Outside · testbox · /home/acme/orchard')).toHaveCount(0);
  });
});
