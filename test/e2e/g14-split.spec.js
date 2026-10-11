const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });
const UNDOCK = 'Undock this pane (move it to its own tab)';

function splitWorld() {
  const w = worlds.base();
  const png = { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
  w.projects[0].files['one.png'] = png;
  w.projects[0].files['two.png'] = png;
  w.sessions = [
    { id: 's_a1', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'dormant', messages: [{ role: 'user', text: 'question in Ledger' }, { role: 'assistant', text: 'answer in Ledger' }] },
    { id: 's_a2', project_id: 'p_acme', name: 'Roadmap', model: 'haiku', state: 'dormant', messages: [{ role: 'user', text: 'question in Roadmap' }, { role: 'assistant', text: 'answer in Roadmap' }] },
  ];
  return w;
}

// A thread tab and a file tab are different views, so they can share the content area.
async function openThreadAndFile(page) {
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
  await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('treeitem', { name: 'README.md' }).click();
  await expect(page.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true');
}

// Pointer drag of a tab onto the right edge of the content area.
async function dragTabToRightEdge(page, tab) {
  const from = await tab.boundingBox();
  const area = await page.getByRole('main').boundingBox();
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 20, startY + 20, { steps: 4 });
  await page.mouse.move(area.x + area.width - 20, area.y + area.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function split(page) {
  await openThreadAndFile(page);
  await dragTabToRightEdge(page, page.getByRole('tab', { name: 'Ledger' }));
  await expect(page.getByRole('button', { name: UNDOCK })).toHaveCount(2);
}

test.describe('split panes', () => {
  test.use({ world: splitWorld() });

  test('drag a tab onto an edge to show two panes @G14.4', async ({ eve, page }) => {
    await eve.open('/');
    await split(page);
    await expect(page.getByText('answer in Ledger')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  test('a second tab on the same view opens no second pane @G14.4.r1', async ({ eve, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'Project page' }).click();
    await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Acme', exact: true }).click();
    await page.getByRole('button', { name: 'Roadmap', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'true');
    await dragTabToRightEdge(page, page.getByRole('tab', { name: 'Ledger' }));
    await expect(page.getByRole('button', { name: UNDOCK })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
    // The same drag works once the other tab is a different view, so the drag above was heard and refused.
    await page.getByRole('treeitem', { name: 'README.md' }).click();
    await expect(page.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true');
    await dragTabToRightEdge(page, page.getByRole('tab', { name: 'Ledger' }));
    await expect(page.getByRole('button', { name: UNDOCK })).toHaveCount(2);
  });

  test('two image tabs open no second pane @G14.4.r1', async ({ eve, page }) => {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('treeitem', { name: 'one.png' }).click();
    await expect(page.getByRole('tab', { name: 'one.png' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('treeitem', { name: 'two.png' }).click();
    await expect(page.getByRole('tab', { name: 'two.png' })).toHaveAttribute('aria-selected', 'true');
    await dragTabToRightEdge(page, page.getByRole('tab', { name: 'one.png' }));
    await expect(page.getByRole('button', { name: UNDOCK })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'one.png' })).toBeVisible();
    // The same drag splits once the other tab is a thread, so the drag above was heard and refused.
    await page.getByRole('button', { name: 'Project page' }).click();
    await page.getByRole('button', { name: 'Ledger', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
    await dragTabToRightEdge(page, page.getByRole('tab', { name: 'one.png' }));
    await expect(page.getByRole('button', { name: UNDOCK })).toHaveCount(2);
  });

  test('drag the divider to resize the panes @G14.5', async ({ eve, page }) => {
    await eve.open('/');
    await split(page);
    // Each pane header ends in its Undock button, so the button's right edge marks the pane's right edge.
    const undock = page.getByRole('button', { name: UNDOCK });
    const rightEdge = async (n) => { const b = await undock.nth(n).boundingBox(); return b.x + b.width; };
    const before = await rightEdge(0);
    const y = (await page.getByRole('main').boundingBox()).y + 200;
    await page.mouse.move(before + 4, y);
    await page.mouse.down();
    await page.mouse.move(before + 4 - 150, y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => rightEdge(0)).toBeLessThan(before - 100);
    // Dragging far past either side stops at the minimum pane width of about 140 px.
    const main = await page.getByRole('main').boundingBox();
    const dragTo = async (from, to) => {
      await page.mouse.move(from, y);
      await page.mouse.down();
      await page.mouse.move(to, y, { steps: 10 });
      await page.mouse.up();
    };
    let edge = await rightEdge(0);
    await dragTo(edge + 4, main.x + 5);
    await expect.poll(() => rightEdge(0)).toBeLessThan(main.x + 220);
    expect(await rightEdge(0)).toBeGreaterThan(main.x + 120);
    edge = await rightEdge(0);
    await dragTo(edge + 4, main.x + main.width - 5);
    await expect.poll(() => rightEdge(0)).toBeGreaterThan(main.x + main.width - 220);
    expect(await rightEdge(0)).toBeLessThan(main.x + main.width - 120);
  });

  test('split the panes back into separate tabs @G14.6', async ({ eve, page }) => {
    await eve.open('/');
    await split(page);
    await page.getByRole('button', { name: UNDOCK }).first().click();
    await expect(page.getByRole('button', { name: UNDOCK })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Ledger' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'README.md' })).toBeVisible();
  });
});
