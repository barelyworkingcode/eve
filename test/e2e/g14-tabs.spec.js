const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const PALETTE = 'Jump to a session, project, file or action…';

function thread(id, projectId, name) {
  return {
    id,
    project_id: projectId,
    name,
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: `question in ${name}` }, { role: 'assistant', text: `answer in ${name}` }],
  };
}

function tabsWorld() {
  const w = worlds.base();
  w.projects.push({ id: 'p_beta', name: 'Beta', mode: 'work', files: { 'NOTES.md': '# Beta\n' } });
  w.sessions = [thread('s_a1', 'p_acme', 'Ledger'), thread('s_a2', 'p_acme', 'Roadmap'), thread('s_b1', 'p_beta', 'Harbor')];
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  return w;
}

async function openThread(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
  await expect(page.getByRole('tab', { name })).toBeVisible();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

async function openProjectPage(page, project) {
  await rail(page).getByRole('button', { name: project }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

async function terminals(relay) {
  return (await relay.json('ctl', 'state', '--json')).terminals;
}

async function openTerminal(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await page.getByRole('dialog', { name: 'Shell Launcher' }).getByRole('button', { name: 'Shell' }).click();
  await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
}

// An unsaved file tab: open the README, type into the editor.
async function openDirtyFile(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('treeitem', { name: 'README.md' }).click();
  const tab = page.getByRole('tab', { name: /README\.md/ });
  await expect(tab).toBeVisible();
  const editor = page.getByRole('textbox', { name: /^Editor content/ });
  // Typing before the file has loaded would be replaced by the load, leaving no unsaved change.
  await expect(editor).toHaveValue(/# Acme/);
  await editor.focus();
  await page.keyboard.type('more');
  await expect(tab).toContainText('●');
}

test.describe('tabs', () => {
  test.use({ world: tabsWorld() });

  test('switch to another open tab @G14.1', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page, 'Acme');
    await openThread(page, 'Ledger');
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await openThread(page, 'Roadmap');
    await page.getByRole('tab', { name: 'Ledger' }).click();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByText('answer in Ledger')).toBeVisible();
    await expect(page.getByText('answer in Roadmap')).toBeHidden();
  });

  test('the tab bar lists only the active project tabs @G14.1', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page, 'Acme');
    await openThread(page, 'Ledger');
    await rail(page).getByRole('button', { name: 'Beta' }).click();
    await page.getByRole('button', { name: 'Project page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Beta' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveCount(0);
  });

  test('close a thread tab and the next one shows @G14.2', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page, 'Acme');
    await openThread(page, 'Ledger');
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await openThread(page, 'Roadmap');
    await page.getByRole('button', { name: 'Close Roadmap' }).click();
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
  });

  test('close the last tab and Today shows @G14.2', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page, 'Acme');
    await page.getByRole('button', { name: 'Close Acme' }).click();
    await expect(page.getByRole('tab', { name: 'Acme', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: /^(Good morning|Good afternoon|Good evening|Working late)\.$/ })).toBeVisible();
  });

  test('closing a terminal tab removes it from relay @G14.2', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openTerminal(page);
    await expect.poll(async () => (await terminals(relay)).length).toBe(1);
    await page.getByRole('button', { name: 'Close Acme - Shell' }).click();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveCount(0);
    await expect.poll(async () => (await terminals(relay)).length).toBe(0);
  });

  test('an unsaved file tab asks before it closes @G14.2.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openDirtyFile(page);
    const messages = [];
    page.once('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
    await page.getByRole('button', { name: /^Close README\.md/ }).click();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatch(/README\.md.* has unsaved changes\. Close anyway\?/);
    await expect(page.getByRole('tab', { name: /README\.md/ })).toBeVisible();
  });

  test('close the active tab with the keyboard @G14.3', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page, 'Acme');
    await openThread(page, 'Ledger');
    await page.keyboard.press('ControlOrMeta+w');
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveCount(0);
  });

  test('keyboard close of a terminal tab removes it from relay @G14.3', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openTerminal(page);
    await expect.poll(async () => (await terminals(relay)).length).toBe(1);
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.press('ControlOrMeta+w');
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveCount(0);
    await expect.poll(async () => (await terminals(relay)).length).toBe(0);
  });

  test('an unsaved file tab asks before the keyboard closes it @G14.3.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openDirtyFile(page);
    const messages = [];
    page.once('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
    await page.keyboard.press('ControlOrMeta+w');
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatch(/README\.md.* has unsaved changes\. Close anyway\?/);
    await expect(page.getByRole('tab', { name: /README\.md/ })).toBeVisible();
  });

  test('close the current tab from the Command palette @G14.44', async ({ eve, page }) => {
    await eve.open('/');
    await openProjectPage(page, 'Acme');
    await openThread(page, 'Ledger');
    await page.keyboard.press('ControlOrMeta+k');
    const box = page.getByRole('textbox', { name: PALETTE });
    await box.fill('Close');
    await page.getByRole('option', { name: /Close current tab/ }).click();
    await expect(box).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveCount(0);
  });

  test('closing a terminal tab from the palette removes it from relay @G14.44', async ({ eve, page, relay }) => {
    await eve.open('/');
    await openTerminal(page);
    await expect.poll(async () => (await terminals(relay)).length).toBe(1);
    await page.keyboard.press('ControlOrMeta+k');
    const box = page.getByRole('textbox', { name: PALETTE });
    await box.fill('Close');
    await page.getByRole('option', { name: /Close current tab/ }).click();
    await expect(box).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveCount(0);
    await expect.poll(async () => (await terminals(relay)).length).toBe(0);
  });

  test('an unsaved file tab asks before the palette closes it @G14.44.r1', async ({ eve, page }) => {
    await eve.open('/');
    await openDirtyFile(page);
    const messages = [];
    page.once('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('textbox', { name: PALETTE }).fill('Close');
    await page.getByRole('option', { name: /Close current tab/ }).click();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatch(/README\.md.* has unsaved changes\. Close anyway\?/);
    await expect(page.getByRole('tab', { name: /README\.md/ })).toBeVisible();
  });
});
