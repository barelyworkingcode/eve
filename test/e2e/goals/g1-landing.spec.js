// G1 · Get in and see my work. Home greets me, my projects are in the rail and
// on Home, no passkey prompt on a trusted network.
const { test, expect } = require('./fixture');

const GREETING = /^(Good morning\.|Good afternoon\.|Good evening\.|Working late\.)$/;

test.describe('G1 landing', () => {
  test('opens straight to Home: greeting, summary line, no auth screen, no terminal or chat open', async ({ page }) => {
    const home = page.getByTestId('home-screen');
    await expect(home.getByText(GREETING)).toBeVisible();
    await expect(page.locator('.home__subtitle')).toContainText('2 projects');
    await expect(page.locator('#authScreen, .auth-screen').first()).toBeHidden();
    await expect(page.locator('#terminal')).toBeHidden();
    await expect(page.locator('#chat')).toBeHidden();
    await expect(page).toHaveURL(/^[^#]*#?$/);
  });

  test('every project is a chip on Home and an entry in the rail', async ({ page }) => {
    for (const [id, name] of [['alpha', 'Alpha Project'], ['beta', 'Beta Project']]) {
      await expect(page.getByTestId(`home-project-${id}`)).toContainText(name);
      await expect(page.getByRole('navigation', { name: 'Projects' }).getByTitle(name, { exact: true })).toBeVisible();
    }
  });

  test('Start offers Chat and Voice, and Continue says nothing yet with no sessions', async ({ page }) => {
    await expect(page.getByTestId('home-tile-chat')).toBeVisible();
    await expect(page.getByTestId('home-tile-voice')).toBeVisible();
    await expect(page.locator('.home__empty')).toHaveText('Nothing yet. Start a session above and it will show up here.');
  });

  test('picking a project in the rail opens its panel', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true }).click();
    await expect(page.locator('#panelTitle')).toHaveText('Beta Project');
  });
});

test.describe('G1 with no projects', () => {
  test.use({ world: { projects: [] } });
  test('Home offers to create the first project', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Start with a project' })).toBeVisible();
    await expect(page.getByTestId('home-new-project')).toHaveText('Create a project');
  });
});
