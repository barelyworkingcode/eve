const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Recently ended outside sessions stay in the Chief of Staff agents list, in an Ended group.
// fakerelay serves them from the world key `outside_sessions` with state "ended", `ended_at`
// and `latest_turn`, apart from the managed `sessions`.

const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();
const LIVE_AT = ago(0.1);

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
    since: LIVE_AT,
    updated_at: LIVE_AT,
    source: 'probe',
    outside: true,
    read_only: true,
    tmux_session: null,
    viewable: false,
    view_reason: 'not_in_tmux',
    latest_turn: { text: 'The ledger totals match.', at: LIVE_AT, complete: true },
    ...over,
  };
}

function endedRow(id, name, hoursAgo, over = {}) {
  return outsideRow({
    id,
    name,
    state: 'ended',
    branch: null,
    since: ago(hoursAgo + 1),
    updated_at: ago(hoursAgo),
    ended_at: ago(hoursAgo),
    latest_turn: { text: `${name} final answer`, at: ago(hoursAgo), complete: true },
    ...over,
  });
}

function outsideWorld(rows) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.outside_sessions = rows;
  return w;
}

async function openCos(page, phone = false) {
  const door = phone ? page.getByRole('navigation', { name: 'Navigation' }) : page;
  await door.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

const railOf = (page) => page.getByRole('navigation', { name: 'Agents' });
const endedHeading = (scope) => scope.getByRole('heading', { name: /^Ended\b/, level: 4 });

test.describe('ended outside sessions', () => {
  test.use({
    world: outsideWorld([
      outsideRow({ id: 'outside:live', name: 'Live asker', state: 'asking', latest_turn: { text: 'Which file should I touch?', at: LIVE_AT, complete: true } }),
      endedRow('outside:e1', 'Older review', 5),
      endedRow('outside:e2', 'Newer review', 2),
    ]),
  });

  test('ended outside sessions are listed in Ended, newest first @G6.104', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(rail.getByRole('button', { name: 'Live asker', exact: true })).toBeVisible();
    await expect(endedHeading(rail)).toBeVisible();

    const newer = rail.getByText('Newer review', { exact: true });
    const older = rail.getByText('Older review', { exact: true });
    await expect(newer).toBeVisible();
    await expect(older).toBeVisible();
    const newerBox = await newer.boundingBox();
    const olderBox = await older.boundingBox();
    expect(newerBox.y).toBeLessThan(olderBox.y);
    // The group sits below its heading.
    const headingBox = await endedHeading(rail).boundingBox();
    expect(headingBox.y).toBeLessThan(newerBox.y);
  });

  test('an ended row shows its name, machine, folder, age and last turn @G6.104', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(endedHeading(rail)).toBeVisible();
    await expect(rail.getByText('Outside · acme-console · /work/acme · Ended').first()).toBeVisible();
    await expect(rail.getByText('Newer review', { exact: true })).toBeVisible();
    await expect(rail.getByText('Newer review final answer')).toBeVisible();
    // Age: this row ended two hours ago.
    await expect(rail.getByText(/\b2\s?(h|hr|hrs|hours?)\b/).first()).toBeVisible();
    await expect(rail.getByText('Older review final answer')).toBeVisible();
    await expect(rail.getByText(/\b5\s?(h|hr|hrs|hours?)\b/).first()).toBeVisible();
  });

  test('ended rows add nothing to the need-you count or the watching count @G6.104', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(endedHeading(rail)).toBeVisible();
    await expect(page.getByRole('button', { name: '1 needs you', exact: true })).toBeVisible();
    await expect(page.getByText(/Watching 1 agent\b/)).toBeVisible();
    await expect(page.getByText(/Watching 3 agents/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^[2-9] need/ })).toHaveCount(0);
  });

  test('an ended row is read-only and has no action @G6.104', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(rail.getByText('Newer review', { exact: true })).toBeVisible();
    // Not a button, and no viewer.
    await expect(rail.getByRole('button', { name: 'Newer review', exact: true })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: 'Older review', exact: true })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /read-only/i })).toHaveCount(0);
    await expect(rail.getByText('View read-only')).toHaveCount(0);
    // Clicking the row opens no thread tab.
    await rail.getByText('Newer review', { exact: true }).click();
    await expect(rail.getByText('Newer review', { exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Newer review/ })).toHaveCount(0);
  });

  test('a new snapshot adds a newly ended session at the top of Ended @G6.104', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    await expect(rail.getByText('Newer review', { exact: true })).toBeVisible();
    await worlds.outside.replace(relay.dir, [
      endedRow('outside:e3', 'Latest review', 0.5),
      endedRow('outside:e1', 'Older review', 5),
    ]);
    const latest = rail.getByText('Latest review', { exact: true });
    await expect(latest).toBeVisible();
    await expect(rail.getByText('Newer review', { exact: true })).toHaveCount(0);
    const older = rail.getByText('Older review', { exact: true });
    expect((await latest.boundingBox()).y).toBeLessThan((await older.boundingBox()).y);
  });
});

test.describe('ended outside sessions on a phone', () => {
  test.use({
    ...profiles.phone,
    world: outsideWorld([
      outsideRow({ id: 'outside:live', name: 'Live runner' }),
      endedRow('outside:e1', 'Older review', 5),
      endedRow('outside:e2', 'Newer review', 2),
    ]),
  });

  test('the Agents sheet lists Ended, newest first @G6.104', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page, true);
    await page.getByRole('button', { name: /Agents$/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Live runner', exact: true })).toBeVisible();
    await expect(endedHeading(sheet)).toBeVisible();
    const newer = sheet.getByText('Newer review', { exact: true });
    const older = sheet.getByText('Older review', { exact: true });
    await expect(newer).toBeVisible();
    await expect(older).toBeVisible();
    expect((await newer.boundingBox()).y).toBeLessThan((await older.boundingBox()).y);
    await expect(sheet.getByRole('button', { name: 'Newer review', exact: true })).toHaveCount(0);
  });
});

test.describe('relay lists no ended rows', () => {
  test.use({ world: outsideWorld([outsideRow({ id: 'outside:live', name: 'Live runner' })]) });

  test('no Ended group and no error @G6.104.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const rail = railOf(page);
    // Absence is checked only after the live row has rendered.
    await expect(rail.getByRole('button', { name: 'Live runner', exact: true })).toBeVisible();
    await expect(endedHeading(rail)).toHaveCount(0);
    await expect(rail.getByText(/Ended/)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(rail.getByText(/error|failed|couldn't|cannot/i)).toHaveCount(0);
  });
});
