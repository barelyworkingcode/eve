import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Shell Closing', () => {
  test('close shell terminal tab', async ({ eve }) => {
    await eve.goto();

    // Join Claude session
    await eve.clickSession('My Claude Chat');
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();
    await eve.page.waitForTimeout(500);

    // Count tabs before closing
    const tabsBefore = await eve.page.locator(S.tab).count();

    // Close the Terminal tab
    const terminalTab = eve.page.locator(S.tab, {
      has: eve.page.locator(S.tabLabel, { hasText: 'Terminal' }),
    });

    if (await terminalTab.isVisible()) {
      await terminalTab.locator(S.tabClose).click();
      await eve.page.waitForTimeout(500);

      // Tab should be removed
      await expect(
        eve.page.locator(S.tabLabel, { hasText: 'Terminal' })
      ).toHaveCount(0);
    }
  });

  test('close Claude CLI terminal tab', async ({ eve }) => {
    await eve.goto();

    // Join Claude session
    await eve.clickSession('My Claude Chat');
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();
    await eve.page.waitForTimeout(500);

    // Close the Claude CLI tab
    const claudeTab = eve.page.locator(S.tab, {
      has: eve.page.locator(S.tabLabel, { hasText: 'Claude CLI' }),
    });

    if (await claudeTab.isVisible()) {
      await claudeTab.locator(S.tabClose).click();
      await eve.page.waitForTimeout(500);

      // Tab should be removed
      await expect(
        eve.page.locator(S.tabLabel, { hasText: 'Claude CLI' })
      ).toHaveCount(0);
    }
  });

  test('only session tabs remain after closing terminals', async ({ eve }) => {
    await eve.goto();

    // Join Claude session
    await eve.clickSession('My Claude Chat');
    await eve.page.waitForTimeout(500);

    // No Terminal or Claude CLI tabs should exist
    await expect(
      eve.page.locator(S.tabLabel, { hasText: 'Terminal' })
    ).toHaveCount(0);
    await expect(
      eve.page.locator(S.tabLabel, { hasText: 'Claude CLI' })
    ).toHaveCount(0);

    // At least one session tab should remain
    const tabCount = await eve.page.locator(S.tab).count();
    expect(tabCount).toBeGreaterThanOrEqual(1);
  });
});
