/**
 * The voice drawer and its voice-mode button, asserted behaviourally.
 *
 * This is the gate for the next phase of the FeatureRegistry migration
 * (docs/decisions/001-feature-registry.md), one phase further along than
 * chat-input-row.spec.js: #voiceModeBtn's markup moves out of index.html into
 * a slot render, and its wiring moves out of app.js. The visual harness
 * proves the drawer still *looks* right; this proves it still *works*, which
 * a screenshot cannot.
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

// The drawer panel is a real element in the DOM from load, but it starts
// `hidden` behind its own toggle (independent of the chat screen's own
// hidden/visible state) — open it before touching anything inside.
async function openVoiceDrawer(page) {
  await page.locator('#voiceDrawerToggle').click();
  await expect(page.locator('#voiceDrawerPanel')).toBeVisible();
}

// Mouse down over the button, hold for `ms`, then release — gives us control
// over the press duration that a plain `.click()` doesn't, which is the
// whole point of the test that reads on it.
async function pressVoiceModeBtn(page, ms) {
  const box = await page.locator('#voiceModeBtn').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test.describe('voice buttons', () => {
  test('the drawer opens on toggle and its controls are in the right order', async ({ page }) => {
    await openChat(page);
    await expect(page.locator('#voiceDrawerPanel')).toBeHidden();

    await page.locator('#voiceDrawerToggle').click();

    await expect(page.locator('#voiceDrawerPanel')).toBeVisible();
    // Order is load-bearing after the move, exactly like the chat input row's.
    const ids = await page.$$eval('#voiceDrawerPanel select, #voiceDrawerPanel button', (els) =>
      els.map((e) => e.id).filter(Boolean));
    expect(ids).toEqual(['voiceSelect', 'voiceSpeedSelect', 'voiceModeBtn', 'voiceUIBtn']);
  });

  test('a short tap on voiceModeBtn toggles TTS, and toggles back', async ({ page }) => {
    await openChat(page);
    await openVoiceDrawer(page);

    await pressVoiceModeBtn(page, 50);
    expect(await page.evaluate(() => window.client.ttsManager.enabled)).toBe(true);
    await expect(page.locator('#voiceModeBtn')).toHaveClass(/btn-voice-mode--active/);

    await pressVoiceModeBtn(page, 50);
    expect(await page.evaluate(() => window.client.ttsManager.enabled)).toBe(false);
    await expect(page.locator('#voiceModeBtn')).not.toHaveClass(/btn-voice-mode--active/);
  });

  test('enabling voice mode tells the server via a voice_mode frame', async ({ page }) => {
    await openChat(page);
    await openVoiceDrawer(page);
    // Same technique as the plan-mode gate: assert on the frame sent, not on
    // any local state the migration is free to restructure.
    const sent = await page.evaluate(async () => {
      const ws = window.client.wsClient;
      const original = ws.send.bind(ws);
      const frames = [];
      ws.send = (m) => { frames.push(m); return original(m); };
      document.getElementById('voiceModeBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      ws.send = original;
      return frames.filter((f) => f && f.type === 'voice_mode');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].enabled).toBe(true);
  });

  test('the tts manager reaches its own button to set the speaking indicator', async ({ page }) => {
    await openChat(page);
    await openVoiceDrawer(page);
    // Drive it through the manager, not by adding the class ourselves — the
    // point is that tts-manager.js still finds its own button after the move.
    const speaking = await page.evaluate(() => {
      window.client.ttsManager._setSpeakingIndicator(true);
      return document.getElementById('voiceModeBtn').classList.contains('tts-speaking');
    });
    expect(speaking).toBe(true);

    const stopped = await page.evaluate(() => {
      window.client.ttsManager._setSpeakingIndicator(false);
      return document.getElementById('voiceModeBtn').classList.contains('tts-speaking');
    });
    expect(stopped).toBe(false);
  });

  test('a long press starts voice chat; a short tap does not', async ({ page }) => {
    await openChat(page);
    await openVoiceDrawer(page);
    // convertToVoiceChat() switches the whole tab to the voice UI — not
    // something to run end to end here. Stub it and assert the 500ms
    // threshold the gesture wiring hinges on, in both directions.
    await page.evaluate(() => {
      window.__convertCalls = 0;
      window.client.voiceChatManager.convertToVoiceChat = () => { window.__convertCalls++; };
    });

    await pressVoiceModeBtn(page, 50);
    expect(await page.evaluate(() => window.__convertCalls)).toBe(0);

    await pressVoiceModeBtn(page, 600);
    expect(await page.evaluate(() => window.__convertCalls)).toBe(1);
  });
});
