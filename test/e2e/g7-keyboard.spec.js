const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function treeWorld() {
  const w = worlds.base();
  w.projects[0].files = {
    'docs/alpha.txt': 'alpha text\n',
    'docs/beta.txt': 'beta text\n',
    'notes.txt': 'notes text\n',
    'todo.txt': 'todo text\n',
  };
  return w;
}

async function isFocused(locator) {
  try {
    await expect(locator).toBeFocused({ timeout: 100 });
    return true;
  } catch {
    return false;
  }
}

// A bounded Tab walk: at most 80 presses, stops on the target, fails otherwise.
async function tabTo(page, target) {
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press('Tab');
    if (await isFocused(target)) return;
  }
  await expect(target).toBeFocused();
}

const tree = (page) => page.getByRole('tree', { name: 'Files' });
const item = (page, name) => tree(page).getByRole('treeitem', { name, exact: true });

async function openFiles(eve, page) {
  await eve.open('/');
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(item(page, 'docs')).toBeVisible();
  await expect(item(page, 'todo.txt')).toBeVisible();
}

// Starts a walk at the Files button and stops on the first row.
async function reachTree(page) {
  await page.getByRole('button', { name: 'Files', exact: true }).focus();
  await tabTo(page, item(page, 'docs'));
}

test.describe('file tree keyboard', () => {
  test.use({ world: treeWorld() });

  test('Tab enters the tree and one more Tab leaves it @G7.35', async ({ eve, page }) => {
    await openFiles(eve, page);
    await reachTree(page);
    await page.keyboard.press('Tab');
    for (const name of ['docs', 'notes.txt', 'todo.txt']) {
      await expect(item(page, name)).not.toBeFocused();
    }
  });

  test('Down, Up, Home and End move between rows @G7.35', async ({ eve, page }) => {
    await openFiles(eve, page);
    await reachTree(page);
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'notes.txt')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'todo.txt')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'notes.txt')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item(page, 'todo.txt')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item(page, 'docs')).toBeFocused();
  });

  test('Right opens a folder, then goes to its first child; Left goes to the parent, then closes it @G7.35', async ({ eve, page, relay }) => {
    await openFiles(eve, page);
    await reachTree(page);
    const since = relay.mark();
    await page.keyboard.press('ArrowRight');
    await expect(item(page, 'alpha.txt')).toBeVisible();
    await expect(item(page, 'docs')).toBeFocused();
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await relay.waitForEvent('file.list', { since, match: (l) => l.status === 'ok' });
    await page.keyboard.press('ArrowRight');
    await expect(item(page, 'alpha.txt')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item(page, 'docs')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'alpha.txt')).toHaveCount(0);
    await expect(item(page, 'docs')).toBeFocused();
  });

  test('Return on a file opens its tab @G7.35', async ({ eve, page }) => {
    await openFiles(eve, page);
    await reachTree(page);
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'notes.txt')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('notes text')).toBeVisible();
  });
});
