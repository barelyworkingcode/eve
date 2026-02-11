import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Screen Redraw', () => {
  test('rapid tab switching preserves content', async ({ eve }) => {
    await eve.goto();

    // Join the Claude session to load its tabs
    await eve.clickSession('My Claude Chat');
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();
    await eve.page.waitForTimeout(500);

    // Should have session tab + terminal tab + claude CLI tab
    const tabCount = await eve.page.locator(S.tab).count();
    expect(tabCount).toBeGreaterThanOrEqual(2);

    // Switch to session tab
    await eve.clickTab('My Claude Chat');
    await eve.page.waitForTimeout(200);

    // Verify session content is visible - messages div should have children
    const chatVisible = await eve.page.locator(S.editorContent).isHidden();
    expect(chatVisible).toBe(true); // editor should be hidden when chat is shown

    // Switch to Terminal tab if it exists
    const terminalTab = eve.page.locator(S.tabLabel, { hasText: 'Terminal' });
    if (await terminalTab.isVisible()) {
      await terminalTab.click();
      await eve.page.waitForTimeout(300);

      // Terminal content should be visible (not hidden)
      await expect(eve.page.locator(S.terminalContent)).toBeVisible();

      // Terminal should have content in buffer
      const hasContent = await eve.terminalHasContent();
      expect(hasContent).toBe(true);
    }

    // Switch to Claude CLI tab if it exists
    const claudeTab = eve.page.locator(S.tabLabel, { hasText: 'Claude CLI' });
    if (await claudeTab.isVisible()) {
      await claudeTab.click();
      await eve.page.waitForTimeout(300);

      await expect(eve.page.locator(S.terminalContent)).toBeVisible();
    }

    // Switch back to session tab
    await eve.clickTab('My Claude Chat');
    await eve.page.waitForTimeout(200);

    // Chat area should have message content (from earlier test)
    const messageCount = await eve.page.locator(`${S.messages} > *`).count();
    expect(messageCount).toBeGreaterThan(0);
  });
});
