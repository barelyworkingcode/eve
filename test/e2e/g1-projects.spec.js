const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

function twoProjects() {
  const w = worlds.base();
  w.projects.push({ id: 'p_beta', name: 'Beta', mode: 'work', files: { 'NOTES.md': '# Beta\n' } });
  return w;
}

function homeOnly() {
  const w = worlds.base();
  w.projects = [{ id: 'p_home', name: 'Hearth', mode: 'home', files: { 'README.md': '# Hearth\n' } }];
  w.default_project = {};
  return w;
}

function empty() {
  const w = worlds.base();
  w.projects = [];
  w.default_project = {};
  return w;
}

async function today(page) {
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
}

test.describe('two work projects', () => {
  test.use({ world: twoProjects() });

  test('pick a project from the chips @G1.27', async ({ eve, page }) => {
    await eve.open('/');
    await today(page);
    await page.getByRole('button', { name: /Beta/ }).last().click();
    await expect(page.getByText('Beta', { exact: true }).first()).toBeVisible();
  });

  test('pick a project in the Rail @G1.33', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Beta' }).click();
    await expect(page.getByText('Beta', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'NOTES.md' })).toBeVisible();
  });

  test('scope eve to one project by its address @G1.37', async ({ eve, page }) => {
    await eve.open('/beta/');
    const rail = page.getByRole('navigation', { name: 'Projects' });
    await expect(rail.getByRole('button', { name: 'Beta' })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Acme' })).toBeHidden();
    await expect(page).toHaveURL(/\/beta\/$/);
  });

  test('an unknown slug keeps every project @G1.37.r1', async ({ eve, page }) => {
    await eve.open('/nothing-here/');
    await expect(page.getByText(/^No project matches/)).toBeVisible();
    const rail = page.getByRole('navigation', { name: 'Projects' });
    await expect(rail.getByRole('button', { name: 'Acme' })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Beta' })).toBeVisible();
  });
});

test('open the Project page from the panel @G1.34', async ({ eve, page }) => {
  await eve.open('/');
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  for (const name of ['Agents', 'Threads', 'Routines']) {
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
});

test('edit the project from the panel menu @G1.36', async ({ eve, page }) => {
  await eve.open('/');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Project' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();
});

test('start a new project from the New project chip @G1.28', async ({ eve, page }) => {
  await eve.open('/');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
});

test('switch the app between Home and Work @G1.31 @G1.32', async ({ eve, page }) => {
  await eve.open('/');
  await expect(page.getByRole('radio', { name: 'Work' })).toBeChecked();
  await page.getByRole('radio', { name: 'Home' }).check();
  await expect(page.getByRole('radio', { name: 'Home' })).toBeChecked();
  await expect(page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' })).toBeHidden();
  await page.getByRole('radio', { name: 'Work' }).check();
  await expect(page.getByRole('radio', { name: 'Work' })).toBeChecked();
  await expect(page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' })).toBeVisible();
});

test.describe('only a Home project', () => {
  test.use({ world: homeOnly() });

  test('Return in Ask says there is no project; switch to Home @G1.8 @G1.30', async ({ eve, page }) => {
    await eve.open('/');
    const ask = page.getByRole('textbox', { name: 'Ask' });
    await ask.fill('hello from testbox');
    await ask.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'No projects in Work yet.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
    await expect(ask).toHaveValue('hello from testbox');

    await page.getByRole('button', { name: 'Switch to Home' }).click();
    await expect(page.getByRole('radio', { name: 'Home' })).toBeChecked();
    await expect(page.getByText('No projects in Work yet.')).toBeHidden();
    await expect(page.getByRole('button', { name: /Hearth/ }).first()).toBeVisible();
  });
});

test.describe('no project at all', () => {
  test.use({ world: empty() });

  test('create the first project @G1.29', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByText('Start with a project')).toBeVisible();
    await page.getByRole('button', { name: 'Create a project' }).click();
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
  });
});
