const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Seeded posts are `{ v: 1, id, at: <ISO time>, kind, byModel: true, card }` with the card shapes of docs/api.md.
// The sentence-to-card step needs a live model turn and is covered by the devbox journey, not here.

function cosWorld({ presence = 'approve' } = {}) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.presence = { 'project.chat_template': presence };
  return w;
}

function chatCard(id, name, model = 'local/chat') {
  return {
    v: 1,
    id,
    at: new Date().toISOString(),
    kind: 'chat_card',
    byModel: true,
    card: {
      state: 'pending', project: { id: 'p_acme', name: 'Acme' }, template: { name, model },
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
      mode: 'headless', prompt: 'review the readme', why: 'read_not_verbatim', turnId: 't_1', result: null, error: null,
    },
  };
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

async function chatsOf(relay, projectId) {
  const state = await relay.json('ctl', 'state', '--json');
  const project = state.projects.find((p) => p.id === projectId);
  return (project && project.chat_templates) || [];
}

async function chatWrites(relay) {
  const rows = await relay.logs({ event: 'chat_template.add' });
  return rows.filter((l) => l.status === 'ok');
}

test.describe('add a chat', () => {
  test.use({ world: cosWorld(), cosPosts: [chatCard('c_chat', 'Researcher')] });

  test('tap Add on a chat card adds it after presence @G6.90', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await expect(card).toContainText(/Name\s*Researcher/);
    await expect(card).toContainText(/Model\s*local\/chat/);
    // The person only taps: nothing on the card is editable.
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await expect(card.getByRole('combobox')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    expect(await chatsOf(relay, 'p_acme')).toEqual([]);

    const held = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/chat-templates', '--mode', 'slow');
    expect(held.code).toBe(0);
    const faultId = JSON.parse(held.stdout).id;
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' });
    await expect(card.getByText('Approve on the Mac')).toBeVisible();
    expect(await chatsOf(relay, 'p_acme')).toEqual([]);

    expect((await relay.ctl('fault', 'release', '--id', faultId)).code).toBe(0);
    await expect(card.getByText('Added', { exact: true })).toBeVisible();
    await relay.waitForEvent('chat_template.add', { match: (l) => l.status === 'ok' });
    const chats = await chatsOf(relay, 'p_acme');
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ name: 'Researcher', model: 'local/chat' });
  });
});

test.describe('chat presence refused', () => {
  test.use({ world: cosWorld({ presence: 'deny' }), cosPosts: [chatCard('c_chat', 'Researcher')] });

  test('presence refused writes nothing @G6.90.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card.getByText('Failed: presence was refused')).toBeVisible();
    await expect(card.getByText('Added', { exact: true })).toHaveCount(0);
    expect(await chatsOf(relay, 'p_acme')).toEqual([]);
    expect(await chatWrites(relay)).toHaveLength(0);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  });
});

test.describe('chat name an agent already uses', () => {
  const world = cosWorld();
  world.projects[0].agents = [{ name: 'Researcher', kind: 'claude' }];
  test.use({ world, cosPosts: [chatCard('c_chat', 'Researcher')] });

  test('relay refuses a name an agent uses @G6.90.r2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card.getByText('Failed: "Researcher" is already an agent in Acme')).toBeVisible();
    expect(await chatsOf(relay, 'p_acme')).toEqual([]);
    expect(await chatWrites(relay)).toHaveLength(0);
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  });
});

test.describe('cancel a chat card', () => {
  test.use({ world: cosWorld(), cosPosts: [chatCard('c_chat', 'Researcher')] });

  test('cancel a chat card @G6.91', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    expect(await chatsOf(relay, 'p_acme')).toEqual([]);
    expect(await relay.logs({ event: 'chat_template.add' })).toHaveLength(0);
  });
});

function chatStartWorld() {
  const w = cosWorld();
  w.projects[0].chat_templates = [{ id: 't_researcher', name: 'Researcher', model: 'local/chat' }];
  w.models = [{ value: 'local/chat', label: 'Local chat', group: 'Local', provider: 'chat' }];
  return w;
}

test.describe('start a chat by name', () => {
  test.use({ world: chatStartWorld(), cosPosts: [startCard('c_start', 'Researcher')] });

  test('start a chat from its Start card and open it @G6.92', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    const card = page.getByRole('article');
    await expect(card).toContainText(/Prompt\s*review the readme/);
    await expect(card).toContainText(/Agent\s*Researcher/);
    await card.getByRole('button', { name: 'Start', exact: true }).click();
    await relay.waitForEvent('chief_of_staff.start');
    await expect.poll(async () => {
      const state = await relay.json('ctl', 'state', '--json');
      return state.sessions.filter((s) => !String(s.name).startsWith('__')).map((s) => `${s.model}|${s.name}`);
    }).toContain('local/chat|Acme - Researcher');

    // Open lands in the started chat, which holds the prompt the Chief of Staff sent. Its reply is not asserted here:
    // the pinned fakerelay keeps only the user message in a headless turn's history (the devbox journey reads the reply).
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Acme - Researcher' })).toBeVisible();
    await expect(page.getByText('Sent by Chief of Staff')).toBeVisible();
  });
});
