/**
 * Every web or voice chat on a non-Claude model starts with relay tools and
 * CLAUDE.md; Claude chats start with neither. No launcher or template option
 * controls this any more. Asserted twice per launch: on the create_session
 * frame the browser sends, and on the POST /api/sessions body relay receives.
 */
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');

const { expect } = base;

// Relay's real GET /api/models shape. The chat provider's `useRelayTools`
// field is what relay advertises; the launcher must still not show it.
const MODELS = {
  models: [
    { label: 'Chat A', value: 'chat-a', group: 'Broker', provider: 'chat', supportsPermissions: false, supportsAttachments: true },
    { label: 'Pi B', value: 'pi/b', group: 'Pi', provider: 'pi', supportsPermissions: false, supportsAttachments: false },
    { label: 'Claude Sonnet', value: 'sonnet', group: 'Claude', provider: 'claude', supportsPermissions: true, supportsAttachments: true },
  ],
  providerSettings: {
    chat: [{ key: 'useRelayTools', label: 'Use Relay Tools', type: 'boolean', default: false }],
    claude: [],
    pi: [{ key: 'thinkingLevel', label: 'Thinking Level', type: 'select', default: 'medium', options: ['off', 'low', 'medium', 'high'] }],
  },
};

// Relay-side (snake_case) templates. The stale flags are what older
// templates still carry in relay; eve must ignore them either way.
const TEMPLATES = [
  { id: 't-chat', name: 'Chat Plain', model: 'chat-a', mode: 'text', voice: '', system_prompt: '' },
  { id: 't-chat-off', name: 'Chat Off', model: 'chat-a', mode: 'text', voice: '', system_prompt: 'be brief', append_claude_md: false, use_relay_tools: false },
  { id: 't-voice', name: 'Voice Chat A', model: 'chat-a', mode: 'voice', voice: 'af_heart', system_prompt: '' },
  { id: 't-claude', name: 'Claude Stale', model: 'sonnet', mode: 'text', voice: '', system_prompt: '', append_claude_md: true, use_relay_tools: true },
];

const test = base.test.extend({
  eve: async ({}, use) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-defaults-'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Acme', 'utf8');
    const eve = await startEve({
      projects: [{ id: 'p1', name: 'Acme', path: projectDir, chat_templates: TEMPLATES }],
      models: MODELS,
    });
    try {
      await use(eve);
    } finally {
      await eve.stop();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },

  // create_session frames as the browser sent them, before eve touches them.
  sentCreates: async ({ page }, use) => {
    const frames = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return;
        let msg;
        try { msg = JSON.parse(payload); } catch { return; }
        if (msg && msg.type === 'create_session') frames.push(msg);
      });
    });
    await use(frames);
  },
});

const RELAY_TOOLS_LABEL = /Use Relay Tools/i;
const CLAUDE_MD_LABEL = /Append CLAUDE\.md/i;

async function gotoApp(page, eve) {
  await page.goto(eve.baseUrl);
  await expect(page.getByTestId('sidebar-project-p1')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(MODELS.models.length);
}

async function seedFavourite(page, templateId) {
  await page.addInitScript((id) => {
    localStorage.setItem('eve-settings', JSON.stringify({
      palettes: {},
      themeMode: 'dark',
      favoriteTemplate: { projectId: 'p1', templateId: id },
    }));
  }, templateId);
}

// The Action Button deep link. Fired as a hashchange once the app has loaded
// its projects: a hash present at cold load is dropped by the app's own URL
// syncing before the route handler runs, independent of chat defaults.
async function triggerFavouriteRoute(page) {
  await page.waitForFunction(() => window.client && window.client._hashListenerAdded && window.client.projects.has('p1'));
  await page.evaluate(() => { window.location.hash = '#/voice-chat'; });
}

async function openLauncher(page) {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await expect(page.getByTestId('dialog-shell-launcher-dialog')).toBeVisible();
}

async function expectNoChatOptions(scope) {
  await expect(scope.getByText(RELAY_TOOLS_LABEL)).toHaveCount(0);
  await expect(scope.getByText(CLAUDE_MD_LABEL)).toHaveCount(0);
  await expect(scope.locator('input[name="useRelayTools"], input[name="_appendClaudeMd"], input[name="appendClaudeMd"]')).toHaveCount(0);
}

async function onlyCreate(eve, sentCreates) {
  await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 10000 }).toBe(1);
  expect(sentCreates).toHaveLength(1);
  return { sent: sentCreates[0], relayed: eve.relay.sessionCreates[0] };
}

