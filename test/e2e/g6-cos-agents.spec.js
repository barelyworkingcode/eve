const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Seeded posts are `{ v: 1, id, at: <ISO time>, kind, byModel: true, card }` with the card shapes of docs/api.md.
// A card is a role `article`, one per test; its rows read as "<Label><value>" text.

function cosWorld({ presence = 'approve' } = {}) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.presence = { 'project.agent': presence };
  return w;
}

function hostedCosWorld({ presence = 'approve' } = {}) {
  const w = cosWorld({ presence });
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash', tmux_path: '/usr/bin/tmux' },
    tmux_path: '/usr/bin/tmux',
    agent: 'connected',
  }];
  w.projects.push({ id: 'p_box', name: 'Orchard', host_id: 'h_box', path: '/home/acme/orchard', mode: 'work', files: { 'todo.txt': 'one\n' } });
  return w;
}

function addCard(id, entry, { project = { id: 'p_acme', name: 'Acme' }, machine = 'this Mac' } = {}) {
  return {
    v: 1,
    id,
    at: new Date().toISOString(),
    kind: 'agent_card',
    byModel: true,
    card: {
      state: 'pending', project, machine,
      entry: { name: entry.name, kind: entry.kind, model: entry.model ?? null, command: entry.command ?? null },
      why: 'add_needs_tap', turnId: 't_1', error: null,
    },
  };
}

function startCard(id, entry) {
  return {
    v: 1,
    id,
    at: new Date().toISOString(),
    kind: 'start_card',
    byModel: true,
    card: {
      state: 'pending', project: { id: 'p_acme', name: 'Acme' }, folder: null, model: null, entry,
      mode: 'headless', prompt: 'tidy the readme', why: 'read_not_verbatim', turnId: 't_1', result: null, error: null,
    },
  };
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

async function agentsOf(relay, projectId) {
  const state = await relay.json('ctl', 'state', '--json');
  const project = state.projects.find((p) => p.id === projectId);
  return (project && project.agents) || [];
}

// Holds the add request at relay, so the card can be read while the person has not yet approved.
async function holdAdd(relay, projectId = '{id}') {
  const added = await relay.ctl('fault', 'add', '--route', `POST /api/projects/${projectId}/agents`, '--mode', 'slow');
  expect(added.code).toBe(0);
  return JSON.parse(added.stdout).id;
}

test.describe('add a codex agent', () => {
  test.use({ world: cosWorld(), cosPosts: [addCard('c_add', { name: 'codex', kind: 'codex' })] });

  test('tap Add on a codex card adds it after presence @G6.84', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await expect(card).toContainText(/Name\s*codex/);
    await expect(card).toContainText(/Kind\s*codex/);
    await expect(card).toContainText(/Model\s*default/);
    await expect(card).toContainText(/Runs on\s*this Mac/);
    // The person only taps: nothing on the card is editable.
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await expect(card.getByRole('combobox')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    expect(await agentsOf(relay, 'p_acme')).toEqual([]);

    const faultId = await holdAdd(relay);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(card.getByText('Approve on the Mac')).toBeVisible();
    expect(await agentsOf(relay, 'p_acme')).toEqual([]);

    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await expect(card.getByText('Added', { exact: true })).toBeVisible();
    await relay.waitForEvent('agent.add', { match: (l) => l.status === 'ok' });
    const agents = await agentsOf(relay, 'p_acme');
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'codex', kind: 'codex' });
  });
});

test.describe('add a named command on a host', () => {
  test.use({
    world: hostedCosWorld(),
    pathCommands: ['mywrapper'],
    cosPosts: [addCard('c_add', { name: 'mywrapper', kind: 'claude', command: 'mywrapper' }, { project: { id: 'p_box', name: 'Orchard' }, machine: 'testbox' })],
  });

  test('a card for a named command shows its path and runs on testbox @G6.84', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await expect(card).toContainText(/Name\s*mywrapper/);
    await expect(card).toContainText(/Command\s*mywrapper/);
    await expect(card).toContainText(/Runs on\s*testbox/);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card.getByText('Added', { exact: true })).toBeVisible();
    await relay.waitForEvent('agent.add', { match: (l) => l.status === 'ok' });
    const agents = await agentsOf(relay, 'p_box');
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'mywrapper', command: expect.stringMatching(/^\/.*\/mywrapper$/) });
    // The card now shows the absolute path relay stored, not the bare name.
    const stored = agents[0].command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(card).toContainText(new RegExp(`Command\\s*${stored}`));
  });
});

