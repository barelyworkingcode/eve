// S1-A4 Home | Work. A project is visible in a mode when its mode is that mode
// or `both` (missing means both). docs/design-today-s1.md
const os = require('os');
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');
const { nav } = require('./today-helpers');

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const world = {
  projects: ({ alpha, beta }) => [
    { id: 'wk', name: 'Work Only', path: alpha, mode: 'work' },
    { id: 'hm', name: 'Home Only', path: beta, mode: 'home' },
    { id: 'bt', name: 'Both Room', path: os.tmpdir(), mode: 'both' },
    { id: 'nm', name: 'No Mode', path: os.tmpdir() },
  ],
  seed: ({ relay, folders }) => {
    relay.seedSession({ sessionId: 's-wk', projectId: 'wk', directory: folders.alpha, model: 'fake-model', name: 'Quarterly numbers', live: false, createdAt: iso(3 * HOUR), lastMessageAt: iso(2 * HOUR), messageCount: 1 });
    relay.seedSession({ sessionId: 's-hm', projectId: 'hm', directory: folders.beta, model: 'fake-model', name: 'Garden plans', live: false, createdAt: iso(3 * HOUR), lastMessageAt: iso(2 * HOUR), messageCount: 1 });
  },
};

const chip = (page, id) => page.getByTestId(`home-project-${id}`);
const railItem = (page, name) => nav(page).getByTitle(name, { exact: true });

test.describe('S1-A4 Home | Work', () => {
  test.use({ world });

  test('opens in Work: Work and both-mode projects (and one with no mode) are shown, Home-only is not', async ({ page }) => {
    await expect(page.getByTestId('mode-switch')).toBeVisible();
    await expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'true');
    await expect(chip(page, 'wk')).toBeVisible();
    await expect(chip(page, 'bt')).toBeVisible();
    await expect(chip(page, 'nm')).toBeVisible();
    await expect(chip(page, 'hm')).toHaveCount(0);
    await expect(railItem(page, 'Work Only')).toBeVisible();
    await expect(railItem(page, 'Home Only')).toHaveCount(0);
    await expect(page.locator('.home__subtitle')).toContainText('3 projects');
  });

  test('switching to Home swaps them everywhere on Today: chips, Continue, rail', async ({ page }) => {
    await expect(page.getByTestId('home-session-s-wk')).toBeVisible();
    await page.getByTestId('mode-home').click();
    await expect(page.getByTestId('mode-home')).toHaveAttribute('aria-checked', 'true');
    await expect(chip(page, 'hm')).toBeVisible();
    await expect(chip(page, 'bt')).toBeVisible();
    await expect(chip(page, 'wk')).toHaveCount(0);
    await expect(page.getByTestId('home-session-s-hm')).toBeVisible();
    await expect(page.getByTestId('home-session-s-wk')).toHaveCount(0);
    await expect(railItem(page, 'Home Only')).toBeVisible();
    await expect(railItem(page, 'Work Only')).toHaveCount(0);
  });

  test('the choice survives a reload', async ({ page }) => {
    await page.getByTestId('mode-home').click();
    await reloadEve(page);
    await expect(page.getByTestId('mode-home')).toHaveAttribute('aria-checked', 'true');
    await expect(chip(page, 'hm')).toBeVisible();
    await expect(chip(page, 'wk')).toHaveCount(0);
  });

  test('⌘K offers only the mode\'s projects and their threads', async ({ page }) => {
    await page.waitForFunction(() => window.client.state.sessions.size > 0);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('Only');
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Work Only' }).first()).toBeVisible();
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Home Only' })).toHaveCount(0);
    await page.getByTestId('palette-input').fill('Garden');
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Garden plans' })).toHaveCount(0);
    await page.getByTestId('palette-input').fill('Quarterly');
    await expect(page.getByTestId('palette-item').filter({ hasText: 'Quarterly numbers' })).toBeVisible();
  });

  test('switching mode closes no tab, and lands on Today when the new mode has none for the active project', async ({ page }) => {
    await railItem(page, 'Work Only').click();
    await page.getByTestId('panel-tab-files').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-wk:/README.md')).toBeVisible();
    await page.getByTestId('mode-home').click();
    await expect(page.getByTestId('home-screen')).toBeVisible();
    expect(await page.evaluate(() => window.client.tabManager.tabs.length)).toBe(1);
    await page.getByTestId('mode-work').click();
    await railItem(page, 'Work Only').click();
    await expect(page.getByTestId('tab-wk:/README.md')).toBeVisible();
  });
});

test.describe('S1-A4 no project in the mode', () => {
  test.use({ world: { projects: ({ beta }) => [{ id: 'hm', name: 'Home Only', path: beta, mode: 'home' }] } });

  test('Work says so and offers Home; it is not first-run', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Start with a project' })).toHaveCount(0);
    await expect(page.getByTestId('today-empty-mode')).toContainText('No projects in Work yet');
    await page.getByTestId('today-empty-mode').getByRole('button', { name: /Home/ }).click();
    await expect(page.getByTestId('home-project-hm')).toBeVisible();
  });
});
