// Exercises the full client message pipeline (ws-client -> message-dispatcher
// -> message-renderer) that no other e2e spec touches.
const { test, expect } = require('./fixtures');

test('starts a web chat and renders a streamed assistant reply', async ({ page }) => {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();

  const input = page.getByTestId('chat-input');
  await expect(input).toBeVisible({ timeout: 15000 });

  await input.fill('hello there');
  await page.getByTestId('chat-submit').click();

  const messages = page.getByTestId('messages-container');
  await expect(messages).toContainText('hello there');
  await expect(messages).toContainText('Hello from fake relay', { timeout: 15000 });
});

test('drops an untranslated provider event from raw_output but renders plain raw_output', async ({ page, eve }) => {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });

  const sessionId = await page.evaluate(() => window.client.currentSessionId);
  eve.relay.emitToRelay({ type: 'raw_output', sessionId, text: '{"type":"agent_settled"}' });
  eve.relay.emitToRelay({ type: 'raw_output', sessionId, text: 'Retry succeeded on attempt 2' });

  // Both frames share one socket, so the plain text arriving proves the
  // event frame before it was already dispatched.
  const messages = page.getByTestId('messages-container');
  await expect(messages).toContainText('Retry succeeded on attempt 2', { timeout: 15000 });
  await expect(messages).not.toContainText('agent_settled');
});
