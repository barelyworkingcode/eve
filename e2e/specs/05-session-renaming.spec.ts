import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Session Renaming', () => {
  test('rename Claude session', async ({ eve }) => {
    await eve.goto();

    // Find Claude project session
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    const sessionName = claudeProject.locator(S.sessionName).first();
    const currentName = await sessionName.textContent();

    // Double-click to rename
    await sessionName.dblclick();
    const input = eve.page.locator(S.sessionRenameInput);
    await expect(input).toBeVisible();
    await input.fill('My Claude Chat');
    await input.press('Enter');

    // Verify name updated in sidebar
    await eve.page.waitForTimeout(500);
    await expect(
      claudeProject.locator(S.sessionName, { hasText: 'My Claude Chat' })
    ).toBeVisible();
  });

  test('rename LM Studio session', async ({ eve }) => {
    await eve.goto();

    const lmProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' }),
    });
    const sessionName = lmProject.locator(S.sessionName).first();

    await sessionName.dblclick();
    const input = eve.page.locator(S.sessionRenameInput);
    await expect(input).toBeVisible();
    await input.fill('My LM Studio Chat');
    await input.press('Enter');

    await eve.page.waitForTimeout(500);
    await expect(
      lmProject.locator(S.sessionName, { hasText: 'My LM Studio Chat' })
    ).toBeVisible();
  });

  test('renamed sessions persist after reload', async ({ eve }) => {
    await eve.goto();

    // Reload and check persistence
    await eve.page.reload();
    await eve.page.waitForFunction(
      () => (window as any).client?.wsAuthenticated === true,
      { timeout: 15_000 }
    );

    await expect(
      eve.page.locator(S.sessionName, { hasText: 'My Claude Chat' })
    ).toBeVisible();
    await expect(
      eve.page.locator(S.sessionName, { hasText: 'My LM Studio Chat' })
    ).toBeVisible();
  });
});
