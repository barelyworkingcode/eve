// Non-Claude web/voice chats start with relay tools + CLAUDE.md, Claude chats
// with neither, and no launcher or template option controls it.
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');
const { hermeticTest } = require('./fixtures');

const { expect } = base;

// Relay's real GET /api/models shape; relay still advertises the chat toggle.
const MODELS = {
  models: [
    { label: 'Chat A', value: 'chat-a', group: 'Broker', provider: 'chat' },
    { label: 'Claude Sonnet', value: 'sonnet', group: 'Claude', provider: 'claude' },
  ],
  providerSettings: { chat: [{ key: 'useRelayTools', label: 'Use Relay Tools', type: 'boolean', default: false }], claude: [] },
};
const TEMPLATES = [
  { id: 't-chat', name: 'Chat Plain', model: 'chat-a', mode: 'text', voice: '', system_prompt: '' },
  { id: 't-claude', name: 'Claude Stale', model: 'sonnet', mode: 'text', voice: '', system_prompt: '', append_claude_md: true, use_relay_tools: true },
];

const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-defaults-'));
    const eve = await startEve({ projects: [{ id: 'p1', name: 'Acme', path: dir, chat_templates: TEMPLATES }], models: MODELS });
    try { await use(eve); } finally { await eve.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  },
});

async function openLauncher(page, eve) {
  await page.goto(eve.baseUrl);
  await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(2);
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
}

async function expectNoChatOptions(scope) {
  await expect(scope.getByText(/Use Relay Tools|Append CLAUDE\.md/i)).toHaveCount(0);
  await expect(scope.locator('input[type="checkbox"]')).toHaveCount(0);
}

async function relayedCreate(eve) {
  await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 10000 }).toBe(1);
  return eve.relay.sessionCreates[0];
}

const expectFlags = (body, on) => {
  expect(body.appendClaudeMd).toBe(on);
  expect(body.settings?.useRelayTools).toBe(on ? true : undefined);
};

test.describe('chat defaults', () => {
  for (const [model, on] of [['chat-a', true], ['sonnet', false]]) {
    test(`launcher form shows neither option; ${model} sends ${on ? 'both flags' : 'neither'}`, async ({ page, eve }) => {
      await openLauncher(page, eve);
      await page.getByTestId('shell-card-web-chat').click();
      await page.getByTestId('launcher-model-select').selectOption(model);
      await expectNoChatOptions(page.getByTestId('dialog-shell-launcher-dialog'));
      await page.getByRole('button', { name: 'Start Chat' }).click();
      expectFlags(await relayedCreate(eve), on);
    });
  }

  for (const [id, on] of [['t-chat', true], ['t-claude', false]]) {
    test(`template ${id} sends ${on ? 'both flags' : 'neither'}`, async ({ page, eve }) => {
      await openLauncher(page, eve);
      await page.getByTestId(`shell-card-template-${id}`).click();
      expectFlags(await relayedCreate(eve), on);
    });
  }

  test('the favourite launch waits for models, then sends both flags', async ({ page, eve }) => {
    await page.addInitScript(() => localStorage.setItem('eve-settings', JSON.stringify({
      palettes: {}, themeMode: 'dark', favoriteTemplate: { projectId: 'p1', templateId: 't-chat' },
    })));
    const hold = eve.relay.holdModels();
    await page.goto(eve.baseUrl);
    // Fired as a hashchange: a hash present at cold load is dropped by the
    // app's URL syncing before the route handler runs.
    await page.waitForFunction(() => window.client?._hashListenerAdded && window.client.projects.has('p1'));
    for (let press = 0; press < 2; press++) {
      await page.evaluate(() => { window.location.hash = '#/voice-chat'; });
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
    }
    await page.waitForTimeout(500);
    expect(eve.relay.sessionCreates).toHaveLength(0);
    hold.release();
    const body = await relayedCreate(eve);
    await page.waitForTimeout(500);
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(body.model).toBe('chat-a');
    expectFlags(body, true);
  });

  test('the template editor shows neither checkbox, and saved templates carry neither key', async ({ page, eve }) => {
    await openLauncher(page, eve);
    await page.evaluate(() => window.client.bus.emit('dialog:project', { projectId: 'p1' }));
    const dialog = page.getByTestId('dialog-project-dialog');
    await dialog.locator('.dialog__tab[data-tab="templates"]').click();
    await dialog.getByRole('button', { name: '+ Add Template' }).click();
    const form = dialog.locator('.project-dialog__template-form');
    for (const model of ['chat-a', 'sonnet']) {
      await form.locator('select').first().selectOption(model);
      await expectNoChatOptions(form);
    }
    await form.locator('input[type="text"]').first().fill('Fresh');
    await form.getByRole('button', { name: 'Save Template' }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => eve.relay.getProject('p1').chat_templates.length).toBe(TEMPLATES.length + 1);
    for (const t of eve.relay.getProject('p1').chat_templates) {
      expect(Object.keys(t).sort()).toEqual(['id', 'mode', 'model', 'name', 'system_prompt', 'voice']);
    }
  });
});
