// G12 · Set up and tune a project. A new project appears in the rail and on
// Home; edits reach relay; relay's refusals are shown, not swallowed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, MODELS } = require('./fixture');
const { reloadEve } = require('../fixtures');

const ADMIN_KEYS = ['allowed_models', 'allowed_mcp_ids', 'permission_policy'];
const isPost = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/projects';

test.describe('G12 projects', () => {
  test('Home\'s New project chip creates a project that then shows in the rail and on Home', async ({ page, eve }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-goal-new-'));
    try {
      await page.getByTestId('home-new-project').click();
      await page.getByTestId('project-name').fill('Gamma Project');
      await page.getByTestId('project-path').fill(dir);
      // SX-A12: a new project starts at Both and create always sends mode; SX-A10: no admin keys.
      await expect(page.getByTestId('project-mode-both')).toHaveAttribute('aria-pressed', 'true');
      const [request] = await Promise.all([
        page.waitForRequest(isPost),
        page.getByTestId('project-save').click(),
      ]);
      expect(request.postDataJSON()).toMatchObject({ name: 'Gamma Project', path: dir, mode: 'both' });
      for (const key of ADMIN_KEYS) expect(request.postDataJSON()).not.toHaveProperty(key);
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
    await reloadEve(page);
    await page.waitForFunction(() => window.client.state.sessions.size > 0 && window.client.state.tasks.size > 0);
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true }).click();
    await page.getByTestId('sidebar-project-more-beta').click();
    const native = new Promise((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
    await page.getByText('Delete Project', { exact: true }).click();
    expect(await native).toBe('Delete project "Beta Project"? This cannot be undone.');

    await expect(page.locator('#confirmMessage')).toHaveText("Delete 'Beta Project'? 1 session(s) will become ungrouped, 1 routine(s) will be deleted.");
    expect(eve.relay.getProject('beta')).toBeDefined(); // nothing is deleted before the second answer
    await page.locator('#confirmDelete').click();

    await expect.poll(() => eve.relay.getProject('beta')).toBeUndefined();
    expect(eve.relay.listTasks()).toHaveLength(0); // its tasks go with it (DELETE /api/tasks/by-project)
    await expect(page.getByTestId('home-project-beta')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true })).toHaveCount(0);
    // Singular: "1 project", not "1 projects" (which a substring match would accept).
    await expect(page.locator('.home__subtitle')).toContainText(/\b1 project · /);
  });
});

const isPut = (id) => (r) => r.method() === 'PUT' && new URL(r.url()).pathname === `/api/projects/${id}`;
const railItem = (page, name) => page.getByRole('navigation', { name: 'Projects' }).getByTitle(name, { exact: true });

// ⌘K's project row for a name: 1 when the palette lists it, else 0.
async function paletteProjectCount(page, name) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  const items = page.getByTestId('palette-item');
  await expect(items.filter({ hasText: 'New project' })).toHaveCount(1);
  const count = await items.filter({ hasText: name }).filter({ hasText: /\d+ sessions?/ }).count();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette-input')).toBeHidden();
  return count;
}

async function editProject(page, name, id) {
  await railItem(page, name).click();
  await page.getByTestId(`sidebar-project-more-${id}`).click();
  await page.getByText('Edit Project', { exact: true }).click();
  await expect(page.getByTestId('project-name')).toHaveValue(name);
}

