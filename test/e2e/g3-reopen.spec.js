const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const PALETTE = 'Jump to a session, project, file or action…';

function thread(id, name, extra = {}) {
  return {
    id,
    project_id: 'p_acme',
    name,
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: `question in ${name}` }, { role: 'assistant', text: `answer in ${name}` }],
    ...extra,
  };
}

function threadsWorld(...names) {
  const w = worlds.base();
  w.sessions = names.map((n, i) => thread(`s_t${i + 1}`, n));
  return w;
}

async function openProjectPage(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
}

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  w.projects[0].allowed_templates = ['shell'];
  return w;
}

// Opens the Launcher from the Project panel and switches to its Resume tab.
async function openResume(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
  await launcher.getByRole('button', { name: 'Resume' }).click();
  return launcher;
}

async function sessionIds(relay) {
  return (await relay.json('ctl', 'state', '--json')).sessions.map((s) => s.id);
}

test('open the Project page from a link @G3.2', async ({ eve, page }) => {
  await eve.open('/#project/p_acme');
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
});

test('a link to an unknown project says so @G3.2.r1', async ({ eve, page }) => {
  await eve.open('/#project/p_missing');
  await expect(page.getByText('Project not found.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeHidden();
});

test.describe('threads from yesterday', () => {
  test.use({ world: threadsWorld('Ledger', 'Roadmap') });

  test('open a thread from the Project page Threads list @G3.3', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await page.getByRole('button', { name: 'Ledger', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
    await expect(page.getByText('question in Ledger')).toBeVisible();
    await expect(page.getByText('answer in Ledger')).toBeVisible();
    // The earlier messages come back in the order they were written.
    const asked = await page.getByText('question in Ledger').boundingBox();
    const answered = await page.getByText('answer in Ledger').boundingBox();
    expect(asked.y).toBeLessThan(answered.y);
    await expect(page.getByText('question in Roadmap')).toBeHidden();
    // Opening it makes no new thread: back on the Project page the count is still two.
    await page.getByRole('tab', { name: 'Acme' }).click();
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
    await expect(page.getByText('2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(2);
  });

  test('open a recent thread from the Continue list @G3.6', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toBeVisible();
    await expect(page.getByText('question in Roadmap')).toBeVisible();
    await expect(page.getByText('answer in Roadmap')).toBeVisible();
  });

  test('jump to a thread from the Command palette @G3.8', async ({ eve, page }) => {
    await eve.open('/');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: PALETTE });
    await palette.getByRole('textbox', { name: PALETTE }).fill('Roadmap');
    await expect(palette.getByRole('option', { name: 'Roadmap' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toBeVisible();
    await expect(page.getByText('answer in Roadmap')).toBeVisible();
  });

  test('a search that matches nothing says so @G3.8.r1', async ({ eve, page }) => {
    await eve.open('/');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: PALETTE });
    await palette.getByRole('textbox', { name: PALETTE }).fill('zzzz');
    await expect(palette.getByText('No matches for “zzzz”')).toBeVisible();
  });

  test('open a thread from the Launcher Resume tab @G3.10', async ({ eve, page }) => {
    await eve.open('/');
    const launcher = await openResume(page);
    await launcher.getByRole('button', { name: 'Ledger', exact: true }).click();
    await expect(launcher).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
    await expect(page.getByText('answer in Ledger')).toBeVisible();
  });

  test('delete a thread from the Launcher Resume tab @G3.12', async ({ eve, page, relay }) => {
    await eve.open('/');
    const launcher = await openResume(page);
    await launcher.getByRole('button', { name: 'Delete session Ledger' }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(confirm.getByText('Delete session "Ledger"? This will terminate the process and delete all history.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => sessionIds(relay)).toEqual(['s_t2']);
    await launcher.getByRole('button', { name: 'Close' }).click();
    const again = await openResume(page);
    await expect(again.getByRole('button', { name: 'Roadmap', exact: true })).toBeVisible();
    await expect(again.getByRole('button', { name: 'Ledger', exact: true })).toBeHidden();
  });

  test('cancel the delete and the thread stays @G3.12.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const launcher = await openResume(page);
    await launcher.getByRole('button', { name: 'Delete session Ledger' }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(launcher.getByRole('button', { name: 'Ledger', exact: true })).toBeVisible();
    expect(await sessionIds(relay)).toEqual(['s_t1', 's_t2']);
  });

  test('get your open threads back after a reload @G3.14', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
    await page.getByRole('tab', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'Ledger', exact: true }).click();
    await expect(page.getByText('answer in Ledger')).toBeVisible();
    // A reload starts the page again: the open palette is gone, the thread tabs are not.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: PALETTE });
    await expect(palette).toBeVisible();
    await eve.reload();
    await expect(palette).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('question in Ledger')).toBeVisible();
    await expect(page.getByText('answer in Ledger')).toBeVisible();
  });

  test('open a thread from a link to it @G3.16', async ({ eve, page }) => {
    await eve.open('/#session/s_t2');
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toBeVisible();
    await expect(page.getByText('answer in Roadmap')).toBeVisible();
  });

  test('a link to an unknown thread says so @G3.16.r1', async ({ eve, page }) => {
    await eve.open('/#session/s_missing');
    await expect(page.getByText('Session not found.')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeHidden();
  });
});

test.describe('many threads', () => {
  test.use({ world: threadsWorld('A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7') });

  test('Continue shows at most six threads @G3.6', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByRole('button', { name: /^A\d$/ })).toHaveCount(6);
  });

  test('the palette lists six threads, opened tabs first @G3.9', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'A6', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'A6' })).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: PALETTE });
    const sessions = palette.getByRole('option', { name: /^A\d$/ });
    await expect(sessions).toHaveCount(6);
    await expect(sessions.first()).toHaveAccessibleName('A6');
  });
});

