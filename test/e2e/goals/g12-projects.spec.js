// G12 · Set up and tune a project. A new project appears in the rail and on
// Home; edits reach relay; relay's refusals are shown, not swallowed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('./fixture');

const isPost = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/projects';

test.describe('G12 projects', () => {
  test('Home\'s New project chip creates a project that then shows in the rail and on Home', async ({ page, eve }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-goal-new-'));
    try {
      await page.getByTestId('home-new-project').click();
      await page.getByTestId('project-name').fill('Gamma Project');
      await page.getByTestId('project-path').fill(dir);
      const [request] = await Promise.all([
        page.waitForRequest(isPost),
        page.getByTestId('project-save').click(),
      ]);
      expect(request.postDataJSON()).toMatchObject({ name: 'Gamma Project', path: dir });
      await expect(page.getByRole('navigation', { name: 'Projects' }).getByTitle('Gamma Project', { exact: true })).toBeVisible();
      await expect(page.getByTestId(/home-project-/).filter({ hasText: 'Gamma Project' })).toBeVisible();
      await expect(page.locator('.home__subtitle')).toContainText('3 projects');
      expect(Object.values(eve.relay.listProjects()).map((p) => p.name)).toContain('Gamma Project');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a relative path is refused by relay and the dialog says why', async ({ page }) => {
    await page.getByTestId('home-new-project').click();
    await page.getByTestId('project-name').fill('Bad path');
    await page.getByTestId('project-path').fill('relative/dir');
    await page.getByTestId('project-save').click();
    await expect(page.getByText(/must be an absolute path/)).toBeVisible();
    await expect(page.getByTestId('project-save')).toBeVisible(); // still open
  });

  test('Edit Project renames it at relay and everywhere it is shown', async ({ page, eve }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true }).click();
    await page.getByTestId('sidebar-project-more-beta').click();
    await page.getByText('Edit Project', { exact: true }).click();
    await expect(page.getByTestId('project-name')).toHaveValue('Beta Project');
    await page.getByTestId('project-name').fill('Beta Renamed');
    await page.getByTestId('project-save').click();
    await expect.poll(() => eve.relay.getProject('beta').name).toBe('Beta Renamed');
    await expect(page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Renamed', { exact: true })).toBeVisible();
    await expect(page.getByTestId('home-project-beta')).toContainText('Beta Renamed');
  });

  test('Delete Project asks twice (a native confirm, then the modal with what is lost), then removes it everywhere', async ({ page, eve }) => {
    eve.relay.seedSession({ sessionId: 's-b', projectId: 'beta', directory: eve.folders.beta, model: 'm', name: 'keep?', live: false });
    eve.relay.seedTask({
      id: 'tb', name: 'T', projectId: 'beta', prompt: 'p', model: 'm', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
    await page.reload();
    await page.waitForFunction(() => window.client.state.sessions.size > 0 && window.client.state.tasks.size > 0);
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true }).click();
    await page.getByTestId('sidebar-project-more-beta').click();
    const native = new Promise((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
    await page.getByText('Delete Project', { exact: true }).click();
    expect(await native).toBe('Delete project "Beta Project"? This cannot be undone.');

    await expect(page.locator('#confirmMessage')).toHaveText("Delete 'Beta Project'? 1 session(s) will become ungrouped, 1 task(s) will be deleted.");
    expect(eve.relay.getProject('beta')).toBeDefined(); // nothing is deleted before the second answer
    await page.locator('#confirmDelete').click();

    await expect.poll(() => eve.relay.getProject('beta')).toBeUndefined();
    expect(eve.relay.listTasks()).toHaveLength(0); // its tasks go with it (DELETE /api/tasks/by-project)
    await expect(page.getByTestId('home-project-beta')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true })).toHaveCount(0);
    await expect(page.locator('.home__subtitle')).toContainText('1 project');
  });
});
