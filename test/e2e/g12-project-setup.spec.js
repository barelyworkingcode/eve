const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function approving() {
  const w = worlds.base();
  w.presence = { 'project.grant': 'approve' };
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

async function openNew(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'New Project' }).click();
  await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
}

test.describe('creating a project', () => {
  test.use({ world: approving() });

  test('open the New Project dialog from the Rail @G12.1', async ({ eve, page }) => {
    await openNew(eve, page);
    await expect(page.getByRole('button', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Templates' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Project Name' })).toBeFocused();
  });
});
