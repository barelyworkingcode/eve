import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Session Creation', () => {
  test('create session in Claude project', async ({ eve }) => {
    await eve.goto();
    await eve.createSessionInProject('E2E Claude Project');

    // Chat screen should be visible with a tab
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();
    await expect(eve.page.locator(S.tab)).toHaveCount(1, { timeout: 5_000 });
  });

  test('create session in LM Studio project', async ({ eve }) => {
    await eve.goto();
    await eve.createSessionInProject('E2E LMStudio Project');

    // Should now have two sessions visible in sidebar
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    const lmProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' }),
    });

    await expect(claudeProject.locator(S.sessionItem)).toHaveCount(1);
    await expect(lmProject.locator(S.sessionItem)).toHaveCount(1);
  });
});
