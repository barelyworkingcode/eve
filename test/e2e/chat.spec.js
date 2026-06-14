/**
 * E2E increment 2 — the full chat flow in a real browser: open the project,
 * start a Web Chat session (create_session → fake relay), send a message, and
 * see the streamed assistant reply render. Exercises the client message
 * pipeline (ws-client → message-dispatcher → message-renderer) that no other
 * layer touches.
 */
const { test, expect } = require('./fixtures');

test('starts a web chat and renders a streamed assistant reply', async ({ page }) => {
  // Open the project's panel and launch a Web Chat session.
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();

  // Chat view opens once the fake relay returns the session.
  const input = page.getByTestId('chat-input');
  await expect(input).toBeVisible({ timeout: 15000 });

  await input.fill('hello there');
  await page.getByTestId('chat-submit').click();

  const messages = page.getByTestId('messages-container');
  await expect(messages).toContainText('hello there');                  // user message rendered
  await expect(messages).toContainText('Hello from fake relay', { timeout: 15000 }); // streamed assistant reply
});
