const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function approving() {
  const w = worlds.base();
  w.presence = { 'project.grant': 'approve' };
  return w;
}

function withHost() {
  const w = approving();
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash' },
    agent: 'connected',
  }];
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

test.describe('a project on a host', () => {
  test.use({ world: withHost() });

  test('put the project on an SSH host @G12.7', async ({ eve, page }) => {
    await openNew(eve, page);
    const mac = page.getByRole('button', { name: 'This Mac' });
    const host = page.getByRole('button', { name: /testbox/ });
    await expect(mac).toHaveAttribute('aria-pressed', 'true');
    await expect(host).toHaveAttribute('aria-pressed', 'false');
    await host.click();
    await expect(page.getByRole('textbox', { name: 'Path on testbox' })).toBeVisible();
    await expect(host).toHaveAttribute('aria-pressed', 'true');
    await expect(mac).toHaveAttribute('aria-pressed', 'false');
  });

  test('keep the project on this Mac @G12.6', async ({ eve, page }) => {
    await openNew(eve, page);
    const mac = page.getByRole('button', { name: 'This Mac' });
    const host = page.getByRole('button', { name: /testbox/ });
    await host.click();
    await expect(page.getByRole('textbox', { name: 'Path on testbox' })).toBeVisible();
    await mac.click();
    await expect(page.getByRole('textbox', { name: 'Directory Path' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Path on testbox' })).toBeHidden();
    await expect(mac).toHaveAttribute('aria-pressed', 'true');
    await expect(host).toHaveAttribute('aria-pressed', 'false');
  });
});