// SX-A9..A11, A13, A14: models, MCPs, policy and hosts are Relay's; the dialog shows models read-only.
const POLICY = { default: 'ask' };
test.describe('G12 a project with an allow-list of models', () => {
  test.use({
    world: {
      hosts: [{ id: 'h1', name: 'Acme box' }],
      seed: ({ relay }) => {
        relay.setModels({ ...MODELS, models: [...MODELS.models, { value: 'acme-model', label: 'Acme Model', provider: 'claude' }] });
        Object.assign(relay.getProject('beta'), { allowed_models: ['fake-model', 'retired-model'], allowed_mcp_ids: ['acme-mcp'], permission_policy: POLICY });
        relay.getProject('alpha').allowed_models = ['*'];
      },
    },
  });

  // Flipped by SX-A9/A10: was an editable "Fake Model" checkbox and a PUT that echoed allowed_models.
  test('Edit Project lists allowed models read-only, and a save sends no admin keys and no unchanged mode', async ({ page, eve }) => {
    await editProject(page, 'Beta Project', 'beta');
    await expect(page.getByTestId('project-allowed-models')).toHaveText('Fake Model, retired-model');
    await expect(page.getByTestId('project-relay-pointer')).toHaveText('Set in Relay Settings on your Mac.');
    await expect(page.getByTestId('dialog-project-dialog').getByRole('checkbox')).toHaveCount(0);
    const [request] = await Promise.all([page.waitForRequest(isPut('beta')), page.getByTestId('project-save').click()]);
    expect(request.postDataJSON()).toMatchObject({ name: 'Beta Project', path: eve.folders.beta });
    for (const key of [...ADMIN_KEYS, 'mode']) expect(request.postDataJSON()).not.toHaveProperty(key);
    await expect(page.getByTestId('project-save')).toBeHidden();
    const beta = eve.relay.getProject('beta');
    expect([beta.allowed_models, beta.allowed_mcp_ids, beta.permission_policy]).toEqual([['fake-model', 'retired-model'], ['acme-mcp'], POLICY]);
  });

  test('a wildcard allow-list reads All models', async ({ page }) => {
    await editProject(page, 'Alpha Project', 'alpha');
    await expect(page.getByTestId('project-allowed-models')).toHaveText('All models');
  });

  test('the menu has no Regenerate Skills; the dialog is General | Templates with no host admin', async ({ page }) => {
    await railItem(page, 'Beta Project').click();
    await page.getByTestId('sidebar-project-more-beta').click();
    await expect(page.getByText('Edit Project', { exact: true })).toBeVisible();
    await expect(page.getByText('Regenerate Skills')).toHaveCount(0);
    await page.getByText('Edit Project', { exact: true }).click();
    const dialog = page.getByTestId('dialog-project-dialog');
    expect(await dialog.locator('.dialog__tab').allTextContents()).toEqual(['General', 'Templates']);
    await expect(dialog.getByTestId('project-where-local')).toBeVisible();
    await dialog.getByTestId('project-where-host-h1').click();
    await expect(dialog.getByTestId('project-where-add-host')).toHaveCount(0);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByText(/Host…|Allowed MCPs|Probe again|Remove host|hasn’t been checked/)).toHaveCount(0);
  });

  test('the launcher offers only the project\'s allowed models', async ({ page }) => {
    await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(2);
    await railItem(page, 'Beta Project').click();
    await page.getByTestId('sidebar-new-session-beta').click();
    await page.getByTestId('shell-card-web-chat').click();
    const values = await page.getByTestId('launcher-model-select').locator('option').evaluateAll((os) => os.map((o) => o.value));
    expect(values).toContain('fake-model');
    expect(values).not.toContain('acme-model');
  });
});

// SX-A12: the dialog's Home | Work | Both control.
test.describe('G12 a Work project', () => {
  test.use({
    world: {
      projects: ({ alpha, beta }) => [
        { id: 'alpha', name: 'Alpha Project', path: alpha },
        { id: 'beta', name: 'Beta Project', path: beta, mode: 'work' },
      ],
    },
  });

  test('moving it to Home sends only that mode; it leaves Work and shows in Home with no reload', async ({ page, eve }) => {
    await editProject(page, 'Beta Project', 'beta');
    await expect(page.getByTestId('project-mode-work')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('project-mode-home').click();
    const [request] = await Promise.all([page.waitForRequest(isPut('beta')), page.getByTestId('project-save').click()]);
    expect(request.postDataJSON().mode).toBe('home');
    await expect.poll(() => eve.relay.getProject('beta').mode).toBe('home');
    await expect(railItem(page, 'Beta Project')).toHaveCount(0);
    expect(await paletteProjectCount(page, 'Alpha Project')).toBe(1);
    expect(await paletteProjectCount(page, 'Beta Project')).toBe(0);
    await page.getByTestId('mode-home').click();
    await expect(railItem(page, 'Beta Project')).toBeVisible();
    await expect(page.getByTestId('home-project-beta')).toBeVisible();
    expect(await paletteProjectCount(page, 'Beta Project')).toBe(1);
  });
});
