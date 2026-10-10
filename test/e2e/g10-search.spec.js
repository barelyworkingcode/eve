const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function searchable() {
  const w = worlds.base();
  w.projects[0].files = {
    'README.md': '# Acme\n',
    'notes/a.md': 'a tame cat sat here\nsecond line\n',
    'notes/b.txt': 'category of things\n',
    'src/c.js': 'const cat = 1;\n',
  };
  return w;
}

test.use({ world: searchable() });

async function openSearch(eve, page) {
  await eve.open('/');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Search file contents…' });
  await expect(box).toBeFocused();
  return box;
}

test('open Search from the panel @G10.1', async ({ eve, page }) => {
  await openSearch(eve, page);
  await expect(page.getByText('Type to search file contents.')).toBeVisible();
});

test('open Search with the keyboard @G10.2', async ({ eve, page }) => {
  await eve.open('/');
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(page.getByRole('textbox', { name: 'Search file contents…' })).toBeFocused();
});

test('search file contents for a word @G10.3', async ({ eve, page, relay }) => {
  const since = relay.mark();
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^1 a tame cat sat here/ })).toBeVisible();
  await relay.waitForEvent('file.search', { since });
});

test('no hits says No matches @G10.3.r1', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await box.fill('zzzqqq');
  await expect(page.getByText('No matches.')).toBeVisible();
});

test('relay down says it is not reachable @G10.3.r2', async ({ eve, page, relay }) => {
  const box = await openSearch(eve, page);
  const r = await relay.ctl('fault', 'add', '--route', '*', '--mode', 'down');
  expect(r.code).toBe(0);
  await box.fill('cat');
  await expect(page.getByText(/Relay is not reachable/)).toBeVisible();
});

test('Return searches at once @G10.4', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await box.press('Enter');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
});

test('regex search @G10.5', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await box.fill('c[a]t');
  await expect(page.getByText('No matches.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Regex' }).check();
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
});

test('bad regex shows the search error @G10.5.r1', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await page.getByRole('checkbox', { name: 'Regex' }).check();
  await box.fill('(unclosed');
  await expect(page.getByText(/Invalid regex/)).toBeVisible();
});

test('whole word leaves out category @G10.6', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Whole word' }).check();
  await expect(page.getByText(/^2 matches in 2 files/)).toBeVisible();
});

test('limit the search to some files @G10.7', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
  await page.getByRole('textbox', { name: 'files to include (e.g. *.md, !node_modules)' }).fill('*.md');
  await expect(page.getByText(/^1 match in 1 file/)).toBeVisible();
});

test('a glob that starts with / is refused @G10.7.r1', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await page.getByRole('textbox', { name: 'files to include (e.g. *.md, !node_modules)' }).fill('/etc');
  await box.fill('cat');
  await expect(page.getByText('Invalid glob: /etc')).toBeVisible();
});

test('a long glob is refused @G10.7.r2', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await page.getByRole('textbox', { name: 'files to include (e.g. *.md, !node_modules)' }).fill('a'.repeat(201));
  await box.fill('cat');
  await expect(page.getByText('Glob too long (max 200 chars)')).toBeVisible();
});

test('arrow keys move the selection, Return opens @G10.8 @G10.9', async ({ eve, page, relay }) => {
  const since = relay.mark();
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
  await box.press('ArrowDown');
  await box.press('ArrowDown');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await relay.waitForEvent('file.read', { since });
});

test('close with the close button @G10.14', async ({ eve, page }) => {
  await openSearch(eve, page);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeHidden();
});

test('close with Escape @G10.15', async ({ eve, page }) => {
  await openSearch(eve, page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeHidden();
});

test('ask about the shown matches @G10.10', async ({ eve, page }) => {
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
  await page.getByRole('button', { name: 'Ask about this' }).click();
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeHidden();
  await expect(page.getByText('3 results for cat')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask' })).toBeVisible();
});

test('AI summary shows the model text @G10.11 @G10.12', async ({ eve, page, relay }) => {
  const since = relay.mark();
  const box = await openSearch(eve, page);
  await box.fill('cat');
  await expect(page.getByText(/^3 matches in 3 files/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'AI enhanced' }).check();
  await expect(page.getByText('AI summary', { exact: true })).toBeVisible();
  await expect(page.getByText(/echo:/)).toBeVisible();
  await relay.waitForEvent('chat.turn', { since });
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeEnabled();
});
