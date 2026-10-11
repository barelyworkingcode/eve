const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

function withThreads() {
  const w = worlds.base();
  w.sessions = [
    { id: 's_alpha', project_id: 'p_acme', name: 'Alpha notes', model: 'sonnet', state: 'idle', messages: [{ role: 'user', text: 'hello alpha' }, { role: 'assistant', text: 'echo: hello alpha' }] },
    { id: 's_beta', project_id: 'p_acme', name: 'Beta notes', model: 'sonnet', state: 'idle', messages: [{ role: 'user', text: 'hello beta' }, { role: 'assistant', text: 'echo: hello beta' }] },
  ];
  return w;
}

async function openProjectPage(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
}

async function openProjectPageOnPhone(eve, page) {
  await eve.open('/');
  await page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: 'Threads' }).click();
  await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
}

// The thread also shows as an agent row and in the panel tree; only the Threads row carries its model.
const row = (page, name) => page.getByRole('button', { name, exact: true }).filter({ hasText: 'sonnet' });
// A folder header on the Project page: the name button, then the thread count (text "Ideas1").
const folder = (page, name) => page.getByText(new RegExp(`^${name}\\s*\\d+$`));
async function sessionNames(relay) {
  const state = await relay.json('ctl', 'state', '--json');
  return state.sessions.map((s) => s.name);
}

// A Cancel sends nothing to relay, so a read right after it can pass before a delete would have
// arrived. The barrier: send a message on the same socket and wait for relay's chat.turn, which
// can only follow a delete that Cancel had wrongly sent. Then no delete is on record since the mark.
async function expectNoDeleteSince(page, relay, since) {
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill('after cancel from testbox');
  await box.press('Enter');
  await relay.waitForEvent('chat.turn', { since });
  expect(await relay.logs({ event: 'session.delete', since })).toHaveLength(0);
}

async function makeFolder(page, name) {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(folder(page, name)).toBeVisible();
}

async function moveTo(page, thread, target) {
  await row(page, thread).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
  await page.getByRole('menuitem', { name: target }).click();
}

test.describe('threads on the Project page', () => {
  test.use({ world: withThreads() });

  test('rename a thread @G2.40', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click();
    await expect(page.getByRole('tab', { name: 'Alpha notes' })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme' }).click();
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('textbox', { name: 'Session name' }).fill('Gamma notes');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(row(page, 'Gamma notes')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Gamma notes' })).toBeVisible();
    await expect(row(page, 'Alpha notes')).toHaveCount(0);
  });

  test('an unchanged name keeps the thread name @G2.40.r1', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const box = page.getByRole('textbox', { name: 'Session name' });
    await box.fill('Alpha notes');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(box).toBeHidden();
    await expect(row(page, 'Alpha notes')).toBeVisible();
  });

  test('an empty name keeps the thread name @G2.40.r1', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const box = page.getByRole('textbox', { name: 'Session name' });
    await box.fill('');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(box).toBeHidden();
    await expect(row(page, 'Alpha notes')).toBeVisible();
  });

  test('delete a thread from its menu @G2.44', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(dialog.getByText('Delete session "Alpha notes"? This will terminate the process and delete all history.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(row(page, 'Alpha notes')).toHaveCount(0);
    await expect(row(page, 'Beta notes')).toBeVisible();
    await expect.poll(() => sessionNames(relay)).not.toContain('Alpha notes');
  });

  test('deleting an open thread closes its tab and shows Today @G2.44', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click();
    await expect(page.getByRole('tab', { name: 'Alpha notes' })).toBeVisible();
    await page.getByRole('tab', { name: 'Acme' }).click();
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('tab', { name: 'Alpha notes' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Acme' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  });

  test('Escape keeps the thread @G2.44.r1', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    const since = relay.mark();
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Alpha notes')).toBeVisible();
    await row(page, 'Alpha notes').click();
    await expectNoDeleteSince(page, relay, since);
  });

  test('cancel keeps the thread @G2.44.r1', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    const since = relay.mark();
    await row(page, 'Alpha notes').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Alpha notes')).toBeVisible();
    await row(page, 'Alpha notes').click();
    await expectNoDeleteSince(page, relay, since);
  });

  test('delete a thread by holding its tab close button @G2.47', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    const close = page.getByRole('button', { name: 'Close Alpha notes' });
    const box = await close.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const heading = page.getByRole('heading', { name: 'Confirm Deletion' });
    await expect(heading).toBeVisible();
    await page.mouse.up();
    await expect(page.getByText('Delete session "Alpha notes"? This will terminate the process and delete all history.')).toBeVisible();
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('tab', { name: 'Alpha notes' })).toHaveCount(0);
    await expect.poll(() => sessionNames(relay)).not.toContain('Alpha notes');
  });

  test('a quick click on the tab close button closes the tab only @G2.47', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await page.getByRole('button', { name: 'Close Alpha notes' }).click();
    await expect(page.getByRole('tab', { name: 'Alpha notes' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Confirm Deletion' })).toBeHidden();
    expect(await sessionNames(relay)).toContain('Alpha notes');
  });

  test('cancel keeps the tab @G2.47.r1', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await row(page, 'Alpha notes').click();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    const close = page.getByRole('button', { name: 'Close Alpha notes' });
    const box = await close.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const since = relay.mark();
    await page.mouse.down();
    await expect(page.getByRole('heading', { name: 'Confirm Deletion' })).toBeVisible();
    await page.mouse.up();
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm Deletion' })).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Alpha notes' })).toBeVisible();
    await expectNoDeleteSince(page, relay, since);
  });
});

