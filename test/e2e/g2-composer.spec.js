const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

// A dormant thread: relay answers the first message with "resume required", and eve resumes
// it over POST /api/sessions/{id}/resume. Holding that route keeps the turn at "Thinking...".
function ledgerWorld() {
  const w = worlds.base();
  w.sessions = [{
    id: 's_ledger',
    project_id: 'p_acme',
    name: 'Ledger',
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }],
  }];
  return w;
}

// The same thread on a model whose reply is a permission prompt: the turn stays open until
// someone answers, and both browsers see it.
function askingLedgerWorld() {
  const w = ledgerWorld();
  w.projects[0].allowed_models = ['acme-ask'];
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
  w.sessions[0].model = 'acme-ask';
  w.sessions[0].state = 'idle';
  return w;
}

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  w.projects[0].allowed_templates = ['shell'];
  return w;
}

async function startThread(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await page.getByRole('button', { name: 'Web Chat' }).click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeVisible();
  await expect(box).toBeEnabled();
  return box;
}

async function openLedger(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await page.getByRole('button', { name: 'Ledger', exact: true }).last().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await expect(page.getByText('earlier answer')).toBeVisible();
  return box;
}

async function holdResume(relay) {
  const hold = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions/{id}/resume', '--mode', 'slow');
  expect(hold.code).toBe(0);
  return JSON.parse(hold.stdout).id;
}

async function turns(relay) {
  return (await relay.logs({ event: 'chat.turn' })).length;
}

