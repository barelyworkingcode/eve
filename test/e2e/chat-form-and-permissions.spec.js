/**
 * Covers three seams chat-input-row.spec.js can't reach: it never starts a
 * session (misses the submit-disabled window), only proves the button->server
 * click direction for permission mode (not server->button), and never drives
 * a real streaming turn (so a silently-unassigned, `?.`-guarded stop button
 * would pass every other suite green).
 */
const { test, expect } = require('./fixtures');
const { relayFrames } = require('../integration/protocol');

test.describe('chat form and permissions, beyond the gate specs', () => {
  test('send is disabled (and the textarea too) only while the session is starting', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('sidebar-new-session-p1').click();
    await page.getByTestId('shell-card-web-chat').click();

    // Holding the relay's response open avoids a real race: session_created
    // could flip the button enabled again before the assertion below runs.
    const gate = eve.relay.holdSessionCreate();

    await page.getByRole('button', { name: 'Start Chat' }).click();
    const whileStarting = await page.evaluate(() => ({
      sendDisabled: document.getElementById('sendBtn').disabled,
      userInputDisabled: document.getElementById('userInput').disabled,
    }));
    expect(whileStarting).toEqual({ sendDisabled: true, userInputDisabled: true });

    gate.release();
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
    const afterCreated = await page.evaluate(() => ({
      sendDisabled: document.getElementById('sendBtn').disabled,
      userInputDisabled: document.getElementById('userInput').disabled,
    }));
    expect(afterCreated).toEqual({ sendDisabled: false, userInputDisabled: false });
  });

  test('plan mode reflects the server-confirmed mode, not just the local click', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('sidebar-new-session-p1').click();
    await page.getByTestId('shell-card-web-chat').click();
    await page.getByRole('button', { name: 'Start Chat' }).click();
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });

    const sessionId = await page.evaluate(() => window.client.currentSessionId);
    expect(await page.evaluate(() => document.getElementById('planModeBtn').classList.contains('active')))
      .toBe(false);

    // No client-side click — proves the frame reaches the button through the
    // permissions service's syncMode(), not a getElementById it no longer has.
    eve.relay.emitToRelay({ type: 'mode_changed', sessionId, mode: 'plan' });
    await expect.poll(() =>
      page.evaluate(() => document.getElementById('planModeBtn').classList.contains('active'))
    ).toBe(true);

    eve.relay.emitToRelay({ type: 'mode_changed', sessionId, mode: 'default' });
    await expect.poll(() =>
      page.evaluate(() => document.getElementById('planModeBtn').classList.contains('active'))
    ).toBe(false);
  });

  test('stop replaces send while a turn streams, and send comes back when it completes', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('sidebar-new-session-p1').click();
    await page.getByTestId('shell-card-web-chat').click();
    await page.getByRole('button', { name: 'Start Chat' }).click();
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });

    const sessionId = await page.evaluate(() => window.client.currentSessionId);
    // No message_complete yet — the turn stays open so the mid-stream
    // assertions land on a real streaming window, not click-time state that
    // would pass even if hideStop() never ran.
    eve.relay.scriptSession(sessionId, [relayFrames.assistantDelta({ sessionId, text: 'streaming reply' })]);

    await page.getByTestId('chat-input').fill('drive a real streaming turn');
    await page.getByTestId('chat-submit').click();

    await expect(page.getByTestId('messages-container')).toContainText('streaming reply');
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await expect(page.getByTestId('chat-submit')).toBeHidden();

    // No client-side click — proves message_complete reaches the real
    // #stopBtn through hideStop(), not a silently no-op `?.`.
    eve.relay.emitToRelay(relayFrames.messageComplete({ sessionId }));
    await expect(page.getByTestId('chat-submit')).toBeVisible();
    await expect(page.getByTestId('chat-stop')).toBeHidden();
  });
});
