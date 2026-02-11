import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Project Creation', () => {
  test('welcome screen is visible on first load', async ({ eve }) => {
    await eve.goto();
    await expect(eve.page.locator(S.welcomeScreen)).toBeVisible();
  });

  test('create E2E Claude Project', async ({ eve }) => {
    await eve.goto();
    await eve.createProject('E2E Claude Project', eve.projectsDir, 'haiku');

    // Verify project appears in sidebar with correct model badge
    const project = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    await expect(project).toBeVisible();
    await expect(project.locator(S.projectModel)).toContainText('haiku');
  });

  test('create E2E LMStudio Project', async ({ eve }) => {
    await eve.goto();
    await eve.createProject('E2E LMStudio Project', eve.projectsDir, 'Qwen 3 4B');

    // Verify project appears in sidebar
    const project = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' }),
    });
    await expect(project).toBeVisible();
    await expect(project.locator(S.projectModel)).toContainText('qwen');
  });

  test('both projects visible in sidebar', async ({ eve }) => {
    await eve.goto();

    await expect(
      eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' })
    ).toBeVisible();
    await expect(
      eve.page.locator(S.projectName, { hasText: 'E2E LMStudio Project' })
    ).toBeVisible();
  });
});