function expectDefaultsOn({ sent, relayed }) {
  expect(sent.settings).toMatchObject({ useRelayTools: true });
  expect(sent.appendClaudeMd).toBe(true);
  expect(relayed.settings).toMatchObject({ useRelayTools: true });
  expect(relayed.appendClaudeMd).toBe(true);
}

function expectDefaultsOff({ sent, relayed }) {
  expect(sent).not.toHaveProperty('appendClaudeMd');
  expect(sent.settings?.useRelayTools).toBeUndefined();
  expect(relayed.appendClaudeMd).toBe(false);
  expect(relayed.settings?.useRelayTools).toBeUndefined();
}

test.describe('chat defaults: launcher forms', () => {
  for (const [card, button] of [['shell-card-web-chat', 'Start Chat'], ['shell-card-voice-chat', 'Start Voice Chat']]) {
    test(`${card} form shows neither option for any model`, async ({ page, eve }) => {
      await gotoApp(page, eve);
      await openLauncher(page);
      await page.getByTestId(card).click();
      const dialog = page.getByTestId('dialog-shell-launcher-dialog');
      await expect(dialog.getByRole('button', { name: button })).toBeVisible();

      const select = page.getByTestId('launcher-model-select');
      for (const value of ['chat-a', 'pi/b', 'sonnet']) {
        await select.selectOption(value);
        await expectNoChatOptions(dialog);
      }
      // Non-vacuous: provider settings still render, only these two are gone.
      await select.selectOption('pi/b');
      await expect(dialog.getByText('Thinking Level')).toBeVisible();
    });
  }

  test('web chat on a chat model sends both flags', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-web-chat').click();
    await page.getByTestId('launcher-model-select').selectOption('chat-a');
    await page.getByRole('button', { name: 'Start Chat' }).click();

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent).toMatchObject({ projectId: 'p1', model: 'chat-a', settings: { useRelayTools: true }, appendClaudeMd: true });
    expectDefaultsOn(create);
  });

  test('web chat on a pi model sends both flags and keeps its provider settings', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-web-chat').click();
    await page.getByTestId('launcher-model-select').selectOption('pi/b');
    await page.getByRole('button', { name: 'Start Chat' }).click();

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent.model).toBe('pi/b');
    expectDefaultsOn(create);
    expect(create.sent.settings).toHaveProperty('thinkingLevel');
  });

  test('web chat on a Claude model sends neither flag', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-web-chat').click();
    await page.getByTestId('launcher-model-select').selectOption('sonnet');
    await page.getByRole('button', { name: 'Start Chat' }).click();

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent.model).toBe('sonnet');
    expectDefaultsOff(create);
  });

  test('voice chat on a chat model sends both flags', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-voice-chat').click();
    await page.getByTestId('launcher-model-select').selectOption('chat-a');
    await page.getByRole('button', { name: 'Start Voice Chat' }).click();

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent).toMatchObject({ model: 'chat-a', sessionType: 'voice' });
    expectDefaultsOn(create);
  });

  test('voice chat on a Claude model sends neither flag', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-voice-chat').click();
    await page.getByTestId('launcher-model-select').selectOption('sonnet');
    await page.getByRole('button', { name: 'Start Voice Chat' }).click();

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent).toMatchObject({ model: 'sonnet', sessionType: 'voice' });
    expectDefaultsOff(create);
  });
});

