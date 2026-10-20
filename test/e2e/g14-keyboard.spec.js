const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

function thread(id, name) {
  return {
    id,
    project_id: 'p_acme',
    name,
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: `question in ${name}` }, { role: 'assistant', text: `answer in ${name}` }],
  };
}

function tabsWorld() {
  const w = worlds.base();
  w.sessions = [thread('s_a1', 'Ledger'), thread('s_a2', 'Roadmap')];
  return w;
}

// Setup, by mouse: the Project page tab, then two thread tabs. Roadmap ends up selected.
async function openThreeTabs(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
  await expect(page.getByRole('tab', { name: 'Ledger', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Acme', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Acme', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Roadmap', exact: true }).first().click();
  await expect(page.getByRole('tab', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-selected', 'true');
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

const tab = (page, name) => page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { name, exact: true });

// Focus is outside the tab bar: no tab and no button (a tab's Close) inside tablist "Open tabs" has it.
async function expectFocusOutsideTabBar(page) {
  const bar = page.getByRole('tablist', { name: 'Open tabs' });
  for (const role of ['tab', 'button']) {
    for (const el of await bar.getByRole(role).all()) {
      await expect(el).not.toBeFocused();
    }
  }
}

test.describe('tab bar keyboard', () => {
  test.use({ world: tabsWorld() });

  test('Tab enters the tab bar at the selected tab and one more Tab leaves it @G14.45', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Roadmap'));
    await page.keyboard.press('Tab');
    await expectFocusOutsideTabBar(page);
    await page.keyboard.press('Shift+Tab');
    await expect(tab(page, 'Roadmap')).toBeFocused();
  });

  test('Right, Left, Home and End move focus and wrap without selecting @G14.45', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Roadmap'));
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Acme')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'Roadmap')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab(page, 'Acme')).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab(page, 'Roadmap')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'Ledger')).toBeFocused();
    await expect(tab(page, 'Roadmap')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Ledger')).toHaveAttribute('aria-selected', 'false');
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'false');
  });

  test('Return selects the focused tab @G14.45', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Roadmap'));
    await page.keyboard.press('Home');
    await expect(tab(page, 'Acme')).toBeFocused();
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Roadmap')).toHaveAttribute('aria-selected', 'false');
  });

  test('Space selects the focused tab @G14.45', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Roadmap'));
    await page.keyboard.press('Home');
    await expect(tab(page, 'Acme')).toBeFocused();
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Space');
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Roadmap')).toHaveAttribute('aria-selected', 'false');
  });

  test('Delete closes the focused tab and focus lands on the selected one @G14.46', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Roadmap'));
    await page.keyboard.press('Delete');
    await expect(tab(page, 'Roadmap')).toHaveCount(0);
    const selected = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab', { selected: true });
    await expect(selected).toHaveCount(1);
    await expect(selected).toBeFocused();
  });

  test('Backspace closes the focused tab and focus lands on the selected one @G14.46', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Roadmap'));
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'Ledger')).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(tab(page, 'Ledger')).toHaveCount(0);
    await expect(tab(page, 'Roadmap')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Roadmap')).toBeFocused();
  });

  test('Backspace after a mouse click on a tab label leaves the tab open @G14.46', async ({ eve, page }) => {
    await openThreeTabs(eve, page);
    // The Project page tab's pane leaves focus on the clicked label, so Backspace reaches the label.
    await tab(page, 'Acme').click();
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Acme')).toBeFocused();
    await page.keyboard.press('Backspace');
    // The label had focus when Backspace went down (asserted above); a keyboard close would have removed it.
    await expect(tab(page, 'Acme')).toBeVisible();
    await expect(tab(page, 'Acme')).toHaveCount(1);
    await expect(tab(page, 'Ledger')).toHaveCount(1);
    await expect(tab(page, 'Roadmap')).toHaveCount(1);
    await expect(tab(page, 'Acme')).toHaveAttribute('aria-selected', 'true');
  });
});

function terminalWorld() {
  const w = tabsWorld();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  return w;
}

test.describe('tab bar keyboard with a terminal tab', () => {
  test.use({ world: terminalWorld() });

  test('Delete on the selected thread tab selects the terminal tab and focuses the tab, not the terminal input @G14.46', async ({ eve, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'Project page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
    await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
    await expect(tab(page, 'Ledger')).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'New Session' }).click();
    const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
    await expect(launcher).toBeVisible();
    await launcher.getByRole('button', { name: 'Shell' }).click();
    await expect(tab(page, 'Acme - Shell')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'Ledger').click();
    await expect(tab(page, 'Ledger')).toHaveAttribute('aria-selected', 'true');
    await rail(page).getByRole('button', { name: 'Acme' }).focus();
    await tabTo(page, tab(page, 'Ledger'));
    await page.keyboard.press('Delete');
    await expect(tab(page, 'Ledger')).toHaveCount(0);
    await expect(tab(page, 'Acme - Shell')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Acme - Shell')).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).not.toBeFocused();
  });
});
