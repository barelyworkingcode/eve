import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Cleanup', () => {
  test('delete Claude session', async ({ eve }) => {
    await eve.goto();
    await eve.deleteSession('My Claude Chat');

    // Session should no longer appear
    await expect(
      eve.page.locator(S.sessionName, { hasText: 'My Claude Chat' })
    ).toHaveCount(0);
  });

  test('delete LM Studio session', async ({ eve }) => {
    await eve.goto();
    await eve.deleteSession('My LM Studio Chat');

    await expect(
      eve.page.locator(S.sessionName, { hasText: 'My LM Studio Chat' })
    ).toHaveCount(0);
  });

  test('delete Claude project', async ({ eve }) => {
    await eve.goto();
    await eve.deleteProject('E2E Claude Project');

    await expect(
      eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' })
    ).toHaveCount(0);
  });

  test('delete LM Studio project', async ({ eve }) => {
    await eve.goto();
    await eve.deleteProject('E2E LMStudio Project');

    await expect(
      eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' })
    ).toHaveCount(0);
  });

  test('verify cleanup persists after reload', async ({ eve }) => {
    await eve.goto();

    // Reload
    await eve.page.reload();
    await eve.page.waitForFunction(
      () => (window as any).client?.wsAuthenticated === true,
      { timeout: 15_000 }
    );

    // Neither test project nor test session should appear
    await expect(
      eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' })
    ).toHaveCount(0);
    await expect(
      eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' })
    ).toHaveCount(0);
    await expect(
      eve.page.locator(S.sessionName, { hasText: 'My Claude Chat' })
    ).toHaveCount(0);
    await expect(
      eve.page.locator(S.sessionName, { hasText: 'My LM Studio Chat' })
    ).toHaveCount(0);
  });
});
