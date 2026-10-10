const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function withThread() {
  const w = worlds.base();
  w.projects.push({ id: 'p_beta', name: 'Beta', mode: 'work', files: { 'NOTES.md': '# Beta\n' } });
  w.sessions = [{
    id: '6f1d7a52-3c1b-4c55-9d0e-1a2b3c4d5e6f',
    project_id: 'p_acme',
    name: 'Plan the harvest',
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: 'plan the harvest' }, { role: 'assistant', text: 'echo: plan the harvest' }],
  }];
  return w;
}

test.use({ world: withThread() });

const BOX = 'Jump to a session, project, file or action…';

async function openPalette(eve, page) {
  await eve.open('/');
  await page.keyboard.press('ControlOrMeta+K');
  const box = page.getByRole('textbox', { name: BOX });
  await expect(box).toBeFocused();
  return box;
}

test('open the palette and see its sections @G10.16', async ({ eve, page }) => {
  await openPalette(eve, page);
  await expect(page.getByRole('option', { name: /New session…/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Plan the harvest/ })).toBeVisible();
});

test('Escape closes the palette @G10.17', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});

test('the shortcut again closes the palette @G10.18', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await page.keyboard.press('ControlOrMeta+K');
  await expect(box).toBeHidden();
});

test('typing narrows the options @G10.19', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await box.fill('harvest');
  await expect(page.getByRole('option', { name: /Plan the harvest/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /New session…/ })).toBeHidden();
});

test('nothing fits says No matches @G10.19.r1', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await box.fill('zzzqqq');
  await expect(page.getByText('No matches for “zzzqqq”')).toBeVisible();
});

test('arrow keys, Home and End move the selection @G10.20', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await box.fill('Appearance');
  const auto = page.getByRole('option', { name: 'Appearance: Auto' });
  const light = page.getByRole('option', { name: 'Appearance: Light' });
  const last = page.getByRole('option', { name: 'Settings', exact: true });
  await expect(last).toBeVisible();
  await expect(auto).toHaveAttribute('aria-selected', 'true');
  await box.press('ArrowDown');
  await expect(light).toHaveAttribute('aria-selected', 'true');
  await expect(auto).not.toHaveAttribute('aria-selected', 'true');
  await box.press('ArrowUp');
  await expect(auto).toHaveAttribute('aria-selected', 'true');
  await expect(light).not.toHaveAttribute('aria-selected', 'true');
  await box.press('End');
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(auto).not.toHaveAttribute('aria-selected', 'true');
  await box.press('Home');
  await expect(auto).toHaveAttribute('aria-selected', 'true');
  await expect(last).not.toHaveAttribute('aria-selected', 'true');
});

test('Return runs the selected row @G10.21', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await box.fill('harvest');
  await expect(page.getByRole('option', { name: /Plan the harvest/ })).toHaveAttribute('aria-selected', 'true');
  await box.press('Enter');
  await expect(box).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Plan the harvest' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
});

test('New session… opens the Launcher @G10.22', async ({ eve, page }) => {
  await openPalette(eve, page);
  await page.getByRole('option', { name: /New session…/ }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
});

test('Search in files opens Search @G10.23', async ({ eve, page }) => {
  await openPalette(eve, page);
  await page.getByRole('option', { name: /Search in files/ }).click();
  await expect(page.getByRole('textbox', { name: 'Search file contents…' })).toBeVisible();
});

test('New project opens the Project dialog @G10.24', async ({ eve, page }) => {
  await openPalette(eve, page);
  await page.getByRole('option', { name: /New project/ }).click();
  await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
});

test('Settings opens the Settings sheet @G10.25', async ({ eve, page }) => {
  await openPalette(eve, page);
  await page.getByRole('option', { name: /Settings/ }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('Routines opens the Routines page @G10.26', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await box.fill('Routines');
  await page.getByRole('option', { name: /Routines/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
});

test('jump to a thread @G10.27', async ({ eve, page }) => {
  await openPalette(eve, page);
  await page.getByRole('option', { name: /Plan the harvest/ }).click();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plan the harvest' })).toBeVisible();
  await expect(page.getByText('echo: plan the harvest')).toBeVisible();
});

test('switch project @G10.28', async ({ eve, page }) => {
  const box = await openPalette(eve, page);
  await box.fill('Beta');
  await page.getByRole('option', { name: /Beta/ }).first().click();
  await expect(page.getByRole('treeitem', { name: 'NOTES.md' })).toBeVisible();
});

test('switch to an open tab @G10.29', async ({ eve, page }) => {
  await eve.open('/');
  await page.getByRole('treeitem', { name: 'README.md' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.getByRole('button', { name: 'Chief of Staff' }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+K');
  const box = page.getByRole('textbox', { name: BOX });
  await expect(box).toBeFocused();
  await expect(page.getByRole('tab', { name: 'README.md', selected: false })).toBeVisible();
  // With an empty query the palette has no "Recent files" section, so the one
  // README.md option is the row under "Open tabs".
  const option = page.getByRole('option', { name: 'README.md', exact: true });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(box).toBeHidden();
  await expect(page.getByRole('tab', { name: 'README.md', selected: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('open a recently used file @G10.30', async ({ eve, page, relay }) => {
  await eve.open('/');
  await page.getByRole('treeitem', { name: 'README.md' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  const since = relay.mark();
  await page.keyboard.press('ControlOrMeta+K');
  const box = page.getByRole('textbox', { name: BOX });
  await box.fill('README');
  await page.getByRole('option', { name: /README\.md/ }).first().click();
  await expect(box).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await relay.waitForEvent('file.read', { since, match: (l) => l.status === 'ok' });
});
