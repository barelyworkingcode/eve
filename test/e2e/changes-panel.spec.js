/**
 * Changes panel + diff pane end to end (docs/design-git-changes.md).
 *
 * The project root holds three git checkouts, the layout the feature exists
 * for:
 *
 *   <root>/main/          main repo, branch main            — clean
 *   <root>/feat-login/    worktree, branch feat/login       — M, A, D, ? + one commit (adds a .cs file)
 *   <root>/fix-timeouts/  worktree, branch fix/timeouts     — one M
 *
 * The commit on feat/login is what only the "vs base" scope shows. Real git
 * runs against a real temp dir; the eve under test is the usual spawned
 * server + fake relay (test/integration/harness.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const base = require('@playwright/test');
const { startEve } = require('../integration/harness');
const { hermeticTest, gotoEve } = require('./fixtures');

const { expect } = base;

// An inherited GIT_DIR / GIT_INDEX_FILE (e.g. when run from the pre-push
// hook) would point these commands at eve's own repo.
function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

function git(cwd, ...args) {
  return execFileSync('git', [
    '-c', 'user.name=Eve E2E',
    '-c', 'user.email=e2e@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], { cwd, env: gitEnv(), stdio: 'pipe' }).toString();
}

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function buildWorktreeFixture(root) {
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  write(main, 'README.md', '# Worktree fixture\n');
  write(main, 'src/auth.js', 'const t = read();\nmodule.exports = t;\n');
  write(main, 'old-session.js', 'module.exports = {};\n');
  write(main, 'lib/relay-client.js', 'const TIMEOUT = 1000;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'initial');

  git(main, 'worktree', 'add', '-q', '-b', 'feat/login', path.join(root, 'feat-login'));
  git(main, 'worktree', 'add', '-q', '-b', 'fix/timeouts', path.join(root, 'fix-timeouts'));

  const feat = path.join(root, 'feat-login');
  write(feat, 'routes/session.js', 'module.exports = () => {};\n');
  write(feat, 'src/Program.cs', 'class Program { static void Main() {} }\n');
  git(feat, 'add', 'routes/session.js', 'src/Program.cs');
  git(feat, 'commit', '-q', '-m', 'add session route');
  write(feat, 'src/auth.js', 'const t = await read();\nmodule.exports = t;\n'); // M
  write(feat, 'src/token-store.js', 'module.exports = new Map();\n');
  git(feat, 'add', 'src/token-store.js');                                         // A
  fs.rmSync(path.join(feat, 'old-session.js'));                                  // D
  write(feat, 'notes.md', 'todo\n');                                             // ?

  write(path.join(root, 'fix-timeouts'), 'lib/relay-client.js', 'const TIMEOUT = 30000;\n'); // M
}

const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-git-'));
    buildWorktreeFixture(projectDir);
    const eve = await startEve({
      projects: [{ id: 'p1', name: 'Worktrees', path: projectDir }],
    });
    try {
      await use({ ...eve, projectDir });
    } finally {
      await eve.stop();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },

  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

async function openChanges(page) {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('panel-tab-changes').click();
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  await expect(page.getByTestId('changes-repo-/feat-login')).toBeVisible({ timeout: 15000 });
}

function repoHeader(page, repo) {
  return page.getByTestId(`changes-repo-${repo}`);
}

function fileRow(page, repo, file) {
  return page.getByTestId(`changes-file-${repo}:${file}`);
}

async function groupOrder(page) {
  return page.getByTestId('changes-panel').evaluate((panel) =>
    [...panel.querySelectorAll('[data-testid^="changes-repo-/"]')].map((el) => el.dataset.testid));
}

async function openAuthDiff(page) {
  await openChanges(page);
  await fileRow(page, '/feat-login', 'src/auth.js').click();
  await expect(page.getByTestId('tab-diff:p1:/feat-login:src/auth.js')).toBeVisible();
  await expect(page.getByTestId('diff-pane')).toBeVisible();
  const diff = page.getByTestId('diff-editor').locator('.monaco-diff-editor');
  await expect(diff).toBeVisible({ timeout: 15000 });
  return diff;
}

test.describe('changes panel', () => {
  test.skip(!hasGit(), 'git is not installed');
  test.setTimeout(60000);

  test('the Changes tab badge counts every changed file across worktrees', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    const tab = page.getByTestId('panel-tab-changes');
    await expect(tab).toBeVisible();
    // Fetched on project selection, before the tab is ever opened.
    await expect(tab.locator('.panel-tab__count')).toHaveText('5', { timeout: 15000 });
  });

  test('lists one group per worktree with branch chips and counts, clean last', async ({ page }) => {
    await openChanges(page);

    expect(await groupOrder(page)).toHaveLength(3);
    expect((await groupOrder(page))[2]).toBe('changes-repo-/main');

    const feat = repoHeader(page, '/feat-login');
    await expect(feat.locator('.changes-panel__branch-text')).toHaveText('feat/login');
    await expect(feat.locator('.changes-panel__count')).toHaveText('4');
    await expect(feat).toHaveAttribute('aria-expanded', 'true');

    const fix = repoHeader(page, '/fix-timeouts');
    await expect(fix.locator('.changes-panel__branch-text')).toHaveText('fix/timeouts');
    await expect(fix.locator('.changes-panel__count')).toHaveText('1');

    const main = repoHeader(page, '/main');
    await expect(main.locator('.changes-panel__branch-text')).toHaveText('main');
    await expect(main.locator('.changes-panel__count')).toHaveText('clean');
    await expect(main).toHaveAttribute('aria-expanded', 'false');

    const letter = (repo, file) => fileRow(page, repo, file).locator('.changes-panel__status');
    await expect(letter('/feat-login', 'src/auth.js')).toHaveText('M');
    await expect(letter('/feat-login', 'src/token-store.js')).toHaveText('A');
    await expect(letter('/feat-login', 'old-session.js')).toHaveText('D');
    await expect(letter('/feat-login', 'notes.md')).toHaveText('?');
    await expect(letter('/fix-timeouts', 'lib/relay-client.js')).toHaveText('M');
    await expect(fileRow(page, '/feat-login', 'src/auth.js').locator('.changes-panel__dir')).toContainText('src/');
  });

  test('collapsing a group persists across a reload', async ({ page }) => {
    await openChanges(page);
    await repoHeader(page, '/feat-login').click();
    await expect(repoHeader(page, '/feat-login')).toHaveAttribute('aria-expanded', 'false');
    await expect(fileRow(page, '/feat-login', 'src/auth.js')).toHaveCount(0);

    await page.reload();
    await openChanges(page);
    await expect(repoHeader(page, '/feat-login')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the scope toggle switches between uncommitted and vs base', async ({ page }) => {
    await openChanges(page);
    const committed = fileRow(page, '/feat-login', 'routes/session.js');
    await expect(committed).toHaveCount(0);

    await page.getByTestId('changes-scope-base').click();
    await expect(page.getByTestId('changes-scope-base')).toHaveAttribute('aria-pressed', 'true');
    await expect(committed).toBeVisible({ timeout: 15000 });
    await expect(committed.locator('.changes-panel__status')).toHaveText('A');
    expect(await page.evaluate(() => localStorage.getItem('eve-changes-scope'))).toBe('base');

    await page.getByTestId('changes-scope-uncommitted').click();
    await expect(committed).toHaveCount(0);
    await expect(fileRow(page, '/feat-login', 'notes.md')).toBeVisible();
  });

  test('the header refresh re-requests the list', async ({ page }) => {
    await openChanges(page);
    const sent = await page.evaluate(async () => {
      const rawWs = window.client.wsClient.ws;
      const original = rawWs.send.bind(rawWs);
      const frames = [];
      rawWs.send = (m) => { frames.push(JSON.parse(m)); return original(m); };
      document.querySelector('[data-testid="changes-refresh"]').click();
      await new Promise((r) => setTimeout(r, 300));
      rawWs.send = original;
      return frames.filter((f) => f.type === 'git_changes');
    });
    expect(sent).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  test('clicking a file opens the diff pane with a rendered Monaco diff', async ({ page }) => {
    const diff = await openAuthDiff(page);
    await expect(diff.locator('.editor.modified .view-lines')).toContainText('await', { timeout: 10000 });
    await expect(diff.locator('.editor.original .view-lines')).toContainText('read()');

    // Re-clicking the row focuses the same tab instead of opening another.
    await fileRow(page, '/feat-login', 'src/auth.js').click();
    await expect(page.locator('[data-testid^="tab-diff:"]')).toHaveCount(1);
  });

  test('a C# file opens in the diff pane with a csharp model', async ({ page }) => {
    await openChanges(page);
    await page.getByTestId('changes-scope-base').click();
    const row = fileRow(page, '/feat-login', 'src/Program.cs');
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page.getByTestId('diff-editor').locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() =>
      window.monaco.editor.getModels().map((m) => m.getLanguageId())), { timeout: 10000 })
      .toContain('csharp');
  });

  test('Side by side and Inline toggle the diff layout and persist', async ({ page }) => {
    const diff = await openAuthDiff(page);
    await expect(diff).toHaveClass(/side-by-side/);

    await page.getByTestId('diff-mode-inline').click();
    await expect(diff).not.toHaveClass(/side-by-side/);
    await expect(page.getByTestId('diff-mode-inline')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('eve-diff-mode'))).toBe('inline');

    await page.getByTestId('diff-mode-side-by-side').click();
    await expect(diff).toHaveClass(/side-by-side/);
    expect(await page.evaluate(() => localStorage.getItem('eve-diff-mode'))).toBe('side-by-side');
  });

  test('File opens the working-tree file in the editor', async ({ page }) => {
    await openAuthDiff(page);
    await page.getByTestId('diff-mode-file').click();
    await expect(page.getByTestId('tab-p1:/feat-login/src/auth.js')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#editor')).not.toHaveClass(/hidden/);
  });

  test('a deleted file disables File', async ({ page }) => {
    await openChanges(page);
    await fileRow(page, '/feat-login', 'old-session.js').click();
    await expect(page.getByTestId('tab-diff:p1:/feat-login:old-session.js')).toBeVisible();
    await expect(page.getByTestId('diff-mode-file')).toBeDisabled();
  });

  test('an edit on disk updates the list without a manual refresh', async ({ page, eve }) => {
    await openChanges(page);
    const readme = path.join(eve.projectDir, 'main', 'README.md');
    const row = fileRow(page, '/main', 'README.md');
    await expect(row).toHaveCount(0);

    // Re-touch each round: the recursive watcher can miss the very first
    // event right after it starts.
    let n = 0;
    await expect(async () => {
      fs.writeFileSync(readme, `# Worktree fixture\nedit ${++n}\n`, 'utf8');
      await expect(row).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });

    await expect(repoHeader(page, '/main').locator('.changes-panel__count')).toHaveText('1');
    await expect(page.getByTestId('panel-tab-changes').locator('.panel-tab__count')).toHaveText('6');
  });

  test('a new untracked file in a worktree appears without a manual refresh', async ({ page, eve }) => {
    await openChanges(page);
    const row = fileRow(page, '/fix-timeouts', 'lib/retry.js');
    let n = 0;
    await expect(async () => {
      write(path.join(eve.projectDir, 'fix-timeouts'), 'lib/retry.js', `module.exports = ${++n};\n`);
      await expect(row).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    await expect(row.locator('.changes-panel__status')).toHaveText('?');
    await expect(repoHeader(page, '/fix-timeouts').locator('.changes-panel__count')).toHaveText('2');
  });
});
