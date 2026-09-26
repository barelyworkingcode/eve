// A chat template with a blank model can't be saved, and launching one that
// already exists tells the user to pick a model instead of creating a session.
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');
const { hermeticTest, gotoEve } = require('./fixtures');

const { expect } = base;

const MODELS = {
  models: [{ label: 'Chat A', value: 'chat-a', group: 'Broker', provider: 'chat' }],
  providerSettings: { chat: [] },
};
const TEMPLATES = [
  { id: 't-ok', name: 'Ready', model: 'chat-a', mode: 'text', voice: '', system_prompt: '' },
  { id: 't-blank', name: 'Blank', model: '', mode: 'text', voice: '', system_prompt: '' },
  { id: 't-space', name: 'Spaces', model: '   ', mode: 'text', voice: '', system_prompt: '' },
];

const test = hermeticTest.extend({
  modelsPayload: [MODELS, { option: true }],
  eve: async ({ modelsPayload }, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-blank-model-'));
    const eve = await startEve({ projects: [{ id: 'p1', name: 'Acme', path: dir, chat_templates: TEMPLATES }], models: modelsPayload });
    try { await use(eve); } finally { await eve.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  },
});

async function openTemplatesTab(page, eve) {
  await gotoEve(page, eve.baseUrl);
  await page.evaluate(() => window.client._modelsReady);
  await page.waitForFunction(() => window.client.projects.has('p1'));
  await page.evaluate(() => window.client.bus.emit('dialog:project', { projectId: 'p1' }));
  const dialog = page.getByTestId('dialog-project-dialog');
  await dialog.locator('.dialog__tab[data-tab="templates"]').click();
  return dialog;
}

const projectPuts = (eve) => eve.relay.requests.filter((r) => r.method === 'PUT' && r.path === '/api/projects/p1');
const noModelToast = (page, name) => page.locator('.toast--error').filter({ hasText: `Pick a model for "${name}" before starting a chat.` });

async function expectNoSessionCreated(eve) {
  await new Promise((r) => setTimeout(r, 750));
  expect(eve.relay.sessionCreates).toHaveLength(0);
}

test.describe('template editor with no models discovered', () => {
  test.use({ modelsPayload: { models: [], providerSettings: {} } });

  test('Save Template refuses a blank model, and the project save leaves it out', async ({ page, eve }) => {
    const dialog = await openTemplatesTab(page, eve);
    await dialog.getByRole('button', { name: '+ Add Template' }).click();
    const form = dialog.locator('.project-dialog__template-form');
    await form.locator('input[type="text"]').first().fill('Fresh');
    await form.getByRole('button', { name: 'Save Template' }).click();

    await expect(dialog.locator('.project-dialog__error')).toHaveText('Pick a model for this template.');
    await expect(form).toBeVisible();

    await form.getByRole('button', { name: 'Back' }).click();
    await expect(dialog.locator('.project-dialog__template-name').filter({ hasText: 'Fresh' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => projectPuts(eve).length).toBe(1);
    expect(eve.relay.getProject('p1').chat_templates).toEqual(TEMPLATES);
  });
});

test.describe('blank-model templates', () => {
  test('saving dirty templates is refused while one has no model', async ({ page, eve }) => {
    const dialog = await openTemplatesTab(page, eve);
    await dialog.locator('.project-dialog__template-item').first().getByTitle('Edit').click();
    await dialog.getByRole('button', { name: 'Save Template' }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(dialog.locator('.project-dialog__error')).toContainText('Template "Blank" has no model. Pick one before saving.');
    await expect(dialog).toBeVisible();
    await new Promise((r) => setTimeout(r, 750));
    expect(projectPuts(eve)).toHaveLength(0);
    expect(eve.relay.getProject('p1').chat_templates).toEqual(TEMPLATES);
  });

  for (const [id, name] of [['t-blank', 'Blank'], ['t-space', 'Spaces']]) {
    test(`the launcher card for ${id} shows "pick a model" and creates no session`, async ({ page, eve }) => {
      await gotoEve(page, eve.baseUrl);
      await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(1);
      await page.getByTestId('sidebar-project-p1').click();
      await page.getByTestId('sidebar-new-session-p1').click();
      await page.getByTestId(`shell-card-template-${id}`).click();

      await expect(noModelToast(page, name)).toBeVisible();
      await expect(page.getByTestId('dialog-shell-launcher-dialog')).toBeVisible();
      await expectNoSessionCreated(eve);
    });
  }

  test('a cold #/voice-chat load of a blank-model favourite shows "pick a model" and creates no session', async ({ page, eve }) => {
    await page.addInitScript(() => localStorage.setItem('eve-settings', JSON.stringify({
      palettes: {}, themeMode: 'dark', favoriteTemplate: { projectId: 'p1', templateId: 't-blank' },
    })));
    await gotoEve(page, `${eve.baseUrl}/#/voice-chat`);

    await expect(noModelToast(page, 'Blank')).toBeVisible({ timeout: 10000 });
    await expectNoSessionCreated(eve);
  });
});
