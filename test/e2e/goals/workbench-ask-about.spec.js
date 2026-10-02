// S5a-A4 "Ask about this": a file, a diff or search results go to Today's Ask as
// a removable attachment, asked in the item's project. docs/design-workbench.md
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect, MODELS } = require('./fixture');
const { nav } = require('./today-helpers');

const ask = (page) => page.getByTestId('today-ask-input');
const chip = (page) => page.getByTestId('today-ask-attachment');
const sent = (eve) => eve.relay.inbound.filter((m) => m.type === 'send_message');
const TOO_LARGE = "That's too large to attach (over 256 KB).";

const world = {
  seed: ({ relay, folders }) => {
    relay.setModels(MODELS);
    relay.setDefaultProject('work', 'beta');
    fs.writeFileSync(path.join(folders.alpha, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(folders.alpha, 'needles.txt'), 'needle one\nhay\nneedle two\n');
  },
};

async function askAboutFile(page, file) {
  await nav(page).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('panel-tab-files').click();
  await page.getByTestId(`file-tree-item-/${file}`).click({ button: 'right' });
  await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Ask about this' }).click();
}

// The attachments the one send carried to relay, after Return. Relay treats
// every file as an image, so eve inlines text files into the message text and
// sends only images as files (#131).
async function sendAndGetAttachment(page, eve, text) {
  await ask(page).fill(text);
  await ask(page).press('Enter');
  await expect.poll(() => sent(eve).length, { timeout: 15000 }).toBe(1);
  return sent(eve)[0].files;
}

// The inlined body of the one text attachment in the frame's text (#131).
async function sendAndGetInlined(page, eve, text) {
  const files = await sendAndGetAttachment(page, eve, text);
  expect(files || []).toEqual([]);
  const m = sent(eve)[0].text.match(/\n\nAttached file: [^\n]+\n(`{3,})\n([\s\S]*)\n\1$/);
  expect(m).not.toBeNull();
  return m[2];
}

async function searchAlpha(page, query) {
  await page.evaluate(() => window.client.bus.emit('dialog:search', { projectId: 'alpha' }));
  await page.getByTestId('search-dialog-query').fill(query);
  await page.getByTestId('search-dialog-query').press('Enter');
  await expect(page.getByTestId('search-dialog-ask')).toBeVisible({ timeout: 15000 });
}

test.describe('S5a-A4 Ask about a file', () => {
  test.use({ world });

  test('shows Today with Ask focused and a chip; Return asks in the file\'s project with its text attached', async ({ page, eve }) => {
    await askAboutFile(page, 'notes.txt');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(ask(page)).toBeFocused();
    await expect(chip(page)).toContainText('notes.txt');

    const files = await sendAndGetAttachment(page, eve, 'what is this?');
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'alpha' });
    expect(files || []).toEqual([]);
    const text = sent(eve)[0].text;
    expect(text).toContain('what is this?');
    expect(text).toContain('Attached file: notes.txt\n```\nfirst line\n\n```');
  });

  // Reopening a thread replays the stored user message, which carries the inlined
  // file text. The bubble shows a chip with the name, not the text (#131).
  test('a reopened thread shows the file as a chip, not its text', async ({ page, eve }) => {
    await askAboutFile(page, 'notes.txt');
    await expect(chip(page)).toContainText('notes.txt');
    await sendAndGetAttachment(page, eve, 'what is this?');
    const stored = sent(eve)[0].text;
    expect(stored).toContain('first line');
    // The relay keeps the sent text as the thread's history.
    eve.relay.seedSession({
      sessionId: 's-asked', projectId: 'alpha', directory: eve.folders.alpha, model: 'fake-model', name: 'Asked',
      history: [{ timestamp: new Date().toISOString(), role: 'user', content: stored }],
      live: false, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(), messageCount: 1,
    });
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await nav(page).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await page.getByTestId('project-thread-s-asked').click();
    const bubble = page.getByTestId('messages-container').getByTestId('message-user');
    await expect(bubble).toContainText('what is this?');
    await expect(bubble.locator('.message-file')).toHaveText(['notes.txt']);
    await expect(bubble).not.toContainText('first line');
    await expect(bubble).not.toContainText('Attached file:');
  });

  test('the chip survives a mode switch; removing it restores the mode default and attaches nothing', async ({ page, eve }) => {
    await askAboutFile(page, 'notes.txt');
    await expect(chip(page)).toBeVisible();
    await page.getByTestId('mode-home').click();
    await page.getByTestId('mode-work').click();
    await expect(chip(page)).toContainText('notes.txt');

    await page.getByTestId('today-ask-attachment-remove').click();
    await expect(chip(page)).toHaveCount(0);
    const files = await sendAndGetAttachment(page, eve, 'plain question');
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'beta' });
    expect(files || []).toEqual([]);
  });

  test('a file over 256 KB gets the line and no chip', async ({ page }) => {
    await askAboutFile(page, 'big.txt');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.getByTestId('today-ask-status')).toHaveText(TOO_LARGE);
    await expect(chip(page)).toHaveCount(0);
  });

  test('a folder has no "Ask about this"', async ({ page }) => {
    await nav(page).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-tab-files').click();
    await page.getByTestId('file-tree-item-/src').click({ button: 'right' });
    const menu = page.locator('.file-tree__context-menu');
    await expect(menu.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Ask about this' })).toHaveCount(0);
  });
});

test.describe('S5a-A4 Ask about the pick', () => {
  test.use({ world: { seed: (eve) => { eve.relay.setModels(MODELS); } } });

  test('the file\'s project beats the remembered pick, and the pick is unchanged', async ({ page, eve }) => {
    await page.evaluate(() => localStorage.setItem('eve-ask-project', 'beta'));
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await askAboutFile(page, 'notes.txt');
    await expect(chip(page)).toContainText('notes.txt');
    await sendAndGetAttachment(page, eve, 'about the pick');
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'alpha' });
    expect(await page.evaluate(() => localStorage.getItem('eve-ask-project'))).toBe('beta');
  });
});

test.describe('S5a-A4 Ask about a diff', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        world.seed({ relay, folders });
        const git = (...args) => execFileSync('git', ['-c', 'user.name=Acme', '-c', 'user.email=acme@example.invalid',
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        { cwd: folders.alpha, stdio: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) });
        git('init', '-q', '-b', 'main');
        git('add', '-A');
        git('commit', '-q', '-m', 'initial');
        fs.writeFileSync(path.join(folders.alpha, 'notes.txt'), 'first line\nsecond line\n');
      },
    },
  });

  test('diff-ask attaches a unified diff of the file', async ({ page, eve }) => {
    await nav(page).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-tab-changes').click();
    await page.locator('[data-testid^="changes-file-"][data-testid$=":notes.txt"]').click();
    await expect(page.getByTestId('diff-ask')).toBeEnabled({ timeout: 15000 });
    await page.getByTestId('diff-ask').click();
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(chip(page)).toContainText('notes.txt');

    const diff = await sendAndGetInlined(page, eve, 'review this');
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'alpha' });
    expect(diff).toMatch(/^--- a\/notes\.txt$/m);
    expect(diff).toMatch(/^\+\+\+ b\/notes\.txt$/m);
    expect(diff).toMatch(/^@@ -1(,\d+)? \+1(,\d+)? @@/m);
    expect(diff).toMatch(/^\+second line$/m);
  });
});

test.describe('S5a-A4 Ask about search results', () => {
  test.use({ world });

  test('the dialog closes; the chip counts the results; the content is path:line: text', async ({ page, eve }) => {
    await searchAlpha(page, 'needle');
    await page.getByTestId('search-dialog-ask').click();
    await expect(page.getByTestId('dialog-search-dialog')).toBeHidden();
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(chip(page)).toContainText('2 results for needle');

    const body = await sendAndGetInlined(page, eve, 'where are they?');
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'alpha' });
    expect(body.trim().split('\n')).toEqual([
      expect.stringMatching(/^\/?needles\.txt:1: needle one$/),
      expect.stringMatching(/^\/?needles\.txt:3: needle two$/),
    ]);
  });
});

test.describe('S5a-A4 not offered for a host project', () => {
  test.use({ world });

  // Marks alpha as a host project the way the project list carries it.
  const makeHostProject = async (page, field) => {
    await page.waitForFunction(() => !!window.client?.state?.getProject('alpha'));
    await page.evaluate((f) => {
      const p = window.client.state.getProject('alpha');
      p[f] = f === 'host' ? { id: 'h1', name: 'Acme Host', status: 'connected' } : 'h1';
    }, field);
  };

  for (const field of ['host', 'hostId']) {
    test(`a file's menu has no "Ask about this" when the project has ${field}`, async ({ page }) => {
      await nav(page).getByTitle('Alpha Project', { exact: true }).click();
      await page.getByTestId('panel-tab-files').click();
      const item = page.getByTestId('file-tree-item-/notes.txt');
      await expect(item).toBeVisible();
      await makeHostProject(page, field);
      await item.click({ button: 'right' });
      const menu = page.locator('.file-tree__context-menu');
      await expect(menu.getByRole('button', { name: 'Delete' })).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Ask about this' })).toHaveCount(0);
    });

    test(`search results have no "Ask about this" when the project has ${field}`, async ({ page }) => {
      await makeHostProject(page, field);
      await page.evaluate(() => window.client.bus.emit('dialog:search', { projectId: 'alpha' }));
      await page.getByTestId('search-dialog-query').fill('needle');
      await page.getByTestId('search-dialog-query').press('Enter');
      await expect(page.locator('[data-testid^="search-dialog-result-"]').first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('search-dialog-ask')).toBeHidden();
    });
  }
});

test.describe('S5a-A4 at 390 with touch', () => {
  test.use({ world, viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Today is the root, the chip shows, and Ask is not focused', async ({ page }) => {
    await searchAlpha(page, 'needle');
    await page.getByTestId('search-dialog-ask').tap();
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(chip(page)).toContainText('2 results for needle');
    await expect(page.getByTestId('nav-back')).toBeHidden();
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => document.activeElement === document.querySelector('[data-testid="today-ask-input"]'))).toBe(false);
  });
});
