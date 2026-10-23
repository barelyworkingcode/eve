const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// The Launcher's Resume tab lists relay's session history (fakerelay world key `sessionHistory`).
// Rows are in relay's wire shape; eve keeps relay's order and shows relay's title.

const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();
const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const toastOf = (page, text) => page.getByRole('status').filter({ hasText: text });

function row(id, over = {}) {
  return {
    id,
    record: 'launched',
    kind: 'terminal',
    agent: 'claude',
    projectId: 'p_acme',
    hostId: null,
    directory: '/work/acme',
    conversationId: `c-${id}`,
    title: `Title of ${id}`,
    titleSource: 'client',
    lastActiveAt: ago(30),
    createdAt: ago(600),
    state: 'dormant',
    transcript: 'present',
    resume: 'history',
    ...over,
  };
}

function thread(id, name, asked = `question in ${name}`) {
  return {
    id,
    project_id: 'p_acme',
    name,
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: asked }, { role: 'assistant', text: `answer in ${name}` }],
  };
}

function historyWorld(rows, extra = {}) {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'claude-code', name: 'Claude Code', command: '/bin/sh', description: 'Claude Code terminal' }];
  w.sessionHistory = rows;
  return Object.assign(w, extra);
}

async function openResume(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
  await launcher.getByRole('button', { name: 'Resume' }).click();
  return launcher;
}

// The WS frames this page sends and receives, with batches opened.
function frames(page) {
  const seen = { sent: [], received: [] };
  const open = (payload, into) => {
    let f;
    try { f = JSON.parse(payload); } catch { return; }
    (f.type === '__batch' && Array.isArray(f.msgs) ? f.msgs : [f]).forEach((m) => into.push(m));
  };
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => open(payload, seen.sent));
    ws.on('framereceived', ({ payload }) => open(payload, seen.received));
  });
  return seen;
}

const LIST_TITLES = ['Fix the <b>login</b> page', 'Refactor billing', 'Plan the offsite', 'Found notes'];

test.describe('rows', () => {
  test.use({
    world: historyWorld([
      row('h_term', { title: LIST_TITLES[0], lastActiveAt: ago(7) }),
      row('s_agent', { kind: 'claude', title: LIST_TITLES[1], lastActiveAt: ago(120), resume: 'session' }),
      row('s_chat', { kind: 'chat', agent: null, title: LIST_TITLES[2], lastActiveAt: ago(300), resume: 'session' }),
      row('h_found', { record: 'discovered', state: 'discovered', projectId: 'p_acme', title: LIST_TITLES[3], lastActiveAt: ago(900) }),
      row('h_untitled', { title: null, titleSource: null, directory: '/work/orchard-notes', lastActiveAt: ago(1000) }),
      row('h_live', { state: 'live', resume: 'none', resumeReason: 'live', title: 'Live runner', lastActiveAt: ago(1) }),
      row('h_other', { projectId: 'p_other', title: 'Other project work' }),
    ], {
      sessions: [thread('s_agent', 'Refactor billing session'), thread('s_chat', 'Plan the offsite session')],
    }),
  });

  test('G2.58 lists history rows @G2.58', async ({ eve, page }) => {
    const launcher = await openResume(eve, page);
    await expect(launcher.getByRole('heading', { name: 'History' })).toBeVisible();
    // Title, age and badge, one row each, in relay's order. A discovered row shows only "Found".
    const titles = [...LIST_TITLES, 'Claude — orchard-notes'];
    await expect(launcher.getByRole('button', { name: `Resume ${titles[titles.length - 1]}` })).toBeVisible();
    const text = await launcher.innerText();
    const at = titles.map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0), text).toBe(true);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    const slice = (i) => text.slice(at[i], i + 1 < at.length ? at[i + 1] : undefined);
    expect(slice(0)).toContain('7m ago');
    expect(slice(0)).toContain('Terminal');
    expect(slice(1)).toContain('2h ago');
    expect(slice(1)).toContain('Agent');
    expect(slice(2)).toContain('Chat');
    expect(slice(3)).toContain('Found');
    expect(slice(3)).not.toContain('Terminal');
    // A row with no title shows "Claude — <folder name>".
    expect(slice(4)).toContain('Terminal');

    // The title is text: no element made of it, and the tags show as typed.
    await expect(launcher.getByText('Fix the <b>login</b> page', { exact: true })).toBeVisible();
    await expect(launcher.getByText('login', { exact: true })).toHaveCount(0);

    // A live terminal is not History's; another project's row is not listed here.
    await expect(launcher.getByText('Live runner')).toHaveCount(0);
    await expect(launcher.getByText('Other project work')).toHaveCount(0);
  });
});

