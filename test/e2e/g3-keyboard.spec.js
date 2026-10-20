const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function withThreads() {
  const w = worlds.base();
  const mk = (id, name) => ({
    id,
    project_id: 'p_acme',
    name,
    model: 'sonnet',
    state: 'idle',
    messages: [{ role: 'user', text: `hello ${name}` }, { role: 'assistant', text: `echo: hello ${name}` }],
  });
  w.sessions = [mk('s_alpha', 'Alpha notes'), mk('s_beta', 'Beta notes'), mk('s_gamma', 'Gamma notes')];
  return w;
}

async function isFocused(locator) {
  try {
    await expect(locator).toBeFocused({ timeout: 100 });
    return true;
  } catch {
    return false;
  }
}

// A bounded Tab walk: at most 80 presses, stops on the target, fails otherwise.
async function tabTo(page, target) {
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press('Tab');
    if (await isFocused(target)) return;
  }
  await expect(target).toBeFocused();
}

const list = (page) => page.getByRole('list', { name: 'Threads' });
const entry = (page, name) => list(page).getByRole('button', { name, exact: true });
const folderActions = (page) => list(page).getByRole('button', { name: 'Folder actions', exact: true });
const deleteButton = (page, name) => page.getByRole('button', { name: `Delete ${name}`, exact: true });
const confirm = (page) => page.getByRole('dialog', { name: 'Confirm Deletion' });
const folderHeader = (page, name) => page.getByText(new RegExp(`^${name}\\s*\\d+$`));

async function sessionNames(relay) {
  const state = await relay.json('ctl', 'state', '--json');
  return state.sessions.map((s) => s.name);
}

// Setup, by mouse: the Project page with folder Ideas holding Alpha and Beta, and Gamma ungrouped.
async function openProjectPageWithFolder(eve, page) {
  await eve.open('/');
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Ideas');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(folderHeader(page, 'Ideas')).toBeVisible();
  for (const name of ['Alpha notes', 'Beta notes']) {
    await page.getByRole('button', { name, exact: true }).filter({ hasText: 'sonnet' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
    await page.getByRole('menuitem', { name: 'Ideas' }).click();
    await expect(folderHeader(page, 'Ideas')).toContainText(name === 'Alpha notes' ? '1' : '2');
  }
  await expect(entry(page, 'Gamma notes')).toBeVisible();
  // A fresh load, so the list is rendered once from the saved folders.
  await eve.reload();
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(entry(page, 'Ideas')).toBeVisible();
  await expect(entry(page, 'Gamma notes')).toBeVisible();
}

// Starts a walk at the New folder button and stops on the first row, the folder name.
async function reachList(page) {
  await page.getByRole('button', { name: 'New folder', exact: true }).focus();
  await tabTo(page, entry(page, 'Ideas'));
}

test.describe('Threads list keyboard', () => {
  test.use({ world: withThreads() });

  test('Tab enters the list and one more Tab leaves it @G3.20', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('Tab');
    // Focus is outside list "Threads": no button in it (rows, Folder actions, Delete) has it.
    for (const el of await list(page).getByRole('button').all()) {
      await expect(el).not.toBeFocused();
    }
  });

  test('Down, Up, Home and End move between folder names and thread rows @G3.20', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Beta notes')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Ungrouped')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Gamma notes')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(entry(page, 'Ungrouped')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(entry(page, 'Beta notes')).toBeFocused();
    await page.keyboard.press('End');
    await expect(entry(page, 'Gamma notes')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(entry(page, 'Ideas')).toBeFocused();
  });

  test('Return on a folder name closes and opens it with focus kept @G3.20', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await expect(entry(page, 'Ideas')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(entry(page, 'Ideas')).toHaveAttribute('aria-expanded', 'false');
    await expect(entry(page, 'Alpha notes')).toHaveCount(0);
    await expect(entry(page, 'Ideas')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(entry(page, 'Ideas')).toHaveAttribute('aria-expanded', 'true');
    await expect(entry(page, 'Alpha notes')).toBeVisible();
    await expect(entry(page, 'Ideas')).toBeFocused();
  });

  test('Return on a thread opens its tab @G3.20', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Alpha notes', exact: true })).toHaveAttribute('aria-selected', 'true');
  });

  test('Right and Left move between a thread row and its Delete button @G2.56', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(deleteButton(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(entry(page, 'Alpha notes')).toBeFocused();
  });

  test('delete a thread from the keyboard and focus moves to the next row @G2.56', async ({ eve, page, relay }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(deleteButton(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirm(page)).toBeVisible();
    await expect(confirm(page).getByText('Delete session "Alpha notes"? This will terminate the process and delete all history.')).toBeVisible();
    await expect(confirm(page).getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirm(page)).toBeHidden();
    await expect(entry(page, 'Alpha notes')).toHaveCount(0);
    await expect(entry(page, 'Beta notes')).toBeFocused();
    await expect.poll(() => sessionNames(relay)).not.toContain('Alpha notes');
  });

  test('Escape on the delete dialog keeps the thread and refocuses its Delete button @G2.56.r1', async ({ eve, page, relay }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(deleteButton(page, 'Alpha notes')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirm(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm(page)).toBeHidden();
    await expect(deleteButton(page, 'Alpha notes')).toBeFocused();
    await expect(entry(page, 'Alpha notes')).toBeVisible();
    // Read after the focus signal above: relay still lists the thread and logged no delete.
    expect(await sessionNames(relay)).toContain('Alpha notes');
    expect(await relay.logs({ event: 'session.delete' })).toHaveLength(0);
  });

  test('Right on a folder name opens the Folder actions menu from the keyboard @G2.57', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowRight');
    await expect(folderActions(page)).toBeFocused();
    await expect(folderActions(page)).toBeVisible();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rename Folder', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Delete Folder', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitem', { name: 'Rename Folder', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Delete Folder', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitem', { name: 'Rename Folder', exact: true })).toBeFocused();
  });

  test('Escape closes the Folder actions menu and refocuses its button @G2.57.r1', async ({ eve, page }) => {
    await openProjectPageWithFolder(eve, page);
    await reachList(page);
    await page.keyboard.press('ArrowRight');
    await expect(folderActions(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Rename Folder', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(folderActions(page)).toBeFocused();
  });
});