test.describe('threads on a phone', () => {
  test.use({ world: withThreads(), ...profiles.phone });

  test('delete a thread by swiping its row @G2.45', async ({ eve, page, touch, relay }) => {
    await openProjectPageOnPhone(eve, page);
    await touch.swipe(row(page, 'Alpha notes'), { dx: -120, dy: 0 });
    await page.getByRole('button', { name: 'Delete Alpha notes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(dialog.getByText('Delete session "Alpha notes"? This will terminate the process and delete all history.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row(page, 'Alpha notes')).toHaveCount(0);
    await expect.poll(() => sessionNames(relay)).not.toContain('Alpha notes');
  });

  test('cancel keeps the swiped row @G2.45.r1', async ({ eve, page, touch, relay }) => {
    await openProjectPageOnPhone(eve, page);
    const since = relay.mark();
    await touch.swipe(row(page, 'Alpha notes'), { dx: -120, dy: 0 });
    await page.getByRole('button', { name: 'Delete Alpha notes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Deletion' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Alpha notes')).toBeVisible();
    // The swiped row stays open and a tap on it only closes it, so the thread opens from the Agents list.
    await page.getByRole('button', { name: 'Alpha notes', exact: true }).filter({ hasText: 'idle' }).click();
    await expectNoDeleteSince(page, relay, since);
  });

  test('open a thread menu with a long press @G2.46', async ({ eve, page, touch }) => {
    await openProjectPageOnPhone(eve, page);
    await touch.hold(row(page, 'Alpha notes'), { until: page.getByRole('menuitem', { name: 'Rename' }) });
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Move to folder…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  });
});

test.describe('thread folders', () => {
  test.use({ world: withThreads() });

  test('move a thread into an existing folder @G2.41', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('0');
    await moveTo(page, 'Alpha notes', 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('1');
    await expect(row(page, 'Alpha notes')).toBeVisible();
  });

  test('move a thread out of its folder to Ungrouped @G2.42', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await moveTo(page, 'Alpha notes', 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('1');
    await moveTo(page, 'Alpha notes', 'Ungrouped');
    await expect(folder(page, 'Ideas')).toContainText('0');
    await expect(folder(page, 'Ungrouped')).toContainText('2');
  });

  test('move a thread into a new folder @G2.43', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    const since = relay.mark();
    await moveTo(page, 'Alpha notes', 'New folder…');
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Plans');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(folder(page, 'Plans')).toContainText('1');
    await relay.waitForEvent('project.update', { since, match: (l) => l.status === 'ok' });
  });

  test('a failed save shows a toast and no folder @G2.43.r1', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await relay.ctl('fault', 'add', '--route', 'PUT /api/projects/{id}', '--mode', 'error', '--name', 'ERROR');
    await moveTo(page, 'Alpha notes', 'New folder…');
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Plans');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText("Couldn't save folder change")).toBeVisible();
    await expect(folder(page, 'Plans')).toHaveCount(0);
  });

  test('an empty folder name changes nothing @G2.43.r2', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await moveTo(page, 'Alpha notes', 'New folder…');
    const box = page.getByRole('textbox', { name: 'Folder name' });
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(box).toBeHidden();
    await expect(folder(page, 'Ungrouped')).toHaveCount(0);
    await expect(row(page, 'Alpha notes')).toBeVisible();
  });

  test('create a folder for threads @G2.48', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    const since = relay.mark();
    await makeFolder(page, 'Plans');
    await expect(folder(page, 'Plans')).toContainText('0');
    await relay.waitForEvent('project.update', { since, match: (l) => l.status === 'ok' });
  });

  test('a folder name that exists adds nothing @G2.48.r1', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const box = page.getByRole('textbox', { name: 'Folder name' });
    await box.fill('Ideas');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(box).toBeHidden();
    await expect(folder(page, 'Ideas')).toHaveCount(1);
  });

  test('a failed save of a new folder shows a toast @G2.48.r2', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await relay.ctl('fault', 'add', '--route', 'PUT /api/projects/{id}', '--mode', 'error', '--name', 'ERROR');
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Plans');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText("Couldn't save folder change")).toBeVisible();
    await expect(folder(page, 'Plans')).toHaveCount(0);
  });

  test('rename a folder @G2.49', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await moveTo(page, 'Alpha notes', 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('1');
    const since = relay.mark();
    await page.getByRole('button', { name: 'Folder actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename Folder' }).click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Drafts');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(folder(page, 'Drafts')).toContainText('1');
    await expect(folder(page, 'Ideas')).toHaveCount(0);
    await relay.waitForEvent('project.update', { since, match: (l) => l.status === 'ok' });
  });

  test('an unchanged folder name changes nothing @G2.49.r1', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await page.getByRole('button', { name: 'Folder actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename Folder' }).click();
    const box = page.getByRole('textbox', { name: 'Folder name' });
    await box.fill('Ideas');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(box).toBeHidden();
    await expect(folder(page, 'Ideas')).toBeVisible();
  });

  test('an empty folder name changes nothing @G2.49.r1', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await page.getByRole('button', { name: 'Folder actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename Folder' }).click();
    const box = page.getByRole('textbox', { name: 'Folder name' });
    await box.fill('');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(box).toBeHidden();
    await expect(folder(page, 'Ideas')).toBeVisible();
  });

  test('a failed folder rename shows a toast @G2.49.r2', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await relay.ctl('fault', 'add', '--route', 'PUT /api/projects/{id}', '--mode', 'error', '--name', 'ERROR');
    await page.getByRole('button', { name: 'Folder actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename Folder' }).click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Drafts');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByText("Couldn't save folder change")).toBeVisible();
    await expect(folder(page, 'Drafts')).toHaveCount(0);
  });

  test('delete a folder and keep its threads @G2.50', async ({ eve, page, relay }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await makeFolder(page, 'Plans');
    await moveTo(page, 'Alpha notes', 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('1');
    const since = relay.mark();
    await page.getByRole('button', { name: 'Folder actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Delete Folder' }).click();
    await expect(page.getByText(/^Delete folder "Ideas"\?/)).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(folder(page, 'Ideas')).toHaveCount(0);
    await expect(folder(page, 'Ungrouped')).toContainText('2');
    await expect(row(page, 'Alpha notes')).toBeVisible();
    await relay.waitForEvent('project.update', { since, match: (l) => l.status === 'ok' });
  });

  test('the folder delete dialog counts the threads that move @G2.50', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await moveTo(page, 'Alpha notes', 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('1');
    await page.getByRole('button', { name: 'Folder actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete Folder' }).click();
    await expect(page.getByText(/^Delete folder "Ideas"\? Its 1 session\(s\) move to Ungrouped/)).toBeVisible();
  });

  test('cancel keeps the folder @G2.50.r1', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await page.getByRole('button', { name: 'Folder actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete Folder' }).click();
    await expect(page.getByText(/^Delete folder "Ideas"\?/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(/^Delete folder "Ideas"\?/)).toBeHidden();
    await expect(folder(page, 'Ideas')).toBeVisible();
  });

  test('open a folder menu with a right-click @G2.51', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await folder(page, 'Ideas').getByRole('button', { name: 'Ideas', exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Rename Folder' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete Folder' })).toBeVisible();
  });

  test('collapse and open a folder @G2.52', async ({ eve, page }) => {
    await openProjectPage(eve, page);
    await makeFolder(page, 'Ideas');
    await moveTo(page, 'Alpha notes', 'Ideas');
    await expect(folder(page, 'Ideas')).toContainText('1');
    await folder(page, 'Ideas').getByRole('button', { name: 'Ideas', exact: true }).click();
    await expect(row(page, 'Alpha notes')).toBeHidden();
    await eve.reload();
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'Project page' }).click();
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
    await expect(row(page, 'Alpha notes')).toBeHidden();
    await folder(page, 'Ideas').getByRole('button', { name: 'Ideas', exact: true }).click();
    await expect(row(page, 'Alpha notes')).toBeVisible();
  });
});
