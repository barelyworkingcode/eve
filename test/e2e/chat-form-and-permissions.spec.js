/**
 * Two phase-3 seams the gate specs don't reach:
 *
 * - ChatFormControls.setSubmitEnabled(), driven by app.showSessionStarting()/
 *   clearSessionStarting(). chat-input-row.spec.js never starts a session, so
 *   it can't see the disabled window; this is the one place that does.
 * - PermissionModeControl.syncMode(), driven by a server `mode_changed` frame
 *   through message-dispatcher._applyPermissionMode(). chat-input-row.spec.js
 *   only proves the button->server direction (a click sends the frame); this
 *   proves the server->button direction, which is what makes
 *   message-dispatcher.js's `getElementById` removal safe.
 */
const { test, expect } = require('./fixtures');

test.describe('chat form and permissions, beyond the gate specs', () => {
  test('send is disabled (and the textarea too) only while the session is starting', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('sidebar-new-session-p1').click();
    await page.getByTestId('shell-card-web-chat').click();

    // Read state right after the click resolves: showSessionStarting() runs
    // synchronously in the click handler, before the real WS round trip to
    // the fake relay's HTTP API that produces session_created — so there is
    // no way for that response to have arrived yet.
    await page.getByRole('button', { name: 'Start Chat' }).click();
    const whileStarting = await page.evaluate(() => ({
      sendDisabled: document.getElementById('sendBtn').disabled,
      userInputDisabled: document.getElementById('userInput').disabled,
    }));
    expect(whileStarting).toEqual({ sendDisabled: true, userInputDisabled: true });

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
});
