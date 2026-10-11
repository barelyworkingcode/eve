const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

const bottomBar = (page) => page.getByRole('navigation', { name: 'Navigation' });
const menu = (page) => page.getByRole('complementary');
const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const greeting = (page) => page.getByRole('heading', { level: 1, name: /^(Good morning\.|Good afternoon\.|Good evening\.|Working late\.)$/ });
const barButton = (page, name) => bottomBar(page).getByRole('button', { name });

function barWorld() {
  const w = worlds.base();
  w.sessions = [
    {
      id: 's_a1',
      project_id: 'p_acme',
      name: 'Ledger',
      model: 'haiku',
      state: 'dormant',
      messages: [{ role: 'user', text: 'question in Ledger' }, { role: 'assistant', text: 'answer in Ledger' }],
    },
  ];
  return w;
}

async function openLedger(page) {
  // Used by every test below that needs a thread open at phone width.
  await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
}

// Today shows no tab bar, and the bar is hidden at phone width anyway. A tab is still open when the
// Project page (a tab of its own) is opened and the window is widened: the thread's tab is in the bar.
async function expectTabKept(page) {
  await barButton(page, 'Threads').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
}

test.describe('bottom bar on a phone', () => {
  test.use({ ...profiles.phone, world: barWorld() });

  test('Threads opens the Project page of the active project @G14.19', async ({ eve, page }) => {
    await eve.open('/');
    await barButton(page, 'Threads').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
  });

  test('Projects opens the menu sheet with the Rail as a strip on top @G14.20', async ({ eve, page }) => {
    await eve.open('/');
    await expect(menu(page)).not.toBeInViewport();
    await barButton(page, 'Projects').click();
    await expect(menu(page)).toBeInViewport({ ratio: 1 });
    const strip = await rail(page).boundingBox();
    const size = page.viewportSize();
    expect(strip.width).toBeGreaterThanOrEqual(size.width - 1);
    const tree = await page.getByRole('button', { name: 'Files', exact: true }).boundingBox();
    expect(strip.y).toBeLessThan(tree.y);
  });

  test('Back from a thread returns to Today and keeps the tab @G14.23', async ({ eve, page }) => {
    await eve.open('/');
    await openLedger(page);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(greeting(page)).toBeVisible();
    await expect(bottomBar(page)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await expectTabKept(page);
  });

  test('the browser Back button returns to Today and keeps the tab @G14.24', async ({ eve, page }) => {
    await eve.open('/');
    await openLedger(page);
    await page.goBack();
    await expect(greeting(page)).toBeVisible();
    await expect(bottomBar(page)).toBeVisible();
    await expectTabKept(page);
  });
});

function noProjectWorld() {
  const w = worlds.base();
  // The only project belongs to Home, so Work mode has none.
  w.projects[0].mode = 'home';
  w.default_project = { home: 'p_acme' };
  return w;
}

test.describe('Threads with no project in the mode', () => {
  test.use({ ...profiles.phone, world: noProjectWorld() });

  test('Threads opens the menu sheet @G14.19', async ({ eve, page }) => {
    await eve.open('/');
    await barButton(page, 'Threads').click();
    await expect(menu(page)).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeHidden();
  });
});

// A model whose reply is a permission prompt keeps a thread waiting on an answer nobody gives.
function waitingWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-ask'];
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
  return w;
}

test.describe('agents that need me', () => {
  test.use({ ...profiles.phone, world: waitingWorld() });

  test('the Today button counts the agents that wait @G14.22', async ({ eve, page }) => {
    await eve.open('/');
    await expect(barButton(page, 'Today')).toBeVisible();
    await expect(barButton(page, 'Today').getByText('need you')).toBeHidden();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const launcher = page.getByRole('dialog', { name: 'Shell Launcher' });
    await launcher.getByRole('combobox', { name: 'Model' }).selectOption('acme-ask');
    await launcher.getByRole('button', { name: 'Start Chat' }).click();
    const box = page.getByRole('textbox', { name: 'Type your message...' });
    await expect(box).toBeEnabled();
    await box.fill('run the thing');
    await box.press('Enter');
    await expect(page.getByRole('heading', { name: 'Permission Request' })).toBeVisible();
    // The prompt covers this page, so a second browser on Today shows the count.
    const other = await eve.openAnother('/');
    await expect(barButton(other, 'Today').getByText('need you')).toBeVisible();
    await expect(barButton(other, 'Today')).toContainText(/1\s*need you/);
  });
});
