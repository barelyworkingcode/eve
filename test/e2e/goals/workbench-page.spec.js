// S5a project page and its doors (docs/design-workbench.md, S5a-A1 and A5).
// The thread and task lists themselves are asserted through this door in
// g3-reopen-thread and g5-tasks.
const { test, expect, MODELS } = require('./fixture');
const { gotoEve } = require('../fixtures');

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
const rail = (page, name) => page.getByRole('navigation', { name: 'Projects' }).getByTitle(name, { exact: true });
const projectTabs = (page) => page.locator('[data-testid^="tab-project:"]');

const world = {
  projects: ({ alpha, beta }) => [
    { id: 'alpha', name: 'Alpha Project', path: alpha, session_folders: ['Bugs'] },
    { id: 'beta', name: 'Beta Project', path: beta },
  ],
  seed: ({ relay, folders }) => {
    relay.setModels(MODELS);
    const thread = (sessionId, name, folder) => relay.seedSession({
      sessionId, projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name, folder,
      live: false, createdAt: iso(3), lastMessageAt: iso(2), messageCount: 1,
    });
    thread('s-bug', 'Fix the crash', 'Bugs');
    thread('s-loose', 'Loose ends');
    relay.seedTask({
      id: 't1', name: 'Digest', projectId: 'alpha', prompt: 'p', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
  },
};

// A cold load with the hash, not a hashchange in the already-open page.
async function freshLoad(page, eve, hash) {
  await page.goto('about:blank');
  await gotoEve(page, new URL(hash, eve.baseUrl).href);
}

async function openAlphaPage(page) {
  await rail(page, 'Alpha Project').click();
  await page.getByTestId('panel-project-page').click();
  await expect(page.getByTestId('project-page-alpha')).toBeVisible();
}

test.describe('S5a-A1 project page', () => {
  test.use({ world });

  test('the panel button opens #project/alpha with header, sections and counts; again gives one tab', async ({ page, eve }) => {
    await openAlphaPage(page);
    await expect(page).toHaveURL(/#project\/alpha$/);
    const pg = page.getByTestId('project-page-alpha');
    await expect(pg.getByRole('heading', { level: 1 })).toHaveText('Alpha Project');
    await expect(pg).toContainText('this Mac');
    await expect(pg).toContainText(eve.folders.alpha);
    await expect(pg.getByRole('heading', { level: 2 })).toHaveText(['Agents', 'Threads', 'Routines']);
    await expect(page.getByTestId('project-threads-count')).toHaveText('2');
    await expect(page.getByTestId('project-tasks-count')).toHaveText('1');

    await page.getByTestId('panel-project-page').click();
    await expect(projectTabs(page)).toHaveCount(1);
  });

  test('the page tab is not persisted: a reload without the hash does not reopen it', async ({ page, eve }) => {
    await openAlphaPage(page);
    await expect(projectTabs(page)).toHaveCount(1);
    expect(await page.evaluate(() => Object.values(localStorage).filter((v) => v.includes('project:alpha')).length)).toBe(0);
    await freshLoad(page, eve, '/');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(projectTabs(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.client.tabManager.tabs.filter((t) => t.id.startsWith('project:')).length)).toBe(0);
  });

  test('a mode switch keeps the page tab open (S1-A4)', async ({ page }) => {
    await openAlphaPage(page);
    const tabCount = () => page.evaluate(() => window.client.tabManager.tabs.filter((t) => t.id.startsWith('project:')).length);
    expect(await tabCount()).toBe(1);
    await page.getByTestId('mode-home').click();
    await page.getByTestId('mode-work').click();
    expect(await tabCount()).toBe(1);
    await expect(projectTabs(page)).toHaveCount(1);
  });

  test('New thread opens the launcher', async ({ page }) => {
    await openAlphaPage(page);
    await page.getByTestId('project-new-thread-alpha').click();
    await expect(page.getByTestId('dialog-shell-launcher-dialog')).toBeVisible();
  });

  for (const [row, other] of [['files', 'changes'], ['changes', 'files']]) {
    test(`the ${row} row opens the panel on that tab`, async ({ page }) => {
      await rail(page, 'Alpha Project').click();
      await page.getByTestId(`panel-tab-${other}`).click();
      await page.getByTestId('panel-project-page').click();
      await page.getByTestId(`project-${row}-alpha`).click();
      await expect(page.getByTestId(`panel-tab-${row}`)).toHaveClass(/panel-tab--active/);
    });
  }

  test('the deep link #project/alpha opens the page on load', async ({ page, eve }) => {
    await freshLoad(page, eve, '#project/alpha');
    await expect(page.getByTestId('project-page-alpha').getByRole('heading', { level: 1 })).toHaveText('Alpha Project');
  });

  test('the deep link #project/nope says "Project not found." and opens nothing', async ({ page, eve }) => {
    await freshLoad(page, eve, '#project/nope');
    await expect(page.locator('.toast__message', { hasText: 'Project not found.' })).toBeVisible();
    await expect(projectTabs(page)).toHaveCount(0);
  });

  test('a folder\'s menu deletes the folder and moves its thread to Ungrouped', async ({ page, eve }) => {
    await openAlphaPage(page);
    const folder = page.getByTestId('project-folder-alpha-Bugs');
    await folder.getByTitle('Folder actions').click();
    await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Delete Folder' }).click();
    await expect(page.locator('#confirmMessage')).toContainText('Delete folder "Bugs"?');
    await page.getByTestId('modal-confirm-delete').click();
    await expect.poll(() => eve.relay.getProject('alpha').session_folders).toEqual([]);
    await expect.poll(() => eve.relay.inbound.filter((m) => m.type === 'set_session_folder'))
      .toEqual([expect.objectContaining({ sessionId: 's-bug', folder: '' })]);
    await expect(folder).toHaveCount(0);
  });

  test('a thread\'s menu deletes it after the confirmation', async ({ page, eve }) => {
    await openAlphaPage(page);
    await page.getByTestId('project-thread-s-loose').click({ button: 'right' });
    await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByTestId('modal-confirm-delete').click();
    await expect.poll(() => eve.relay.inbound.filter((m) => m.type === 'delete_session').map((m) => m.sessionId))
      .toEqual(['s-loose']);
  });
});

test.describe('S5a-A5 the bottom bar\'s Threads at 390', () => {
  test.use({ world, viewport: { width: 390, height: 844 }, hasTouch: true });

  test('pushes the first in-mode project\'s page when none was chosen', async ({ page }) => {
    await page.getByTestId('nav-threads').click();
    await expect(page.getByTestId('project-page-alpha')).toBeVisible();
    await expect(page).toHaveURL(/#project\/alpha$/);
    await expect(page.getByTestId('nav-back')).toBeVisible();
  });

  test('pushes the active project\'s page', async ({ page }) => {
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('sidebar-project-beta').click();
    await page.getByTestId('panel-project-page').click();
    await expect(page.getByTestId('project-page-beta')).toBeVisible();
    await page.getByTestId('nav-back').click();
    await expect(page.getByTestId('home-screen')).toBeVisible();

    await page.getByTestId('nav-threads').click();
    await expect(page.getByTestId('project-page-beta')).toBeVisible();
    await expect(page).toHaveURL(/#project\/beta$/);
  });

  test.describe('with no project in the mode', () => {
    test.use({ world: { projects: ({ beta }) => [{ id: 'hm', name: 'Home Only', path: beta, mode: 'home' }] } });

    test('opens the sheet', async ({ page }) => {
      await page.getByTestId('nav-threads').click();
      await expect(page.locator('#sidebarRail')).toBeInViewport();
      await expect(page.locator('[data-testid^="project-page-"]')).toHaveCount(0);
    });
  });
});
