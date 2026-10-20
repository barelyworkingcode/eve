const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// How an outside session's thread is formatted (G6.96): Claude entries as Markdown, a tool call as
// its name and a short summary with the input folded, a long tool result folded, nothing raw or
// wider than the page. fakerelay serves the row's `transcript` entries verbatim.
// The thread's ready signal is its `data-fetches` count and `aria-busy`, carried by the Conversation log.

const LATER = '2026-10-13T10:00:00Z';

function entry(role, text, i) {
  return { role, text, at: new Date(Date.UTC(2026, 9, 13, 9, 0, 0) + i * 60000).toISOString() };
}

function outsideRow(transcript) {
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
    transcript,
  };
}

function outsideWorld(transcript) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.outside_sessions = [outsideRow(transcript)];
  return w;
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

const threadOf = (page) => page.getByRole('log', { name: 'Conversation' });

// Opens the session and waits until its first request has settled.
async function openThread(eve, page) {
  await eve.open('/');
  await openCos(page);
  await page.getByRole('navigation', { name: 'Agents' }).getByRole('button', { name: 'Ledger notes', exact: true }).click();
  const thread = threadOf(page);
  await expect(thread).toBeVisible();
  await expect(thread).toHaveAttribute('data-fetches', '1');
  await expect(thread).toHaveAttribute('aria-busy', 'false');
  return thread;
}

const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${String(i + 1).padStart(2, '0')}`).join('\n');

test.describe('Claude text as Markdown', () => {
  test.use({
    world: outsideWorld([
      entry('user', 'Plan the ledger work', 0),
      entry('assistant', '## Plan\n\n- check the **totals**\n- file the notes\n\nRun `ledger-sync` first.', 1),
    ]),
  });

  test('G6.96 a Claude entry shows as a heading, list items and code @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    await expect(thread.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await expect(thread.getByRole('listitem')).toHaveCount(2);
    await expect(thread.getByRole('listitem').first()).toContainText('check the totals');
    await expect(thread.getByText('ledger-sync', { exact: true })).toBeVisible();
    // The marks were consumed by the parser, not left in the text.
    await expect(thread).not.toContainText('**');
    await expect(thread).not.toContainText('`');
    await expect(thread).not.toContainText('## ');
  });
});

test.describe('a tool call', () => {
  test.use({
    world: outsideWorld([
      entry('assistant', 'Listing the ledger.', 0),
      entry('tool', 'Bash {"command":"ls -la ledger","description":"List the ledger"}', 1),
    ]),
  });

  test('G6.96 a tool call shows its name and summary, and its input opens on request @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    await expect(thread.getByText('Bash').first()).toBeVisible();
    // The summary may repeat inside the folded input, so the first match is the one in the summary line.
    const summary = thread.getByText('List the ledger').first();
    await expect(summary).toBeVisible();
    await expect(thread.getByText('"command"')).toBeHidden();
    await expect(thread).not.toContainText('{"command"');

    await summary.click();
    await expect(thread.getByText('"command"')).toBeVisible();
    await expect(thread.getByText('ls -la ledger')).toBeVisible();
  });
});

test.describe('a tool result', () => {
  test.use({
    world: outsideWorld([
      entry('assistant', 'Reading the files.', 0),
      entry('tool', lines('result line', 40), 1),
      entry('tool', 'ok 3 rows', 2),
    ]),
  });

  test('G6.96 a long tool result folds and opens on request; a short one shows in full @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    // The short result is whole on screen and is not a fold: the long one is the only fold.
    await expect(thread.getByText('ok 3 rows')).toBeVisible();
    await expect(thread.getByRole('group')).toHaveCount(1);

    const first = thread.getByText('result line 01').first();
    await expect(first).toBeVisible();
    await expect(thread.getByText('result line 40')).toBeHidden();

    await first.click();
    await expect(thread.getByText('result line 40')).toBeVisible();
  });
});

test.describe('a very long tool input', () => {
  test.use({
    world: outsideWorld([
      entry('user', 'Run the sync', 0),
      entry('tool', `Bash {"command":"${'echo sync step; '.repeat(400)}","description":"Sync everything"}`, 1),
      entry('assistant', 'Done.', 2),
    ]),
  });

  test('G6.96 a call with a large input stays small until it is opened @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    await expect(thread.getByText('Sync everything').first()).toBeVisible();
    await expect(thread.getByRole('group')).toHaveCount(1);
    const log = await thread.boundingBox();
    const box = await thread.getByRole('group').boundingBox();
    expect(log).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box.height).toBeLessThan(log.height / 4);
  });
});

