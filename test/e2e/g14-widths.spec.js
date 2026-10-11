const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const bottomBar = (page) => page.getByRole('navigation', { name: 'Navigation' });
const openMenu = (page) => page.getByRole('button', { name: 'Open menu' });

function widthsWorld() {
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

test.use({ world: widthsWorld() });

async function openLedger(page) {
  await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
  await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
}

// Content is at most 720 px wide and sits in the middle of the window.
async function expectCentred(page, target) {
  const box = await target.boundingBox();
  const width = page.viewportSize().width;
  expect(box.width).toBeLessThanOrEqual(720);
  expect(Math.abs(box.x - (width - (box.x + box.width)))).toBeLessThanOrEqual(2);
}

test.describe('widths', () => {
  test('desktop width keeps the Rail and panel in view @G14.14', async ({ eve, page }) => {
    await eve.open('/');
    await page.setViewportSize({ width: 1280, height: 800 });
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await expect(rail(page)).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeInViewport();
    await expect(openMenu(page)).toBeHidden();
    await expect(bottomBar(page)).toBeHidden();
    await openLedger(page);
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeInViewport();
  });

  test('tablet width hides the Rail and centres content @G14.15', async ({ eve, page }) => {
    await eve.open('/');
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(openMenu(page)).toBeVisible();
    await expect(rail(page)).not.toBeInViewport();
    const ask = page.getByRole('textbox', { name: 'Ask' });
    await expect(ask).toBeInViewport();
    await expectCentred(page, ask);
    await openLedger(page);
    await expectCentred(page, page.getByRole('textbox', { name: 'Type your message...' }));
  });

  test('phone width shows the bottom bar and no tab bar @G14.16', async ({ eve, page }) => {
    await eve.open('/');
    await openLedger(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bottomBar(page)).toBeInViewport();
    for (const name of ['Chief of Staff', 'Today', 'Threads', 'Projects']) {
      await expect(bottomBar(page).getByRole('button', { name })).toBeVisible();
    }
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeHidden();
    await bottomBar(page).getByRole('button', { name: 'Projects' }).click();
    await expect(rail(page)).toBeInViewport();
    // The Rail and the Project panel share one complementary region; at this width it is a full-screen sheet.
    await expect(page.getByRole('complementary')).toBeInViewport({ ratio: 1 });
    const box = await page.getByRole('complementary').boundingBox();
    const size = page.viewportSize();
    expect(box.x).toBeLessThanOrEqual(0);
    expect(box.x + box.width).toBeGreaterThanOrEqual(size.width);
  });

  test('the Home and Work switch moves to Today at tablet width @G14.17', async ({ eve, page }) => {
    await eve.open('/');
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(openMenu(page)).toBeVisible();
    const group = page.getByRole('radiogroup', { name: 'Mode' });
    await expect(group).toBeInViewport();
    await expect(group.getByRole('radio', { name: 'Home' })).toBeVisible();
    await expect(group.getByRole('radio', { name: 'Work' })).toBeVisible();
  });
});

async function expectBigTargets(page, label) {
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  expect(count, `${label}: buttons`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible())) continue;
    const box = await b.boundingBox();
    const name = (await b.getAttribute('aria-label')) || (await b.innerText());
    // A box of 44 CSS px reads back as 43.99998 after the layout rounds it; 0.1 px only absorbs that.
    expect(box.width, `${label}: "${name}" width`).toBeGreaterThanOrEqual(43.9);
    expect(box.height, `${label}: "${name}" height`).toBeGreaterThanOrEqual(43.9);
  }
}

test.describe('touch size on a phone', () => {
  test.use(profiles.phone);
  test('every control is at least 44 by 44 @G14.25', async ({ eve, page }) => {
    await eve.open('/');
    await expect(bottomBar(page)).toBeVisible();
    await expectBigTargets(page, 'phone Today');
  });
});

test.describe('touch size on a tablet', () => {
  test.use(profiles.tablet);
  test('every control is at least 44 by 44 @G14.25', async ({ eve, page }) => {
    await eve.open('/');
    await expect(openMenu(page)).toBeVisible();
    await expectBigTargets(page, 'tablet Today');
  });
});

test.describe('touch size on a wide window', () => {
  test.use(profiles.tablet);
  test('every control is at least 44 by 44 @G14.25', async ({ eve, page }) => {
    await eve.open('/');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(rail(page)).toBeInViewport();
    await expectBigTargets(page, 'wide Today');
  });
});
