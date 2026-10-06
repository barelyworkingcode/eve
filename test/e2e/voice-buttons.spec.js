/**
 * Gate for the next phase of the FeatureRegistry migration
 * (docs/decisions/001-feature-registry.md), one phase further than
 * chat-input-row.spec.js: #voiceModeBtn's markup and wiring move out of
 * index.html/app.js into a slot render. Assert wiring, not appearance —
 * every check here should survive the move.
 */
const { test, expect } = require('./fixtures');
const { watchSocket, sentFrames } = require('./socket-watch');

async function openChat(page) {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
}

// The drawer panel starts `hidden` behind its own toggle, independent of
// the chat screen's own hidden/visible state.
async function openVoiceDrawer(page) {
  await page.locator('#voiceDrawerToggle').click();
  await expect(page.locator('#voiceDrawerPanel')).toBeVisible();
}

// The hold length is the input under test, so the page's clock is paused and
// advanced by exactly `ms` while the button is down; wall time plays no part.
// Call after openVoiceDrawer: the fake clock stays installed for the rest of the test.
async function useFakeClock(page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
}

async function pressVoiceModeBtn(page, ms) {
  const box = await page.locator('#voiceModeBtn').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(ms);
  await page.mouse.up();
}

test.describe('voice buttons', () => {
  test('the drawer opens on toggle and its controls are in the right order', async ({ page }) => {
    await openChat(page);
    await expect(page.locator('#voiceDrawerPanel')).toBeHidden();

    await page.locator('#voiceDrawerToggle').click();

    await expect(page.locator('#voiceDrawerPanel')).toBeVisible();
    // Order is load-bearing after the move.
    await expect.poll(() => page.$$eval('#voiceDrawerPanel select, #voiceDrawerPanel button', (els) =>
      els.map((e) => e.id).filter(Boolean))).toEqual(['voiceSelect', 'voiceSpeedSelect', 'voiceModeBtn', 'voiceUIBtn']);
  });

  test('a short tap on voiceModeBtn toggles TTS, and toggles back', async ({ page }) => {
    await openChat(page);
    await openVoiceDrawer(page);
    await useFakeClock(page);

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
    await watchSocket(page);
    await page.evaluate(() => document.getElementById('voiceModeBtn').click());
    await expect(page.locator('#voiceModeBtn')).toHaveClass(/btn-voice-mode--active/);
    // Assert on the frame sent, not local state the migration is free to restructure.
    const sent = (await sentFrames(page)).filter((f) => f.type === 'voice_mode');
    expect(sent).toHaveLength(1);
    expect(sent[0].enabled).toBe(true);
  });

  test('a long press starts voice chat; a short tap does not', async ({ page }) => {
    await openChat(page);
    await openVoiceDrawer(page);
    await useFakeClock(page);
    // convertToVoiceChat() switches the whole tab to the voice UI — stub it
    // and assert the 500ms threshold the gesture wiring hinges on.
    await page.evaluate(() => {
      window.__convertCalls = 0;
      window.client.voiceChatManager.convertToVoiceChat = () => { window.__convertCalls++; };
    });

    await pressVoiceModeBtn(page, 50);
    await expect(page.locator('#voiceModeBtn')).toHaveClass(/btn-voice-mode--active/);
    expect(await page.evaluate(() => window.__convertCalls)).toBe(0);

    await pressVoiceModeBtn(page, 600);
    await expect.poll(() => page.evaluate(() => window.__convertCalls)).toBe(1);
  });
});
