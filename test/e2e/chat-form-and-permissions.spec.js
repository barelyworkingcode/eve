/**
 * Three phase-3 seams the gate specs don't reach:
 *
 * - ChatFormControls.setSubmitEnabled(), driven by app.showSessionStarting()/
 *   clearSessionStarting(). chat-input-row.spec.js never starts a session, so
 *   it can't see the disabled window; this is the one place that does.
 * - PermissionModeControl.syncMode(), driven by a server `mode_changed` frame
 *   through message-dispatcher._applyPermissionMode(). chat-input-row.spec.js
 *   only proves the button->server direction (a click sends the frame); this
 *   proves the server->button direction, which is what makes
 *   message-dispatcher.js's `getElementById` removal safe.
 * - ChatFormControls.showStop()/hideStop() driven end to end by a real
 *   streaming turn (message-dispatcher.js -> app.showStopButton()/
 *   hideStopButton() -> chatForm). chat-input-row.spec.js only proves stop is
 *   hidden while idle; nothing else drives the full path against the real
 *   #sendBtn/#stopBtn DOM, so a silently-unassigned button (both accesses in
 *   ChatFormControls are `?.`-guarded) would pass every other suite green.
 */
const { test, expect } = require('./fixtures');
const { relayFrames } = require('../integration/protocol');

test.describe('chat form and permissions, beyond the gate specs', () => {
  test('send is disabled (and the textarea too) only while the session is starting', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('sidebar-new-session-p1').click();
    await page.getByTestId('shell-card-web-chat').click();

    // showSessionStarting() runs synchronously in the click handler, before
    // ws.send('create_session') — so the disabled read below is never racing
    // *that* part. What it can race, under load, is the other side: eve's
    // child process round-tripping the real (if fake) HTTP POST to relay and
    // WS-pushing session_created back, which would flip the button enabled
    // again before this assertion gets scheduled. Holding the relay's
    // response open removes that race outright instead of hoping this read
    // wins a timing footrace across three processes.
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

    // No client-side click at all — this frame only exists if
    // message-dispatcher's `mode_changed` handler reaches the button through
    // the permissions service (container.get('permissions').syncMode()),
    // not through a getElementById it no longer has.
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
    // Script the turn with only a delta, no message_complete — the turn stays
    // open until this test completes it explicitly below, so the mid-stream
    // assertions land on a real streaming window rather than the synchronous
    // click-time state (which would pass even if hideStop() never ran).
    eve.relay.scriptSession(sessionId, [relayFrames.assistantDelta({ sessionId, text: 'streaming reply' })]);

    await page.getByTestId('chat-input').fill('drive a real streaming turn');
    await page.getByTestId('chat-submit').click();

    // Wait for the delta to actually render, proving the turn is genuinely
    // in flight (not just resting on the click handler's own synchronous state).
    await expect(page.getByTestId('messages-container')).toContainText('streaming reply');
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await expect(page.getByTestId('chat-submit')).toBeHidden();

    // No client-side click — this frame only exists if message-dispatcher's
    // message_complete handler reaches the real #sendBtn/#stopBtn through
    // chatForm.hideStop(), not through a silently no-op `?.` on an unassigned
    // button.
    eve.relay.emitToRelay(relayFrames.messageComplete({ sessionId }));
    await expect(page.getByTestId('chat-submit')).toBeVisible();
    await expect(page.getByTestId('chat-stop')).toBeHidden();
  });
});
