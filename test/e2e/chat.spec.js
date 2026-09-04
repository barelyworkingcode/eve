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