test.describe('a turn that is held', () => {
  test.use({ world: ledgerWorld() });

  test('send a message with the Return key @G2.12', async ({ eve, page, relay }) => {
    await eve.open('/');
    const box = await openLedger(page);
    const hold = await holdResume(relay);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await box.press('Enter');
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
    await expect(page.getByText('hello from testbox', { exact: true })).toBeVisible();
    await expect(page.getByText('Thinking...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeHidden();
    expect((await relay.ctl('fault', 'release', '--id', hold)).code).toBe(0);
    await expect(page.getByText('echo: hello from testbox')).toBeVisible();
    await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  });

  test('send a message with the Send button @G2.13', async ({ eve, page, relay }) => {
    await eve.open('/');
    const box = await openLedger(page);
    const hold = await holdResume(relay);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await page.getByRole('button', { name: 'Send' }).click();
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
    await expect(page.getByText('hello from testbox', { exact: true })).toBeVisible();
    await expect(page.getByText('Thinking...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeHidden();
    expect((await relay.ctl('fault', 'release', '--id', hold)).code).toBe(0);
    await expect(page.getByText('echo: hello from testbox')).toBeVisible();
    await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  });
});

test.describe('a turn that waits for an answer', () => {
  test.use({ world: askingLedgerWorld() });

  test('a message sent in one browser shows in the other @G2.39', async ({ eve, page, relay }) => {
    await eve.open('/');
    const box = await openLedger(page);
    const other = await eve.openAnother('/');
    await openLedger(other);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await box.press('Enter');
    await expect(other.getByText('hello from testbox', { exact: true })).toBeVisible();
    // The permission turn replaces "Thinking..." with a tool step at once, so Stop is the marker here.
    await expect(other.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('echo: hello from testbox')).toBeVisible();
    await expect(other.getByText('echo: hello from testbox')).toBeVisible();
    await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  });
});

test('an empty box sends nothing @G2.12.r1', async ({ eve, page, relay }) => {
  const box = await startThread(eve, page);
  await box.press('Enter');
  // The marker turn shows the empty Return has been handled; it is the only turn relay saw.
  await box.fill('marker from testbox');
  await box.press('Enter');
  await expect(page.getByText('echo: marker from testbox')).toBeVisible();
  await relay.waitForEvent('chat.turn', { match: (l) => l.status === 'ok' });
  expect(await turns(relay)).toBe(1);
});

test('offline, Return sends nothing @G2.12.r2', async ({ eve, page, relay }) => {
  const box = await startThread(eve, page);
  await eve.setOffline(true);
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await box.fill('offline from testbox');
  await box.press('Enter');
  await eve.setOffline(false);
  await expect(page.getByText('Reconnecting…')).toBeHidden();
  await expect(box).toBeEnabled();
  expect(await turns(relay)).toBe(0);
});

test('offline, Send is disabled @G2.13.r1', async ({ eve, page }) => {
  const box = await startThread(eve, page);
  await box.fill('offline from testbox');
  await eve.setOffline(true);
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('add a new line without sending @G2.14', async ({ eve, page, relay }) => {
  const box = await startThread(eve, page);
  await box.fill('line one');
  const before = await box.boundingBox();
  await box.press('Shift+Enter');
  await box.pressSequentially('line two');
  await expect(box).toHaveValue('line one\nline two');
  await expect.poll(async () => (await box.boundingBox()).height).toBeGreaterThan(before.height);
  await box.press('Enter');
  await expect(page.getByText('echo: line one')).toBeVisible();
  await relay.waitForEvent('chat.turn', { match: (l) => l.status === 'ok' });
  expect(await turns(relay)).toBe(1);
});

test('clear the conversation with /clear @G2.17', async ({ eve, page }) => {
  const box = await startThread(eve, page);
  await box.fill('hello from testbox');
  await box.press('Enter');
  await expect(page.getByText('echo: hello from testbox')).toBeVisible();
  await box.fill('/clear');
  await box.press('Enter');
  await expect(page.getByText('echo: hello from testbox')).toBeHidden();
  await expect(page.getByText('hello from testbox', { exact: true })).toBeHidden();
});

test('list the built-in commands with /help @G2.18', async ({ eve, page }) => {
  const box = await startThread(eve, page);
  await box.fill('/help');
  await box.press('Enter');
  const help = page.getByText(/^Commands:/);
  await expect(help).toBeVisible();
  for (const command of ['/clear', '/zsh', '/bash', '/claude', '/rh', '/help']) {
    await expect(help).toContainText(command);
  }
});

test.describe('a terminal template', () => {
  test.use({ world: shellWorld() });

  test('open a terminal from the composer with /zsh @G2.19', async ({ eve, page, relay }) => {
    const box = await startThread(eve, page);
    await box.fill('/zsh');
    await box.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
    await expect.poll(async () => (await relay.json('ctl', 'state', '--json')).terminals.length).toBe(1);
  });
});

test('send a provider command such as /compact @G2.20', async ({ eve, page, relay }) => {
  const box = await startThread(eve, page);
  const since = relay.mark();
  await box.fill('/compact');
  await box.press('Enter');
  await expect(page.getByText('echo: /compact')).toBeVisible();
  await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
});

test('recall an earlier message with the Up arrow @G2.21', async ({ eve, page }) => {
  const box = await startThread(eve, page);
  await box.fill('first message');
  await box.press('Enter');
  await expect(page.getByText('echo: first message')).toBeVisible();
  await box.fill('second message');
  await box.press('Enter');
  await expect(page.getByText('echo: second message')).toBeVisible();
  await box.fill('my draft');
  await box.press('ArrowUp');
  await expect(box).toHaveValue('second message');
  await box.press('ArrowUp');
  await expect(box).toHaveValue('first message');
  await box.press('ArrowDown');
  await expect(box).toHaveValue('second message');
  await box.press('ArrowDown');
  await expect(box).toHaveValue('my draft');
});

test.describe('on a tablet', () => {
  test.use(profiles.tablet);

  test("open the project list from a thread's header @G2.23", async ({ eve, page }) => {
    await eve.open('/');
    const ask = page.getByRole('textbox', { name: 'Ask' });
    await ask.fill('hello from testbox');
    await ask.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project page' })).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('button', { name: 'Project page' })).toBeInViewport();
  });
});