test.describe('chat defaults: templates and favourite', () => {
  for (const id of ['t-chat', 't-chat-off', 't-voice']) {
    test(`template ${id} on a chat model gets both flags`, async ({ page, eve, sentCreates }) => {
      await gotoApp(page, eve);
      await openLauncher(page);
      await page.getByTestId(`shell-card-template-${id}`).click();

      const create = await onlyCreate(eve, sentCreates);
      expect(create.sent.model).toBe('chat-a');
      expectDefaultsOn(create);
    });
  }

  test('template launch keeps its system prompt', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-template-t-chat-off').click();

    const { sent, relayed } = await onlyCreate(eve, sentCreates);
    expect(sent.systemPrompt).toBe('be brief');
    expect(relayed.systemPrompt).toBe('be brief');
  });

  test('a Claude template with stale flags gets neither', async ({ page, eve, sentCreates }) => {
    await gotoApp(page, eve);
    await openLauncher(page);
    await page.getByTestId('shell-card-template-t-claude').click();

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent.model).toBe('sonnet');
    expectDefaultsOff(create);
  });

  test('the favourite launch waits for models, then sends both flags', async ({ page, eve, sentCreates }) => {
    await seedFavourite(page, 't-chat');
    const hold = eve.relay.holdModels();
    await page.goto(eve.baseUrl);
    await triggerFavouriteRoute(page);
    // The route has fired with the model list still held: nothing may have
    // been sent, since an unknown model would launch without the defaults.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    expect(sentCreates).toHaveLength(0);
    expect(eve.relay.sessionCreates).toHaveLength(0);

    hold.release();
    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent).toMatchObject({ projectId: 'p1', model: 'chat-a' });
    expectDefaultsOn(create);
  });

  test('a Claude favourite sends neither flag', async ({ page, eve, sentCreates }) => {
    await seedFavourite(page, 't-claude');
    await gotoApp(page, eve);
    await triggerFavouriteRoute(page);

    const create = await onlyCreate(eve, sentCreates);
    expect(create.sent.model).toBe('sonnet');
    expectDefaultsOff(create);
  });

  test('the template editor shows neither checkbox, and saved templates carry neither key', async ({ page, eve }) => {
    await gotoApp(page, eve);
    await page.evaluate(() => window.client.bus.emit('dialog:project', { projectId: 'p1' }));
    const dialog = page.getByTestId('dialog-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('.dialog__tab[data-tab="templates"]').click();

    // Existing template, switched across providers.
    await dialog.locator('.project-dialog__template-item').first().getByTitle('Edit').click();
    const form = dialog.locator('.project-dialog__template-form');
    await expect(form).toBeVisible();
    const modelSelect = form.locator('select').first();
    for (const value of ['chat-a', 'pi/b', 'sonnet']) {
      await modelSelect.selectOption(value);
      await expectNoChatOptions(form);
      await expect(form.locator('input[type="checkbox"]')).toHaveCount(0);
    }
    await modelSelect.selectOption('chat-a');
    await form.getByRole('button', { name: 'Save Template' }).click();

    // A brand-new template.
    await dialog.getByRole('button', { name: '+ Add Template' }).click();
    await expect(form).toBeVisible();
    await expectNoChatOptions(form);
    await expect(form.locator('input[type="checkbox"]')).toHaveCount(0);
    await form.locator('input[type="text"]').first().fill('Fresh');
    await form.getByRole('button', { name: 'Save Template' }).click();

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => eve.relay.getProject('p1').chat_templates.length).toBe(TEMPLATES.length + 1);

    const saved = eve.relay.getProject('p1').chat_templates;
    expect(saved.map((t) => t.name)).toContain('Fresh');
    for (const t of saved) {
      expect(t).not.toHaveProperty('append_claude_md');
      expect(t).not.toHaveProperty('use_relay_tools');
      expect(t).not.toHaveProperty('appendClaudeMd');
      expect(t).not.toHaveProperty('useRelayTools');
      expect(Object.keys(t).sort()).toEqual(['id', 'mode', 'model', 'name', 'system_prompt', 'voice']);
    }
  });
});
