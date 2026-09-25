const { test, expect } = require('./fixtures');
const { createFakeRelay } = require('../integration/fake-relay');

test.describe('task dialog schedule wire shapes', () => {
  test.use({ timezoneId: 'Europe/Berlin' });

  async function createTask(page, eve, fillSchedule) {
    eve.relay.setModels({ models: [{ value: 'acme-model', label: 'Acme Model', provider: 'chat' }], providerSettings: {} });
    // The startup fetch has to settle first, or its empty answer can land after ours.
    await page.evaluate(async () => { await window.client._modelsReady; await window.client.loadModels(); });
    await page.evaluate(() => window.client.bus.emit('dialog:task', { projectId: 'p1' }));
    const dialog = page.getByTestId('dialog-task-dialog');
    await dialog.locator('.dialog__tab[data-tab="new"]').click();
    await dialog.locator('[name="taskName"]').fill('Acme report');
    await fillSchedule(dialog);
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks'),
      dialog.getByRole('button', { name: 'Create Task' }).click(),
    ]);
    const body = request.postDataJSON();
    expect(body.model).toBe('acme-model');
    return body.schedule;
  }

  test('weekly sends the full lowercase day name', async ({ page, eve }) => {
    const schedule = await createTask(page, eve, async (dialog) => {
      await dialog.locator('[name="scheduleType"]').selectOption('weekly');
      await dialog.locator('[name="schedDay"]').selectOption({ label: 'Tue' });
      await dialog.locator('[name="schedTime"]').fill('09:00');
    });
    expect(schedule).toEqual({ type: 'weekly', day: 'tuesday', time: '09:00' });
  });

  test('once sends `at` as RFC 3339 with the browser offset and no datetime key', async ({ page, eve }) => {
    const schedule = await createTask(page, eve, async (dialog) => {
      await dialog.locator('[name="scheduleType"]').selectOption('once');
      await dialog.locator('[name="schedDatetime"]').fill('2026-09-24T09:30');
    });
    expect(schedule).toEqual({ type: 'once', at: '2026-09-24T09:30:00+02:00' });
  });
});

test('search dialog focuses the query, takes typing, and Enter keeps it open', async ({ page }) => {
  await page.evaluate(() => window.client.bus.emit('dialog:search', { projectId: 'p1' }));
  const query = page.getByTestId('search-dialog-query');
  await expect(query).toBeFocused();
  await page.keyboard.type('needle');
  await expect(query).toHaveValue('needle');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dialog-search-dialog')).not.toHaveClass(/\bhidden\b/);
});

test.describe('cold-load deep link', () => {
  const TARGET = 'sess-deep-target';
  const OTHER = 'sess-deep-other';

  for (const withOther of [false, true]) {
    test(`#session/<id> ends active with the hash intact${withOther ? ' while another tab restores' : ''}`, async ({ page, eve }) => {
      const seed = (sessionId, name) => eve.relay.seedSession({
        sessionId, directory: eve.projectDir, projectId: 'p1', model: 'fake-model', name,
      });
      seed(TARGET, 'Deep Target');
      if (withOther) {
        seed(OTHER, 'Other Session');
        await page.addInitScript((id) => {
          try { localStorage.setItem('eve-open-sessions', JSON.stringify({ [id]: Date.now() })); } catch {}
        }, OTHER);
      }

      // OTHER's reply is held until TARGET's has landed, so the restored tab
      // is the last join to arrive — the order that would steal focus.
      const otherJoin = withOther ? eve.relay.holdJoin(OTHER) : null;

      // A same-URL goto with only a new hash is a same-document navigation.
      await page.goto('about:blank');
      await page.goto(`${eve.baseUrl}/#session/${TARGET}`);

      await expect(page.getByTestId(`tab-${TARGET}`)).toBeVisible({ timeout: 15000 });
      if (withOther) {
        await eve.relay.waitForInbound((f) => f.type === 'join_session' && f.sessionId === OTHER, 15000);
        otherJoin.release();
        await expect(page.getByTestId(`tab-${OTHER}`)).toBeVisible({ timeout: 15000 });
      }
      await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe(TARGET);
      expect(await page.evaluate(() => location.hash)).toBe(`#session/${TARGET}`);
    });
  }
});

test.describe('Send follows the connection state', () => {
  const cases = [
    {
      name: 'relay upstream',
      drop: async ({ eve }) => { await eve.relay.close(); },
      restore: async ({ eve }) => {
        const revived = createFakeRelay();
        await revived.listen(eve.relayPort);
        return revived;
      },
    },
    {
      name: 'browser socket',
      drop: async ({ page }) => { await page.context().setOffline(true); },
      restore: async ({ page }) => {
        await page.context().setOffline(false);
        await page.evaluate(() => window.client.wsClient.forceReconnect());
        return null;
      },
    },
  ];

  for (const c of cases) {
    test(`${c.name} down: Send disabled, banner shown, Enter sends nothing; restored afterwards`, async ({ page, eve }) => {
      await page.getByTestId('sidebar-project-p1').click();
      await page.getByTestId('sidebar-new-session-p1').click();
      await page.getByTestId('shell-card-web-chat').click();
      await page.getByRole('button', { name: 'Start Chat' }).click();
      const input = page.getByTestId('chat-input');
      await expect(input).toBeVisible({ timeout: 15000 });
      const send = page.getByTestId('chat-submit');
      const banner = page.getByTestId('connection-banner');
      await expect(send).toBeEnabled();
      await expect(banner).toBeHidden();

      await c.drop({ page, eve });
      await expect(send).toBeDisabled({ timeout: 15000 });
      await expect(banner).toBeVisible();

      await input.fill('sent while offline');
      await input.press('Enter');
      await expect(page.getByTestId('messages-container')).not.toContainText('sent while offline');

      const revived = await c.restore({ page, eve });
      try {
        await expect(banner).toBeHidden({ timeout: 15000 });
        await expect(send).toBeEnabled();
      } finally {
        if (revived) await revived.close();
      }
    });
  }
});

test('settings voice tab names the Qwen3 server daemons', async ({ page }) => {
  await page.evaluate(() => window.client.bus.emit('dialog:settings'));
  const dialog = page.getByTestId('dialog-settings-dialog');
  await dialog.locator('.dialog__tab[data-tab="voice"]').click();
  for (const text of [
    'Server (Qwen3-TTS daemon)',
    'Speech is synthesized by the local relayTTS daemon (Qwen3-TTS).',
    'Server (Qwen3-ASR daemon)',
    'Speech is transcribed by the local relaySTT daemon (Qwen3-ASR).',
  ]) {
    await expect(dialog.getByText(text, { exact: true })).toBeVisible();
  }
});
