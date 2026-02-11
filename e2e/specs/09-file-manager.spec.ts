import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_FILE = path.join(__dirname, '..', 'fixtures', 'test-upload.md');

test.describe('File Manager', () => {
  test('open file browser and upload file', async ({ eve }) => {
    await eve.goto();

    // Open file browser for Claude project
    await eve.openFileBrowser('E2E Claude Project');

    // Wait for file tree to appear
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    const fileTree = claudeProject.locator(S.fileTree);
    await expect(fileTree).toBeVisible({ timeout: 5_000 });

    // Read fixture file content
    const fileContent = fs.readFileSync(FIXTURE_FILE, 'utf-8');

    // Drop file onto file tree
    await eve.dropFileOnTree('E2E Claude Project', 'test-upload.md', fileContent);

    // Wait for file to appear in tree
    await expect(
      claudeProject.locator(S.fileTreeItem, { hasText: 'test-upload.md' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('open file in editor', async ({ eve }) => {
    await eve.goto();

    // Open file browser
    await eve.openFileBrowser('E2E Claude Project');

    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });

    // Click the uploaded file
    await claudeProject
      .locator(S.fileTreeItem, { hasText: 'test-upload.md' })
      .click();

    // Wait for editor to be visible
    await expect(eve.page.locator(S.editorContent)).toBeVisible({ timeout: 10_000 });

    // Verify Monaco editor loaded with content
    await eve.page.waitForFunction(
      () => {
        const editor = (window as any).client?.fileEditor?.editor;
        return editor && editor.getValue()?.includes('Test Upload');
      },
      { timeout: 10_000 }
    );
  });

  test('modify and save file', async ({ eve }) => {
    await eve.goto();

    // Open file browser and click file
    await eve.openFileBrowser('E2E Claude Project');
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    await claudeProject
      .locator(S.fileTreeItem, { hasText: 'test-upload.md' })
      .click();
    await expect(eve.page.locator(S.editorContent)).toBeVisible({ timeout: 10_000 });

    // Wait for Monaco to load
    await eve.page.waitForFunction(
      () => (window as any).client?.fileEditor?.editor?.getValue(),
      { timeout: 10_000 }
    );

    // Modify content via Monaco API
    await eve.page.evaluate(() => {
      const editor = (window as any).client.fileEditor.editor;
      editor.setValue(editor.getValue() + '\n\n## Added by E2E test\n\nNew content.');
    });

    // Save button should become enabled
    await expect(eve.page.locator(S.saveFileBtn)).toBeEnabled({ timeout: 5_000 });

    // Click save
    await eve.page.click(S.saveFileBtn);

    // Save button should become disabled again (save complete)
    await expect(eve.page.locator(S.saveFileBtn)).toBeDisabled({ timeout: 5_000 });
  });

  test('switch to split view and see preview', async ({ eve }) => {
    await eve.goto();

    // Open file browser and click file
    await eve.openFileBrowser('E2E Claude Project');
    const claudeProject = eve.page.locator(S.projectGroup, {
      has: eve.page.locator(S.projectName, { hasText: 'E2E Claude Project' }),
    });
    await claudeProject
      .locator(S.fileTreeItem, { hasText: 'test-upload.md' })
      .click();
    await expect(eve.page.locator(S.editorContent)).toBeVisible({ timeout: 10_000 });

    // Switch to split view
    await eve.page.click('.view-mode-btn[data-mode="split"]');

    // Markdown preview should contain rendered HTML
    await expect(eve.page.locator(S.markdownPreview)).toBeVisible({ timeout: 5_000 });

    // Preview should have some rendered content
    const previewHTML = await eve.page.locator(S.markdownPreview).innerHTML();
    expect(previewHTML.length).toBeGreaterThan(0);
  });
});
