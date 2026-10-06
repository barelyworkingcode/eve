// G4 · Work in a shell on my project. A terminal opens only when asked, runs my
// command, and is still there after a reload.
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');

test.use({
  world: {
    seed: ({ relay }) => {
      relay.setTerminalTemplates([{ id: 'shell', name: 'Shell', description: 'Plain shell', sandbox: true }]);
    },
  },
});

const screenText = (page) => page.evaluate(() => {
  const tm = window.client.terminalManager;
  const term = tm.terminals.get(tm.activeTerminalId)?.term;
  if (!term) return '';
  const buf = term.buffer.active;
  let out = '';
  for (let i = 0; i < buf.length; i++) out += (buf.getLine(i)?.translateToString(true) || '') + '\n';
  return out;
});

async function openShell(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('sidebar-new-session-alpha').click();
  const dialog = page.getByTestId('dialog-shell-launcher-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Loading terminal templates…')).toHaveCount(0);
  await dialog.getByRole('button', { name: /Shell/ }).first().click();
  await expect(page.locator('#terminal')).toBeVisible();
}

test.describe('G4 terminal', () => {
  test('nothing opens by itself: Home shows, no terminal exists', async ({ page, eve }) => {
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.locator('#terminal')).toBeHidden();
    expect(eve.relay.listTerminals()).toHaveLength(0);
  });

  test('the launcher offers the template, opens one terminal, and my command runs', async ({ page, eve }) => {
    await openShell(page);
    await expect.poll(() => eve.relay.listTerminals().length).toBe(1);
    expect(eve.relay.listTerminals()[0]).toMatchObject({ directory: eve.folders.alpha });
    await expect.poll(() => screenText(page)).toContain('$');

    await page.locator('#terminal .xterm-screen').filter({ visible: true }).last().click();
    await page.keyboard.type('echo hello-from-shell');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(page)).toMatch(/^hello-from-shell$/m);
  });

  test('after a reload the terminal is listed under its project and its output is replayed', async ({ page, eve }) => {
    await openShell(page);
    await page.locator('#terminal .xterm-screen').filter({ visible: true }).last().click();
    await page.keyboard.type('echo survives-reload');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(page)).toMatch(/^survives-reload$/m);
    const [{ terminalId }] = eve.relay.listTerminals();

    await reloadEve(page);
    // CHANGED by S1-A2 (docs/design-today-s1.md): the terminal used to reopen by
    // itself on reload and this click only focused it. Now it stays closed until
    // asked, so assert that first, then that the click opens it.
    // Wait until the page has been told about the terminal, or "hidden" is checked
    // before a terminal_list could have opened it.
    await page.waitForFunction((id) => window.client.terminalManager?.allTerminals?.has(id), terminalId);
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.locator('#terminal')).toBeHidden();
    // CHANGED by S5a-A3 (docs/design-workbench.md): the terminal used to be listed
    // in the panel's Sessions tab. Now Today's agent board and the project page's
    // Agents section list it; nothing opens until the page row is clicked.
    await expect(page.getByTestId(`today-agent-${terminalId}`)).toBeVisible();
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await expect(page.locator('#terminal')).toBeHidden();
    await page.getByTestId(`project-agent-${terminalId}`).click();
    await expect(page.locator('#terminal')).toBeVisible();
    await expect.poll(() => screenText(page)).toMatch(/^survives-reload$/m);
    expect(eve.relay.listTerminals()).toHaveLength(1); // the same terminal, not a new one
  });
});
