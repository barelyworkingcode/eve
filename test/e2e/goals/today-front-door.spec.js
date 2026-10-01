// S1-A1 opens to Today with Ask focused; S1-A2 nothing opens by itself.
// docs/design-today-s1.md
const { test, expect } = require('./fixture');
const { nav } = require('./today-helpers');

test.describe('S1-A1 opens to Today', () => {
  test('Today shows, the Ask box has focus, and no session was created or message sent', async ({ page, eve }) => {
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.getByTestId('today-ask-input')).toBeFocused();
    expect(eve.relay.sessionCreates).toHaveLength(0);
    expect(eve.relay.inbound.filter((m) => m.type === 'send_message' || m.type === 'user_input')).toHaveLength(0);
  });

  test('typing needs no click', async ({ page }) => {
    await page.keyboard.type('hello');
    await expect(page.getByTestId('today-ask-input')).toHaveValue('hello');
  });
});

test.describe('S1-A2 a terminal relay already holds does not open itself', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        relay.setTerminalTemplates([{ id: 'shell', name: 'Shell', description: 'Plain shell', sandbox: true }]);
        relay.seedTerminal({ terminalId: 't-old', templateId: 'shell', name: 'shell', directory: folders.alpha });
      },
    },
  });

  test('at load: no tab, no terminal, Today stays', async ({ page }) => {
    await page.waitForFunction(() => window.client.terminalManager?.allTerminals?.has('t-old'));
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.locator('#terminal')).toBeHidden();
    expect(await page.evaluate(() => window.client.tabManager.tabs.length)).toBe(0);
    expect(await page.evaluate(() => window.client.terminalManager.terminals.size)).toBe(0);
  });

  test('it is listed and counted in the project\'s Sessions panel, and a click opens it', async ({ page }) => {
    await nav(page).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-tab-sessions').click();
    await expect(page.getByTestId('panel-tab-sessions')).toContainText('1');
    await expect(page.getByTestId('sidebar-terminal-t-old')).toBeVisible();
    await expect(page.locator('#terminal')).toBeHidden();
    await page.getByTestId('sidebar-terminal-t-old').click();
    await expect(page.locator('#terminal')).toBeVisible();
  });

  test('a #terminal link to it opens it', async ({ page }) => {
    await page.waitForFunction(() => window.client.terminalManager?.allTerminals?.has('t-old'));
    await page.evaluate(() => { location.hash = '#terminal/t-old'; });
    await expect(page.locator('#terminal')).toBeVisible();
  });

  test('a second terminal_list (as after a reconnect) opens nothing either', async ({ page }) => {
    await page.waitForFunction(() => window.client.terminalManager?.allTerminals?.has('t-old'));
    await page.evaluate(() => window.client.terminalManager.requestTerminalList());
    await page.waitForTimeout(500);
    await expect(page.locator('#terminal')).toBeHidden();
    expect(await page.evaluate(() => window.client.tabManager.tabs.length)).toBe(0);
  });

  test('a terminal I start myself still opens', async ({ page }) => {
    await nav(page).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('sidebar-new-session-alpha').click();
    const dialog = page.getByTestId('dialog-shell-launcher-dialog');
    await expect(dialog.getByText('Loading terminal templates…')).toHaveCount(0);
    await dialog.getByRole('button', { name: /Shell/ }).first().click();
    await expect(page.locator('#terminal')).toBeVisible();
  });
});
