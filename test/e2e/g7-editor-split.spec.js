const { test, expect } = require('./support/fixtures');

async function openSplit(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const divider = page.getByRole('separator', { name: 'Resize editor and preview' });
  await expect(divider).toBeVisible();
  return divider;
}

async function paneWidths(page) {
  const editor = await page.getByRole('region', { name: 'Editor pane' }).boundingBox();
  const preview = await page.getByRole('region', { name: 'Preview pane' }).boundingBox();
  return { editor: editor.width, preview: preview.width };
}

// The mousemove handler sets the widths synchronously, so they are read once
// the button is up.
async function dragDividerTo(page, divider, x) {
  const box = await divider.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.up();
}

test('drag the divider to resize the editor and preview @G7.11', async ({ eve, page }) => {
  await eve.open('/');
  const divider = await openSplit(page);
  const before = await paneWidths(page);
  const box = await divider.boundingBox();

  await dragDividerTo(page, divider, box.x + box.width / 2 - 120);
  const narrower = await paneWidths(page);
  expect(narrower.editor).toBeLessThan(before.editor);
  expect(narrower.preview).toBeGreaterThan(before.preview);
  expect(narrower.editor).toBeGreaterThanOrEqual(200);
  expect(narrower.preview).toBeGreaterThanOrEqual(200);
});

test('neither pane goes under 200 pixels @G7.11', async ({ eve, page }) => {
  await eve.open('/');
  const divider = await openSplit(page);
  const before = await paneWidths(page);

  await dragDividerTo(page, divider, 0);
  const farLeft = await paneWidths(page);
  expect(farLeft.editor).toBeLessThan(before.editor);
  expect(farLeft.editor).toBeGreaterThanOrEqual(200);
  expect(farLeft.preview).toBeGreaterThanOrEqual(200);

  await dragDividerTo(page, divider, 1279);
  const farRight = await paneWidths(page);
  expect(farRight.editor).toBeGreaterThan(farLeft.editor);
  expect(farRight.editor).toBeGreaterThanOrEqual(200);
  expect(farRight.preview).toBeGreaterThanOrEqual(200);
});