test.describe('long lines', () => {
  test.use({
    world: outsideWorld([
      entry('user', 'Show me the long things', 0),
      entry('assistant', `Here is a word: ${'W'.repeat(2000)}`, 1),
      entry('assistant', `Code:\n\n\`\`\`\n${'c'.repeat(300)}\n\`\`\``, 2),
      entry('tool', `${'r'.repeat(300)}`, 3),
    ]),
  });

  test('G6.96 a long word, code line and result line do not widen the page @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    await expect(thread).toContainText('Here is a word');
    await expect(thread).toContainText('c'.repeat(300));
    await expect(thread).toContainText('r'.repeat(300));

    // No sideways scroll: a horizontal wheel over the thread, then over the page outside it, must not
    // move a fixed anchor. A box measure is blind here (a block's box is clamped to its container), but a
    // log or document that overflows sideways scrolls and carries the anchor with it. The wheel has no
    // completion signal, so each wheel is followed by a web-first check that settles a render round trip.
    // Confirmed: with the outside-thread overflow rules removed, the anchor moves and this test fails.
    const anchor = thread.getByText('Show me the long things');
    await expect(anchor).toBeVisible();
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();

    await anchor.hover();
    await page.mouse.wheel(600, 0);
    await expect(thread).toContainText('r'.repeat(300));
    const afterLog = await anchor.boundingBox();
    expect(afterLog.x).toBe(before.x);

    await page.mouse.move(2, 2);
    await page.mouse.wheel(600, 0);
    await expect(thread).toContainText('r'.repeat(300));
    const afterPage = await anchor.boundingBox();
    expect(afterPage.x).toBe(before.x);
  });
});

// Relay tags each transcript entry with a kind ('call' or 'result') and a call's tool name (#583).
// A person sees the same thread either way; the tag decides how an entry folds, not its text shape.
function tagged(role, kind, name, text, i) {
  const e = entry(role, text, i);
  e.kind = kind;
  if (name !== undefined) e.name = name;
  return e;
}

test.describe('a tagged tool call', () => {
  test.use({
    world: outsideWorld([
      entry('assistant', 'Looking up the totals.', 0),
      tagged('tool', 'call', 'Lookup', '{"query":"ledger totals","description":"Find the totals"}', 1),
    ]),
  });

  test('G6.96 a call tagged kind call shows its name and summary, with the input folded @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    await expect(thread.getByText('Lookup').first()).toBeVisible();
    const summary = thread.getByText('Find the totals').first();
    await expect(summary).toBeVisible();
    await expect(thread.getByText('"query"')).toBeHidden();
    await expect(thread).not.toContainText('{"query"');

    await summary.click();
    await expect(thread.getByText('"query"')).toBeVisible();
    await expect(thread.getByText('ledger totals')).toBeVisible();
  });
});

test.describe('a tagged result that looks like a call', () => {
  test.use({
    world: outsideWorld([
      entry('assistant', 'Running it.', 0),
      tagged('tool', 'result', undefined, 'Bash {"command":"echo hi","description":"Say hi"}', 1),
    ]),
  });

  test('G6.96 an entry tagged kind result reads as a result, whatever its text looks like @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    // The whole text is on screen as plain result text: a call would have folded the input away.
    await expect(thread).toContainText('Bash {"command":"echo hi","description":"Say hi"}');
    await expect(thread.getByRole('group')).toHaveCount(0);
  });
});

test.describe('an untagged entry from an older relay', () => {
  test.use({
    world: outsideWorld([
      entry('assistant', 'Listing the ledger.', 0),
      entry('tool', 'Bash {"command":"ls -la ledger","description":"List the ledger"}', 1),
      entry('tool', 'ok 3 rows', 2),
    ]),
  });

  test('G6.96 an entry with no kind still folds by the shape of its text @G6.96', async ({ eve, page }) => {
    const thread = await openThread(eve, page);
    await expect(thread.getByText('Bash').first()).toBeVisible();
    await expect(thread.getByText('List the ledger').first()).toBeVisible();
    await expect(thread.getByText('"command"')).toBeHidden();
    await expect(thread.getByText('ok 3 rows')).toBeVisible();
  });
});

test.describe('markup in a tool result', () => {
  test.use({
    world: outsideWorld([
      entry('user', 'Check the page', 0),
      entry('tool', '<img src=x onerror=alert(1)>', 1),
    ]),
  });

  test('G6.96 markup in a result reads as text, and the thread stays read-only @G6.96', async ({ eve, page }) => {
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    const thread = await openThread(eve, page);
    // The literal text on screen is the marker that the entry rendered; only then is "nothing fired" meaningful.
    await expect(thread).toContainText('<img src=x onerror=alert(1)>');
    await expect(thread.getByRole('img')).toHaveCount(0);
    expect(dialogs).toEqual([]);

    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /send|stop/i })).toHaveCount(0);
  });
});
