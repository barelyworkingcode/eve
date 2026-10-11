const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
// The Rail and the Project panel share one complementary region.
const menu = (page) => page.getByRole('complementary');
const openMenu = (page) => page.getByRole('button', { name: 'Open menu' });
const closeMenu = (page) => page.getByRole('button', { name: 'Close menu' });
const bottomBar = (page) => page.getByRole('navigation', { name: 'Navigation' });

function menuWorld() {
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
  await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
  await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
}

async function openTheMenu(page) {
  await openMenu(page).click();
  // Ratio 1 is the signal that the slide-in has finished, so a box read after it is the settled one.
  await expect(menu(page)).toBeInViewport({ ratio: 1 });
  await expect(closeMenu(page)).toBeVisible();
}

test.describe('menu at tablet width', () => {
  test.use({ ...profiles.tablet, world: menuWorld() });

  test('open the menu on Today @G14.7', async ({ eve, page }) => {
    await eve.open('/');
    await expect(menu(page)).not.toBeInViewport();
    await openTheMenu(page);
    await expect(rail(page)).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeInViewport();
  });

  test('open the menu from a thread header @G14.8', async ({ eve, page }) => {
    await eve.open('/');
    await openLedger(page);
    await expect(menu(page)).not.toBeInViewport();
    await openTheMenu(page);
    await expect(rail(page)).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeInViewport();
  });

  test('close the menu with its close button @G14.9', async ({ eve, page }) => {
    await eve.open('/');
    await openTheMenu(page);
    await closeMenu(page).click();
    await expect(menu(page)).not.toBeInViewport();
    await expect(rail(page)).not.toBeInViewport();
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  });

  test('close the menu by tapping the dimmed area @G14.10', async ({ eve, page }) => {
    await eve.open('/');
    await openTheMenu(page);
    const box = await menu(page).boundingBox();
    const size = page.viewportSize();
    expect(box.x + box.width).toBeLessThan(size.width - 20);
    await page.touchscreen.tap(box.x + box.width + 20, size.height / 2);
    await expect(menu(page)).not.toBeInViewport();
  });

  test('close the menu by swiping left @G14.12', async ({ eve, page, touch }) => {
    await eve.open('/');
    await openTheMenu(page);
    await touch.swipe(page.getByRole('button', { name: 'Files', exact: true }), { dx: -150, dy: 0 });
    await expect(menu(page)).not.toBeInViewport();
  });
});

test.describe('menu at phone width', () => {
  test.use({ ...profiles.phone, world: menuWorld() });

  test('the menu is a full-screen sheet with no dimmed area @G14.10', async ({ eve, page }) => {
    await eve.open('/');
    await bottomBar(page).getByRole('button', { name: 'Projects' }).click();
    await expect(menu(page)).toBeInViewport({ ratio: 1 });
    const box = await menu(page).boundingBox();
    const size = page.viewportSize();
    expect(box.x).toBeLessThanOrEqual(0);
    expect(box.x + box.width).toBeGreaterThanOrEqual(size.width);
    await closeMenu(page).click();
    await expect(menu(page)).not.toBeInViewport();
  });
});

test.describe('menu panel width', () => {
  test.use({ world: menuWorld() });

  // The sidebar (Rail and Project panel together) is the box the row's 200 to 600 pixels measure.
  async function panelWidth(page) {
    return (await menu(page).boundingBox()).width;
  }

  async function dragEdge(page, dx) {
    const box = await menu(page).boundingBox();
    // The drag handle sits just outside the panel's right edge.
    const x = box.x + box.width + 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 6 });
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
  }

  test('drag the panel edge wider and narrower and keep it @G14.13', async ({ eve, page }) => {
    await eve.open('/');
    await expect(menu(page)).toBeInViewport();
    const start = await panelWidth(page);

    await dragEdge(page, 60);
    await expect.poll(() => panelWidth(page)).toBeGreaterThan(start + 40);
    const wider = await panelWidth(page);

    await eve.reload();
    await expect.poll(() => panelWidth(page)).toBeCloseTo(wider, 0);

    await dragEdge(page, -2000);
    await expect.poll(() => panelWidth(page)).toBeLessThan(wider);
    await expect.poll(async () => Math.round(await panelWidth(page))).toBe(200);

    await dragEdge(page, 2000);
    await expect.poll(async () => Math.round(await panelWidth(page))).toBe(600);
  });
});