test.describe('add an agent with its own name', () => {
  test.use({ world: cosWorld(), cosPosts: [addCard('c_add', { name: 'piLocal', kind: 'pi', model: 'local/coder' })] });

  test('an entry named piLocal is added under that name @G6.84', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await expect(card).toContainText(/Name\s*piLocal/);
    await expect(card).toContainText(/Kind\s*pi/);
    await expect(card).toContainText(/Model\s*local\/coder/);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card.getByText('Added', { exact: true })).toBeVisible();
    await relay.waitForEvent('agent.add', { match: (l) => l.status === 'ok' });
    const agents = await agentsOf(relay, 'p_acme');
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'piLocal', kind: 'pi', model: 'local/coder' });
  });
});

test.describe('presence refused', () => {
  test.use({ world: cosWorld({ presence: 'deny' }), cosPosts: [addCard('c_add', { name: 'codex', kind: 'codex' })] });

  test('presence refused writes nothing @G6.84.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card.getByText('Failed: presence was refused')).toBeVisible();
    await expect(card.getByText('Added', { exact: true })).toHaveCount(0);
    expect(await agentsOf(relay, 'p_acme')).toEqual([]);
    const writes = await relay.logs({ event: 'agent.add' });
    expect(writes.filter((l) => l.status === 'ok')).toHaveLength(0);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  });
});

test.describe('presence timed out', () => {
  test.use({ world: cosWorld({ presence: 'timeout' }), cosPosts: [addCard('c_add', { name: 'codex', kind: 'codex' })] });

  test('presence timed out writes nothing @G6.84.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    // Relay gives no answer on a timeout and eve sets no timer: the card keeps waiting.
    await relay.waitForEvent('debug.presence.answer', { match: (l) => l.answer === 'timeout' });
    await expect(card.getByText('Approve on the Mac')).toBeVisible();
    await expect(card.getByText('Added', { exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    expect(await agentsOf(relay, 'p_acme')).toEqual([]);
    const writes = await relay.logs({ event: 'agent.add' });
    expect(writes.filter((l) => l.status === 'ok')).toHaveLength(0);
  });
});

test.describe('a command relay cannot find', () => {
  test.use({
    world: hostedCosWorld(),
    cosPosts: [addCard('c_add', { name: 'ghost', kind: 'claude', command: 'ghost' }, { project: { id: 'p_box', name: 'Orchard' }, machine: 'testbox' })],
  });

  test('relay refuses a command it cannot find @G6.84.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    const failed = card.getByText(/^Failed: /);
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('ghost');
    await expect(failed).toContainText('testbox');
    expect(await agentsOf(relay, 'p_box')).toEqual([]);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  });
});

test.describe('cancel an add card', () => {
  test.use({ world: cosWorld(), cosPosts: [addCard('c_add', { name: 'codex', kind: 'codex' })] });

  test('cancel an add card @G6.85', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    expect(await agentsOf(relay, 'p_acme')).toEqual([]);
    // The marker above shows eve has handled the tap; relay saw no write.
    expect(await relay.logs({ event: 'agent.add' })).toHaveLength(0);
  });
});

function agentsWorld() {
  const w = cosWorld();
  w.projects[0].agents = [
    { name: 'codex', kind: 'codex', model: 'gpt-x' },
    { name: 'mywrapper', kind: 'claude' },
    { name: 'Researcher', kind: 'claude' },
  ];
  // relay offers a codex entry only the models its catalogue lists.
  w.models = [...(w.models || []), { value: 'codex/gpt-x', label: 'GPT X', group: 'Codex', provider: 'codex' }];
  return w;
}

test.describe('start a named agent', () => {
  test.use({ world: agentsWorld(), cosPosts: [startCard('c_start', 'codex')] });

  test('start a named agent from its Start card @G6.87', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await expect(card).toContainText(/Prompt\s*tidy the readme/);
    await expect(card).toContainText(/Folder/);
    await expect(card).toContainText(/Agent\s*codex/);
    // A named agent carries its own model and mode.
    await expect(card).not.toContainText(/\bModel\b/);
    await expect(card).not.toContainText(/\bMode\b/);
    await card.getByRole('button', { name: 'Start', exact: true }).click();
    // <name> is the session name relay gives the start, as for any Start card.
    await expect(card.getByText('Started tidy the readme', { exact: true })).toBeVisible();
    await expect(page.getByText('Started tidy the readme in Acme.')).toBeVisible();
    await relay.waitForEvent('chief_of_staff.start');
    await expect.poll(async () => {
      const state = await relay.json('ctl', 'state', '--json');
      return state.sessions.filter((s) => !String(s.name).startsWith('__')).map((s) => s.model);
    }).toContain('codex/gpt-x');
  });
});

test.describe('start an agent that is not there', () => {
  test.use({ world: agentsWorld(), cosPosts: [startCard('c_start', 'codx')] });

  test('a start naming no agent shows relay\'s choices @G6.87.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Start', exact: true }).click();
    const failed = card.getByText(/^Failed: /);
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('Choices');
    for (const name of ['codex', 'mywrapper', 'Researcher']) await expect(failed).toContainText(name);
  });
});
