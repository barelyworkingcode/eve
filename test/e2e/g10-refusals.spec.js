const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const SEARCH_BOX = 'Search file contents…';
const PALETTE_BOX = 'Jump to a session, project, file or action…';

async function openSearch(page) {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
  const box = page.getByRole('textbox', { name: SEARCH_BOX });
  await expect(box).toBeFocused();
  return box;
}

test.describe('no project is active', () => {
  test.use({ world: { schema: 1, projects: [] } });

  test('the keyboard shortcut opens nothing @G10.2.r1', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Shift+F');
    // Positive marker: the palette opens and lists no search row for a project.
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('textbox', { name: PALETTE_BOX })).toBeFocused();
    await expect(page.getByRole('textbox', { name: SEARCH_BOX })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeHidden();
  });
});

function manyMatches(pad) {
  const w = worlds.base();
  const files = { 'README.md': '# Acme\n' };
  for (let f = 0; f < 12; f++) {
    const lines = [];
    for (let l = 0; l < 50; l++) lines.push(`cat ${l} ${pad}`);
    files[`data/f${f}.txt`] = lines.join('\n') + '\n';
  }
  w.projects[0].files = files;
  return w;
}

test.describe('over the match cap', () => {
  test.use({ world: manyMatches('') });

  test('the count says truncated and asks to refine @G10.3.r3', async ({ eve, page }) => {
    await eve.open('/');
    const box = await openSearch(page);
    await box.fill('cat');
    await expect(page.getByText(/\(truncated/)).toBeVisible();
  });
});

test.describe('a file type eve will not open', () => {
  test.use({
    world: (() => {
      const w = worlds.base();
      w.projects[0].files = { 'README.md': '# Acme\n', 'tool.exe': 'cat inside\n' };
      return w;
    })(),
  });

  test('the match says the type is not allowed @G10.9.r1', async ({ eve, page }) => {
    await eve.open('/');
    const box = await openSearch(page);
    await box.fill('cat');
    await expect(page.getByText(/^1 match in 1 file/)).toBeVisible();
    await page.getByRole('button', { name: /^1 cat inside/ }).click();
    await expect(page.getByText('File type not allowed for editing', { exact: true })).toBeVisible();
  });
});

test.describe('a file that went away', () => {
  test.use({
    world: (() => {
      const w = worlds.base();
      w.projects[0].files = { 'README.md': '# Acme\n', 'notes.md': 'a cat here\n' };
      return w;
    })(),
  });

  test('the match says File not found @G10.9.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    const box = await openSearch(page);
    await box.fill('cat');
    await expect(page.getByText(/^1 match in 1 file/)).toBeVisible();
    const r = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/read',
      '--mode', 'error', '--status', '404', '--body', '{"error":"Not found","code":"ENOENT"}');
    expect(r.code).toBe(0);
    await page.getByRole('button', { name: /^1 a cat here/ }).click();
    await expect(page.getByText('File not found', { exact: true })).toBeVisible();
  });

  test('the palette says File not found @G10.30.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('treeitem', { name: 'notes.md' }).click();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    const r = await relay.ctl('fault', 'add', '--route', 'POST /api/projects/{id}/files/read',
      '--mode', 'error', '--status', '404', '--body', '{"error":"Not found","code":"ENOENT"}');
    expect(r.code).toBe(0);
    await page.keyboard.press('ControlOrMeta+K');
    const box = page.getByRole('textbox', { name: PALETTE_BOX });
    await box.fill('notes');
    await page.getByRole('option', { name: /notes\.md/ }).first().click();
    await expect(page.getByText('File not found', { exact: true })).toBeVisible();
  });
});

function bigLines() {
  // Ask about this carries the first 200 matches; 200 lines of 2000 characters
  // are well past 256 KB.
  const w = manyMatches('x'.repeat(2000));
  return w;
}

test.describe('results over 256 KB', () => {
  test.use({ world: bigLines() });

  test('Ask about this refuses a result that is too large @G10.10.r1', async ({ eve, page }) => {
    await eve.open('/');
    const box = await openSearch(page);
    await box.fill('cat');
    await expect(page.getByText(/\(truncated/)).toBeVisible();
    await page.getByRole('button', { name: 'Ask about this' }).click();
    await expect(page.getByText("That's too large to attach (over 256 KB).")).toBeVisible();
  });
});

function withModels() {
  const w = worlds.base();
  w.projects[0].files = { 'README.md': '# Acme\n', 'notes.md': 'a cat here\n' };
  w.models = [
    { value: 'quiet-model', label: 'Quiet', group: 'Test', provider: 'chat', reply: { kind: 'text', text: '' } },
    { value: 'failing-model', label: 'Failing', group: 'Test', provider: 'chat', reply: { kind: 'fail' } },
  ];
  return w;
}

test.describe('a summary that fails', () => {
  test.use({ world: withModels() });

  async function summaryOn(page) {
    const box = await openSearch(page);
    await box.fill('cat');
    await expect(page.getByText(/^1 match in 1 file/)).toBeVisible();
    await page.getByRole('checkbox', { name: 'AI enhanced' }).check();
    await expect(page.getByText('AI summary', { exact: true })).toBeVisible();
  }

  test('a model with no text says so @G10.11.r1', async ({ eve, page }) => {
    await eve.open('/');
    await summaryOn(page);
    await page.getByRole('dialog').getByRole('combobox', { name: 'Model', exact: true }).selectOption({ label: 'Quiet' });
    await expect(page.getByText('AI summary error', { exact: true })).toBeVisible();
    await expect(page.getByText('Model returned no text.')).toBeVisible();
  });

  test('Retry runs the summary again and it can fail again @G10.13 @G10.13.r1', async ({ eve, page, relay }) => {
    await eve.open('/');
    await summaryOn(page);
    await page.getByRole('dialog').getByRole('combobox', { name: 'Model', exact: true }).selectOption({ label: 'Failing' });
    await expect(page.getByText('AI summary error', { exact: true })).toBeVisible();
    const since = relay.mark();
    const r = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'slow');
    expect(r.code).toBe(0);
    const id = JSON.parse(r.stdout).id;
    await page.getByRole('dialog').getByRole('button', { name: 'Retry' }).click();
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
    await expect(page.getByText('AI summary', { exact: true })).toBeVisible();
    await expect(page.getByText('Thinking…')).toBeVisible();
    await relay.ctl('fault', 'release', '--id', id);
    await expect(page.getByText('AI summary error', { exact: true })).toBeVisible();
  });
});
