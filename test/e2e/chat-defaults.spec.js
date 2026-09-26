// Non-Claude web/voice chats start with relay tools + CLAUDE.md, Claude chats
// with neither, and no launcher or template option controls it.
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');
const { hermeticTest, gotoEve } = require('./fixtures');

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
  await gotoEve(page, eve.baseUrl);
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
    await gotoEve(page, eve.baseUrl);
    // Fired as a hashchange so this covers the route's listener path; the
    // cold-load path is covered below.
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

  test('a cold #/voice-chat load launches the favourite once', async ({ page, eve }) => {
    await page.addInitScript(() => localStorage.setItem('eve-settings', JSON.stringify({
      palettes: {}, themeMode: 'dark', favoriteTemplate: { projectId: 'p1', templateId: 't-chat' },
    })));
    await gotoEve(page, `${eve.baseUrl}/#/voice-chat`);
    expect((await relayedCreate(eve)).model).toBe('chat-a');
    await page.waitForTimeout(500);
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(await page.evaluate(() => window.location.hash)).not.toBe('#/voice-chat');
  });

  for (const withOther of [false, true]) {
    test(`a cold #/voice-chat load focuses a restored voice tab${withOther ? ' beside another restored tab' : ''}`, async ({ page, eve }) => {
      const VOICE = 'sess-voice-restored';
      const OTHER = withOther ? 'sess-plain-restored' : null;
      // Relay's session list carries no sessionType; only eve-session-meta knows.
      const seed = (sessionId, name) => eve.relay.seedSession({
        sessionId, directory: eve.relay.getProject('p1').path, projectId: 'p1', model: 'chat-a', name,
      });
      seed(VOICE, 'Voice Chat');
      if (OTHER) seed(OTHER, 'Plain Chat');
      await page.addInitScript(({ voice, other }) => {
        const open = { [voice]: Date.now() };
        if (other) open[other] = Date.now();
        localStorage.setItem('eve-settings', JSON.stringify({
          palettes: {}, themeMode: 'dark', favoriteTemplate: { projectId: 'p1', templateId: 't-chat' },
        }));
        localStorage.setItem('eve-open-sessions', JSON.stringify(open));
        localStorage.setItem('eve-session-meta', JSON.stringify({ [voice]: { sessionType: 'voice' } }));
      }, { voice: VOICE, other: OTHER });
      // The other tab's join lands last, the order that would steal focus.
      const otherJoin = OTHER ? eve.relay.holdJoin(OTHER) : null;

      await gotoEve(page, `${eve.baseUrl}/#/voice-chat`);
      await expect(page.getByTestId(`tab-${VOICE}`)).toBeVisible({ timeout: 15000 });
      await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(2);
      if (OTHER) {
        await eve.relay.waitForInbound((f) => f.type === 'join_session' && f.sessionId === OTHER, 15000);
        otherJoin.release();
        await expect(page.getByTestId(`tab-${OTHER}`)).toBeVisible({ timeout: 15000 });
      }
      await page.waitForTimeout(1000);
      expect(eve.relay.sessionCreates).toHaveLength(0);
      await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe(VOICE);
    });
  }

  test('#/voice-chat reopens a voice chat whose tab was closed, without launching another', async ({ page, eve }) => {
    await openLauncher(page, eve);
    await page.getByTestId('shell-card-voice-chat').click();
    await page.getByRole('button', { name: 'Start Voice Chat' }).click();
    await relayedCreate(eve);
    const id = eve.relay.listSessions()[0].sessionId;
    await expect(page.getByTestId(`tab-${id}`)).toBeVisible();
    expect(await page.evaluate((sid) => window.client.sessions.get(sid)?.sessionType, id)).toBe('voice');

    const joins = () => eve.relay.inbound.filter((f) => f.type === 'join_session' && f.sessionId === id).length;
    await page.getByTestId(`tab-close-${id}`).click();
    await expect(page.getByTestId(`tab-${id}`)).toHaveCount(0);
    const joinsBefore = joins();

    await page.waitForFunction(() => window.client?._hashListenerAdded);
    await page.evaluate(() => { window.location.hash = '#/voice-chat'; });
    await expect.poll(joins, { timeout: 10000 }).toBe(joinsBefore + 1);
    await expect(page.getByTestId(`tab-${id}`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe(id);
    await page.waitForTimeout(1000);
    expect(joins()).toBe(joinsBefore + 1);
    expect(eve.relay.sessionCreates).toHaveLength(1);
  });

  test('a cold #/voice-chat load launches the favourite when the restored voice session cannot be joined', async ({ page, eve }) => {
    const VOICE = 'sess-voice-gone';
    eve.relay.seedSession({
      sessionId: VOICE, directory: eve.relay.getProject('p1').path, projectId: 'p1', model: 'chat-a', name: 'Voice Chat',
    });
    eve.relay.failJoinWith(VOICE);
    await page.addInitScript((voice) => {
      localStorage.setItem('eve-settings', JSON.stringify({
        palettes: {}, themeMode: 'dark', favoriteTemplate: { projectId: 'p1', templateId: 't-chat' },
      }));
      localStorage.setItem('eve-open-sessions', JSON.stringify({ [voice]: Date.now() }));
      localStorage.setItem('eve-session-meta', JSON.stringify({ [voice]: { sessionType: 'voice' } }));
    }, VOICE);

    await gotoEve(page, `${eve.baseUrl}/#/voice-chat`);
    await eve.relay.waitForInbound((f) => f.type === 'join_session' && f.sessionId === VOICE, 15000);
    // Only relay's join error can trigger the fallback, and it answers at once.
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 5000 }).toBe(1);
    expect(eve.relay.sessionCreates[0].model).toBe('chat-a');
    const created = eve.relay.listSessions().find((s) => s.sessionId !== VOICE).sessionId;
    await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe(created);
    await page.waitForTimeout(1000);
    expect(eve.relay.sessionCreates).toHaveLength(1);
    await expect(page.getByTestId(`tab-${VOICE}`)).toHaveCount(0);
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
