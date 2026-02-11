import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Send Messages', () => {
  test('send message in Claude session and get response', async ({ eve }) => {
    await eve.goto();

    // Click the Claude session in sidebar
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    await claudeProject.locator(S.sessionItem).first().click();
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();

    // Send message
    await eve.sendMessage('hello world');

    // Wait for LLM response
    await eve.waitForResponse();

    // Verify at least one assistant message
    await expect(eve.page.locator(S.messageAssistant).first()).toBeVisible();
  });

  test('send message in LM Studio session and get response', async ({ eve }) => {
    await eve.goto();

    // Click the LM Studio session in sidebar
    const lmProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' }),
    });
    await lmProject.locator(S.sessionItem).first().click();
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();

    // Send message
    await eve.sendMessage('hello world');

    // Wait for LLM response
    await eve.waitForResponse();

    // Verify assistant response appeared
    await expect(eve.page.locator(S.messageAssistant).first()).toBeVisible();
  });
});