test.describe('a running terminal', () => {
  test.use({ world: shellWorld() });

  test('switch to a running terminal from the Launcher Resume tab @G3.11', async ({ eve, page, relay }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'New Session' }).click();
    await page.getByRole('dialog', { name: 'Shell Launcher' }).getByRole('button', { name: 'Shell' }).click();
    const input = page.getByRole('textbox', { name: 'Terminal input' });
    await expect(input).toBeAttached();
    await expect.poll(async () => (await relay.json('ctl', 'state', '--json')).terminals.length).toBe(1);
    // Leave the terminal for the Project page, then come back to it from the Resume tab.
    await page.getByRole('button', { name: 'Project page' }).click();
    await expect(page.getByRole('tab', { name: 'Acme', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'false');
    const launcher = await openResume(page);
    await launcher.getByRole('button', { name: 'Acme - Shell running' }).click();
    await expect(launcher).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
    expect((await relay.json('ctl', 'state', '--json')).terminals.length).toBe(1);
  });
});

const LONG_FIRST = 'Plan the quarterly budget review with the finance team and list every open risk before the Friday sync';
const LONG_NAME = 'Plan the quarterly budget review with the finance team and list every…';

test.describe('a thread named only by its model', () => {
  test.use({
    world: (() => {
      const w = threadsWorld('haiku');
      w.sessions[0].messages[0].text = LONG_FIRST;
      return w;
    })(),
  });

  test('see a thread named by your first message @G3.17', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page);
    // The name is learned from the first message when the thread is opened.
    await page.getByRole('button', { name: 'haiku', exact: true }).click();
    await expect(page.getByText(LONG_FIRST)).toBeVisible();
    await expect(page.getByRole('tab', { name: LONG_NAME })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await expect(page.getByRole('button', { name: LONG_NAME, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'haiku', exact: true })).toBeHidden();
  });
});

test.describe('a thread named with the project prefix', () => {
  test.use({ world: threadsWorld('Acme - Ledger') });

  test('see thread names without the project prefix @G3.18', async ({ eve, page }) => {
    await eve.open('/');
    // Continue on Today.
    await expect(page.getByRole('button', { name: 'Ledger', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acme - Ledger' })).toHaveCount(0);
    // The Project page row.
    await openProjectPage(page);
    const row = page.getByRole('button', { name: 'Ledger', exact: true });
    await expect(row).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acme - Ledger' })).toHaveCount(0);
    // The palette.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: PALETTE });
    await expect(palette.getByRole('option', { name: 'Ledger', exact: true })).toBeVisible();
    await expect(palette.getByRole('option', { name: 'Acme - Ledger' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    // The tab.
    await row.click();
    await expect(page.getByText('answer in Acme - Ledger')).toBeVisible();
    // Tabs keep the prefix: the tab bar is where project context lives.
    await expect(page.getByRole('tab', { name: 'Acme - Ledger', exact: true })).toBeVisible();
  });
});

test('see Continue when there are no threads @G3.7', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByText('Nothing yet. Start a session above and it will show up here.')).toBeVisible();
});

test('see the Resume tab with nothing to resume @G3.13', async ({ eve, page }) => {
  await eve.open('/');
  const launcher = await openResume(page);
  await expect(launcher.getByText('No active sessions or terminals.')).toBeVisible();
});

test('see that the Threads list is empty @G3.5', async ({ eve, page }) => {
  await eve.open('/');
  await openProjectPage(page);
  await expect(page.getByText('No threads yet.')).toBeVisible();
});
