const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Two threads: Ledger rests, Hold is on a model whose reply is a permission
// prompt, so a message to it leaves it waiting on an answer nobody gives.
// fakerelay's Chief of Staff model only echoes and reports no tools, so a
// person turn ends in the "tools aren't set up" notice and a wake turn falls
// back to eve's template.
function cosWorld(calls = 20) {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: calls };
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
  w.sessions = [
    { id: 's_ledger', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'idle', messages: [{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'first answer' }] },
    { id: 's_hold', project_id: 'p_acme', name: 'Hold', model: 'acme-ask', state: 'idle', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] },
  ];
  return w;
}

const EMPTY = "Nothing yet. I'll post here when an agent needs you.";

// Opens Hold from Today and sends it a message. It then waits on a prompt, and
// the modal covers this page, so the thread is read from another browser.
async function holdThread(page) {
  await page.getByRole('button', { name: 'Hold', exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill('run it from testbox');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'Permission Request' })).toBeVisible();
}

async function openCos(page, phone = false) {
  const door = phone ? page.getByRole('navigation', { name: 'Navigation' }) : page;
  await door.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

async function tell(page, text) {
  await page.getByRole('textbox', { name: 'Tell an agent' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('the thread', () => {
  test.use({ world: cosWorld() });

  test('an empty thread says so @G6.33', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText(EMPTY)).toBeVisible();
  });

  test('send a question with the Send button @G6.35', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await tell(page, 'how is Ledger');
    await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toHaveValue('');
    await expect(page.getByRole('log').getByText('how is Ledger')).toBeVisible();
    await relay.waitForEvent('chat.turn');
  });

  test('an empty box sends nothing @G6.35.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText(/^Watching 2 agents/)).toBeVisible();
    const since = relay.mark();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(EMPTY)).toBeVisible();
    expect(await relay.logs({ event: 'chat.turn', since })).toHaveLength(0);
  });
});

test.describe('an agent that needs me', () => {
  test.use({ world: cosWorld() });

  test('jump to the agents that need me @G6.37', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await eve.openAnother('/');
    await openCos(other);
    await other.getByRole('button', { name: '1 needs you', exact: true }).click();
    await expect(other.getByRole('heading', { name: 'Needs you 1', level: 4 })).toBeFocused();
  });

  test('see every agent in the rail @G6.38', async ({ eve, page, relay }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await eve.openAnother('/');
    await openCos(other);
    const rail = other.getByRole('navigation', { name: 'Agents' });
    await expect(rail.getByRole('heading', { name: 'Needs you 1', level: 4 })).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Idle 1', level: 4 })).toBeVisible();
    const hold = rail.getByRole('button', { name: 'Hold', exact: true });
    await expect(hold).toContainText('Acme · Waiting on you');
    await expect(hold).toContainText('Hold is asking you something');
    await expect(rail.getByRole('button', { name: 'Ledger', exact: true })).toContainText('Acme · Idle');
    const sessions = (await relay.json('ctl', 'state', '--json')).sessions;
    // The Chief of Staff's own model sessions are unlisted (`__cos:`) and not agents.
    const seeded = cosWorld().sessions.map((s) => s.name).sort();
    expect(sessions.map((s) => s.name).filter((n) => !n.startsWith('__')).sort()).toEqual(seeded);
  });

  test('see the agent that asked in a post @G6.45', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await eve.openAnother('/');
    await openCos(other);
    const post = other.getByRole('article');
    await expect(post.getByRole('heading', { name: 'Hold is asking you something' })).toBeVisible();
    await expect(post).toContainText("It won't go further until you answer.");
    await expect(post.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
    await expect(post.getByRole('button', { name: 'Drop in', exact: true })).toBeVisible();
    await expect(post.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    await expect(other.getByRole('article')).toHaveCount(1);
  });

  test('answer an agent from its post @G6.46', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await eve.openAnother('/');
    await openCos(other);
    await other.getByRole('article').getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(other.getByRole('tab', { name: /Hold/ })).toBeVisible();
    await expect(other.getByRole('textbox', { name: /^Type / })).toBeFocused();
  });

  test('open an agent from its post @G6.48', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await eve.openAnother('/');
    await openCos(other);
    await other.getByRole('article').getByRole('button', { name: 'Open', exact: true }).click();
    await expect(other.getByRole('tab', { name: /Hold/ })).toBeVisible();
  });
});