test.describe('resume', () => {
  test.use({
    world: historyWorld([
      row('h_term', { title: 'Ledger review', lastActiveAt: ago(7) }),
      row('s_agent', { kind: 'claude', title: 'Refactor billing', lastActiveAt: ago(120), resume: 'session' }),
    ], { sessions: [thread('s_agent', 'Refactor billing session')] }),
  });

  test('G2.58 resumes a row @G2.58', async ({ eve, page, relay }) => {
    const seen = frames(page);
    const launcher = await openResume(eve, page);
    const resume = launcher.getByRole('button', { name: 'Resume Ledger review' });
    await expect(resume).toBeVisible();
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/session-history/{id}/resume', '--mode', 'slow');
    expect(added.code, added.stderr).toBe(0);
    const faultId = JSON.parse(added.stdout).id;

    await resume.click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    const busy = launcher.getByRole('button').filter({ hasText: 'Resuming…' });
    await expect(busy).toBeDisabled();
    expect((await relay.json('ctl', 'state', '--json')).terminals ?? []).toEqual([]);

    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await expect(launcher).toBeHidden();
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    // One frame, carrying the row id and the terminal size and nothing else.
    const sent = seen.sent.filter((m) => m.type === 'session_history_resume');
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual(['cols', 'id', 'rows', 'type']);
    expect(sent[0].id).toBe('h_term');
    expect(sent[0].cols).toBeGreaterThan(0);
    expect(sent[0].rows).toBeGreaterThan(0);
    // The tab is a live terminal: typed input comes back.
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.type('hello resumed');
    await expect(page.getByText('hello resumed', { exact: true })).toBeVisible();
    expect((await relay.json('ctl', 'state', '--json')).terminals).toHaveLength(1);
  });

  test('G2.58 joins a session row and keeps its Delete @G2.58', async ({ eve, page }) => {
    const launcher = await openResume(eve, page);
    await expect(launcher.getByRole('button', { name: 'Delete session Refactor billing' })).toBeVisible();
    await launcher.getByRole('button', { name: 'Resume Refactor billing' }).click();
    await expect(page.getByText('answer in Refactor billing session')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Shell Launcher' })).toBeHidden();
  });
});

const REASONS = [
  ['live', 'Still running'],
  ['held', 'Open in another terminal'],
  ['no_conversation', 'No conversation yet'],
  ['transcript_absent', 'Its transcript is gone'],
  ['no_project', "Not in this project's folders"],
  ['host_unsupported', 'On a host: resume it there'],
  ['kind', "Can't be resumed here"],
];

test.describe('refusals', () => {
  test.use({
    world: historyWorld([
      ...REASONS.map(([reason], i) => row(`n_${reason}`, {
        kind: 'claude', title: `Reason ${reason}`, state: reason === 'live' ? 'live' : 'dormant',
        resume: 'none', resumeReason: reason, lastActiveAt: ago(10 + i),
      })),
      row('h_refused', { title: 'Refused notes', refuse: 'held', lastActiveAt: ago(60) }),
    ]),
  });

  test("G2.58 explains rows it can't resume @G2.58.r2", async ({ eve, page }) => {
    const launcher = await openResume(eve, page);
    await expect(launcher.getByRole('button', { name: 'Resume Refused notes' })).toBeVisible();
    const text = await launcher.innerText();
    REASONS.forEach(([reason, line], i) => {
      const from = text.indexOf(`Reason ${reason}`);
      expect(from, reason).toBeGreaterThanOrEqual(0);
      const next = i + 1 < REASONS.length ? text.indexOf(`Reason ${REASONS[i + 1][0]}`) : text.indexOf('Refused notes');
      expect(text.slice(from, next), reason).toContain(line);
    });
    await expect(launcher.getByRole('button', { name: /^Resume Reason / })).toHaveCount(0);
  });

  test("G2.58 explains a refusal and brings the button back @G2.58.r1", async ({ eve, page }) => {
    const seen = frames(page);
    const launcher = await openResume(eve, page);
    const resume = launcher.getByRole('button', { name: 'Resume Refused notes' });
    await expect(resume).toBeVisible();
    await resume.click();
    await expect.poll(() => seen.received.find((m) => m.type === 'session_history_error')).toBeTruthy();
    const refusal = seen.received.find((m) => m.type === 'session_history_error');
    expect(refusal.id).toBe('h_refused');
    expect(refusal.code).toBe('held');
    expect(refusal.error).toBeTruthy();
    await expect(toastOf(page, `Can't resume: ${refusal.error}`)).toBeVisible();
    await expect(resume).toBeEnabled();
    await expect(resume).toHaveText('Resume');
    await expect(launcher).toBeVisible();
  });
});

test.describe('unavailable', () => {
  test.use({
    world: historyWorld([], { sessions: [thread('s_chat', 'Weekly review')], sessionHistoryUnavailable: true }),
  });

  test('G2.58 falls back when history is unavailable @G2.58.r3', async ({ eve, page }) => {
    const launcher = await openResume(eve, page);
    await expect(launcher.getByText('History unavailable')).toBeVisible();
    await expect(launcher.getByRole('heading', { name: 'Chat Sessions' })).toBeVisible();
    await expect(launcher.getByText('Weekly review')).toBeVisible();
    await expect(launcher.getByRole('heading', { name: 'History' })).toHaveCount(0);
  });
});

test.describe('titles', () => {
  test.use({
    world: historyWorld([
      row('s_titled', { kind: 'claude', title: 'Quarterly planning', resume: 'session' }),
    ], {
      sessions: [thread('s_titled', 'haiku', 'Draft the roadmap'), thread('s_plain', 'haiku', 'Check the invoices')],
    }),
  });

  test("G2.59 relay's title wins @G2.59", async ({ eve, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'Project page' }).click();
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();

    // Open both threads so this browser has seen each one's first message.
    for (const shown of ['Quarterly planning', 'haiku']) {
      await page.getByRole('list', { name: 'Threads' }).getByRole('button', { name: shown, exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
      await page.getByRole('tab', { name: 'Acme' }).click();
      await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
    }
    await eve.reload();
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'Project page' }).click();

    // Relay's title, not the model name (the session's name) and not what this browser first saw.
    const threads = page.getByRole('list', { name: 'Threads' });
    await expect(threads.getByRole('button', { name: 'Quarterly planning', exact: true })).toBeVisible();
    await expect(threads.getByRole('button', { name: 'Draft the roadmap', exact: true })).toHaveCount(0);
    await expect(threads.getByRole('button', { name: 'haiku', exact: true })).toHaveCount(0);
    // No title from relay: the first message this browser saw.
    await expect(threads.getByRole('button', { name: 'Check the invoices', exact: true })).toBeVisible();
  });
});
