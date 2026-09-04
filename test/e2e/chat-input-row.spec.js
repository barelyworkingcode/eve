/**
 * The chat input button row, asserted behaviourally.
 *
 * This exists as the gate for the FeatureRegistry migration
 * (docs/decisions/001-feature-registry.md): the buttons are moving from
 * literal markup in index.html to slot contributions rendered at boot. The
 * visual harness proves the row still *looks* right; this proves it still
 * *works*, which a screenshot cannot.
 *
 * Assert wiring, not appearance. Every check here should survive the move.
 */
const { test, expect } = require('./fixtures');

async function openChat(page) {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
}

test.describe('chat input row', () => {
  test('every button is present and in the right order', async ({ page }) => {
    await openChat(page);
    // Order is load-bearing: leading actions, the textarea, then trailing.
    const ids = await page.$$eval('#inputForm button, #inputForm textarea', (els) =>
      els.map((e) => e.id).filter(Boolean));
    expect(ids).toEqual(['attachBtn', 'planModeBtn', 'userInput', 'sendBtn', 'micBtn', 'stopBtn']);
  });

  test('attach visibility tracks model attachment support, and it opens the picker', async ({ page }) => {
    await openChat(page);
    // app.js hides #attachBtn for models that don't advertise supportsAttachments.
    // The fake relay's model doesn't, so hidden is the correct state here — that
    // capability wiring is itself worth protecting through the migration.
    await expect(page.getByTestId('chat-attach')).toBeHidden();

    // Its only other job is to click the hidden #fileInput. Reveal it so the
    // click wiring can be asserted without depending on the fake model's metadata.
    await page.evaluate(() => { document.getElementById('attachBtn').hidden = false; });
    const opened = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.getByTestId('chat-attach').click();
    expect(await opened).toBeTruthy();
  });

  test('send submits the message', async ({ page }) => {
    await openChat(page);
    await page.getByTestId('chat-input').fill('sent via the send button');
    await page.getByTestId('chat-submit').click();
    await expect(page.getByTestId('messages-container')).toContainText('sent via the send button');
    await expect(page.getByTestId('chat-input')).toHaveValue('');
  });

  test('plan mode asks the server to change permission mode', async ({ page }) => {
    await openChat(page);
    // The button's own class reflects server state, so assert on the frame it
    // sends rather than on any local toggle.
    const sent = await page.evaluate(async () => {
      const ws = window.client.wsClient;
      const original = ws.send.bind(ws);
      const frames = [];
      ws.send = (m) => { frames.push(m); return original(m); };
      document.getElementById('planModeBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      ws.send = original;
      return frames.filter((f) => f && f.type === 'set_permission_mode');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].mode).toBe('plan');
  });

  test('stop is hidden while idle and the mic reflects STT availability', async ({ page }) => {
    await page.route('**/api/stt/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) }));
    await openChat(page);
    await expect(page.getByTestId('chat-stop')).toBeHidden();
    await expect(page.getByTestId('chat-mic')).toBeVisible();
  });
});