test.describe('nothing needs me', () => {
  test.use({ world: cosWorld() });

  test('the count is plain text when no agent needs me @G6.37.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText('Watching 2 agents · 0 need you')).toBeVisible();
    await expect(page.getByRole('button', { name: /need.? you/ })).toHaveCount(0);
  });

  test('open an agent from a rail row @G6.39', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await page.getByRole('navigation', { name: 'Agents' }).getByRole('button', { name: 'Ledger', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Ledger/ })).toBeVisible();
    await expect(page.getByText('first answer')).toBeVisible();
  });

  test('an agent that ends its turn gets a summary line and no post @G6.42', async ({ eve, page }) => {
    await eve.open('/');
    const other = await eve.openAnother('/');
    await openCos(other);
    await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
    const box = page.getByRole('textbox', { name: 'Type your message...' });
    await expect(box).toBeEnabled();
    await box.fill('status please');
    await box.press('Enter');
    await expect(page.getByText('echo: status please')).toBeVisible();
    await expect(other.getByRole('navigation', { name: 'Agents' }).getByRole('button', { name: 'Ledger', exact: true })).toContainText('echo: status please');
    await expect(other.getByRole('article')).toHaveCount(0);
    await expect(other.getByText(EMPTY)).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use({ ...profiles.phone, world: cosWorld() });

  test('open the agents sheet @G6.43', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page, true);
    const strip = page.getByRole('button', { name: /Agents$/ });
    await expect(strip).toBeVisible();
    await expect(page.getByRole('button', { name: '2 idle Agents', exact: true })).toBeVisible();
    await strip.click();
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Hold', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Ledger', exact: true })).toBeVisible();
  });

  test('close the agents sheet @G6.44', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page, true);
    const strip = page.getByRole('button', { name: /Agents$/ });
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await strip.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(strip).toBeFocused();
    await strip.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(strip).toBeFocused();
  });

  test('close the agents sheet by a click above it or a drag down @G6.44', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page, true);
    const strip = page.getByRole('button', { name: /Agents$/ });
    const sheet = page.getByRole('dialog', { name: 'Agents' });
    await strip.click();
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y / 2);
    await expect(sheet).toBeHidden();
    await expect(strip).toBeFocused();
    await strip.click();
    await expect(sheet).toBeVisible();
    const title = await sheet.getByRole('heading', { name: 'AGENTS' }).boundingBox();
    const x = title.x + title.width / 2;
    const y = title.y + title.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 80, { steps: 8 });
    await page.mouse.up();
    await expect(sheet).toBeHidden();
    await expect(strip).toBeFocused();
  });

  test('no counts when relay is down @G6.43.r1', async ({ eve, page, relay }) => {
    const added = await relay.ctl('fault', 'add', '--route', 'GET /api/sessions', '--mode', 'down');
    expect(added.code).toBe(0);
    await eve.open('/');
    await openCos(page, true);
    await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '2 idle Agents', exact: true })).toBeHidden();
  });
});

test.describe('a terminal that has ended', () => {
  const w = cosWorld();
  w.terminal_templates = [{ id: 't_sh', name: 'Shell' }];
  test.use({ world: w });

  test('show and hide the finished agents @G6.40', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Shell', exact: true }).first().click();
    const tab = page.getByRole('tab', { name: 'Acme - Shell' });
    await expect(tab).toBeVisible();
    await openCos(page);
    const rail = page.getByRole('navigation', { name: 'Agents' });
    await expect(rail.getByRole('heading', { name: 'Working 1', level: 4 })).toBeVisible();
    await tab.click();
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await input.focus();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await openCos(page);
    const done = rail.getByRole('button', { name: 'Done 1', exact: true });
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(rail.getByRole('button', { name: /Shell/ })).toBeHidden();
    await done.click();
    await expect(done).toHaveAttribute('aria-expanded', 'true');
    await expect(rail.getByRole('button', { name: /Shell/ })).toBeVisible();
    await done.click();
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(rail.getByRole('button', { name: /Shell/ })).toBeHidden();
  });
});

test.describe('chief of staff off', () => {
  test.use({ world: cosWorld(), eveSettings: { chiefOfStaff: { enabled: false } } });

  test('say why it is off @G6.63', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await expect(page.getByText('Not watching')).toBeVisible();
    await expect(page.getByText("Chief of Staff is off in eve's settings.")).toBeVisible();
  });

  test('a message says it is off @G6.34.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await tell(page, 'hello');
    await expect(page.getByText("I'm off in eve's settings, so I can't send.")).toBeVisible();
  });
});

test.describe('no project can run it', () => {
  const w = cosWorld();
  delete w.chief_of_staff;
  w.projects[0].allowed_models = ['acme-ask'];
  test.use({ world: w });

  test('say which setting to change @G6.63.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await tell(page, 'hello');
    await expect(page.getByText("No project can run the Chief of Staff. Pick one in relay's Settings, under Projects > Chief of Staff.")).toBeVisible();
  });
});

test.describe('the chosen project cannot run it', () => {
  const w = cosWorld();
  w.projects[0].allowed_models = ['acme-ask'];
  test.use({ world: w });

  test('say which setting to change @G6.64.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openCos(page);
    await tell(page, 'hello');
    await expect(page.getByText("No project can run the Chief of Staff. Pick one in relay's Settings, under Projects > Chief of Staff.")).toBeVisible();
  });
});

test.describe('the daily limit', () => {
  test.use({ world: cosWorld(1) });

  test('a message past the limit says so @G6.34.r2', async ({ eve, page }) => {
    await eve.open('/');
    await holdThread(page);
    const other = await eve.openAnother('/');
    await openCos(other);
    await expect(other.getByRole('article').getByRole('heading', { name: 'Hold is asking you something' })).toBeVisible();
    await tell(other, 'hello');
    await expect(other.getByText("I've reached today's limit, so I can't send until tomorrow.")).toBeVisible();
  });
});
