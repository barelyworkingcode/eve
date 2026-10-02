// The project dialog must not rebuild its inputs when the host list arrives
// late: a typed name, the input node and a Save click all survive.
const { test, expect } = require('./fixture');

const isPost = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/projects';
const isPut = (r) => r.method() === 'PUT' && new URL(r.url()).pathname === '/api/projects/beta';

// Holds the next /api/hosts response until release() is called. `changed`
// answers with a different list than the one the page already knows.
async function holdHosts(page, { changed }) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/hosts', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    await gate;
    if (!changed) return route.fulfill({ response: real });
    const list = await real.json();
    return route.fulfill({ json: [...list.map((h) => ({ ...h, name: `${h.name} renamed` })), { id: 'h2', name: 'Other box' }] });
  });
  return release;
}

async function openEdit(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Beta Project', { exact: true }).click();
  await page.getByTestId('sidebar-project-more-beta').click();
  await page.getByText('Edit Project', { exact: true }).click();
}

test.describe('project dialog while hosts load', () => {
  test.use({ world: { hosts: [{ id: 'h1', name: 'Acme box' }] } });

  for (const changed of [true, false]) {
    const label = changed ? 'a different host list' : 'an identical host list';

    test(`Edit Project keeps the typed name, the input node and Save with ${label}`, async ({ page, eve }) => {
      const release = await holdHosts(page, { changed });
      const hostsResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/hosts');
      await openEdit(page);
      const name = page.getByTestId('project-name');
      await expect(name).toHaveValue('Beta Project');
      await name.evaluate((el) => { el.dataset.sentinel = 'same'; });
      await name.fill('Beta Renamed');
      release();
      await hostsResponse;
      if (changed) await expect(page.getByTestId('project-where-host-h2')).toBeVisible();
      await expect(name).toHaveValue('Beta Renamed');
      await expect(name).toHaveAttribute('data-sentinel', 'same');
      const [request] = await Promise.all([page.waitForRequest(isPut), page.getByTestId('project-save').click()]);
      expect(request.postDataJSON()).toMatchObject({ name: 'Beta Renamed' });
      await expect(page.getByTestId('project-save')).toBeHidden();
      await expect.poll(() => eve.relay.getProject('beta').name).toBe('Beta Renamed');
    });

    test(`New Project keeps the typed name and path and creates with ${label}`, async ({ page, eve }) => {
      const release = await holdHosts(page, { changed });
      const hostsResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/hosts');
      await page.getByTestId('home-new-project').click();
      const name = page.getByTestId('project-name');
      const pathInput = page.getByTestId('project-path');
      await name.evaluate((el) => { el.dataset.sentinel = 'same'; });
      await name.fill('Gamma Project');
      await pathInput.fill(eve.folders.alpha);
      release();
      await hostsResponse;
      if (changed) await expect(page.getByTestId('project-where-host-h2')).toBeVisible();
      await expect(name).toHaveValue('Gamma Project');
      await expect(pathInput).toHaveValue(eve.folders.alpha);
      await expect(name).toHaveAttribute('data-sentinel', 'same');
      const [request] = await Promise.all([page.waitForRequest(isPost), page.getByTestId('project-save').click()]);
      expect(request.postDataJSON()).toMatchObject({ name: 'Gamma Project', path: eve.folders.alpha });
    });
  }
});
