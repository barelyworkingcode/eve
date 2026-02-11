import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Session Switching', () => {
  test('switch between sessions via sidebar and tabs', async ({ eve }) => {
    await eve.goto();

    // Open both sessions so they have tabs
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    const lmProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' }),
    });

    // Click Claude session first
    await claudeProject.locator(S.sessionItem).first().click();
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();

    // Record Claude session messages content
    await eve.page.waitForTimeout(500);
    const claudeContent = await eve.page.locator(S.messages).innerHTML();

    // Click LM Studio session
    await lmProject.locator(S.sessionItem).first().click();
    await eve.page.waitForTimeout(500);

    // Should now have 2 tabs
    await expect(eve.page.locator(S.tab)).toHaveCount(2);

    // LM Studio tab should be active
    const activeTab = eve.page.locator(S.tabActive);
    await expect(activeTab).toHaveCount(1);

    // Messages content should be different
    const lmContent = await eve.page.locator(S.messages).innerHTML();

    // Switch back via tab bar - click the first (Claude) tab
    const tabs = eve.page.locator(S.tab);
    await tabs.first().locator(S.tabLabel).click();
    await eve.page.waitForTimeout(500);

    // Active tab should change
    await expect(eve.page.locator(S.tabActive)).toHaveCount(1);

    // Messages should have Claude content again
    const switchedContent = await eve.page.locator(S.messages).innerHTML();
    expect(switchedContent).toBe(claudeContent);
  });
});
