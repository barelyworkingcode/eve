import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { S } from '../helpers/selectors';
import { waitForTerminalOutput, terminalHasContent } from '../helpers/terminal-helpers';

const ENV_FILE = path.join(__dirname, '..', '.test-env.json');

function getEnv() {
  return JSON.parse(fs.readFileSync(ENV_FILE, 'utf-8'));
}

export class EvePage {
  constructor(public page: Page) {}

  /** Navigate to app root and wait for WebSocket authentication and models */
  async goto() {
    await this.page.goto('/');
    await this.page.waitForFunction(
      () => {
        const client = (window as any).client;
        return client?.wsAuthenticated === true && client?.models?.length > 0;
      },
      { timeout: 15_000 }
    );
  }

  /** Get the temp projects directory path */
  get projectsDir(): string {
    return getEnv().projectsDir;
  }

  /** Create a project via the UI */
  async createProject(name: string, projectPath: string, model: string) {
    await this.page.click(S.newProjectBtn);
    await expect(this.page.locator(S.projectModal)).toBeVisible();

    await this.page.fill(S.projectNameInput, name);
    await this.page.fill(S.projectPathInput, projectPath);
    // Find option whose label contains the model string (case-insensitive)
    const optionValue = await this.page.evaluate(
      ({ selector, model }: { selector: string; model: string }) => {
        const select = document.querySelector(selector) as HTMLSelectElement;
        const needle = model.toLowerCase();
        for (const opt of Array.from(select.options)) {
          if (opt.textContent?.toLowerCase().includes(needle)) return opt.value;
        }
        return null;
      },
      { selector: S.projectModelSelect, model }
    );
    if (optionValue) {
      await this.page.selectOption(S.projectModelSelect, optionValue);
    }

    await this.page.click(`${S.newProjectForm} button[type="submit"]`);
    await expect(this.page.locator(S.projectModal)).toBeHidden();

    // Wait for project to appear in sidebar
    await expect(
      this.page.locator(S.projectName, { hasText: name })
    ).toBeVisible();
  }

  /** Click the quick-add button on a project to open session modal */
  async createSessionInProject(projectName: string) {
    const project = this.page.locator(S.projectGroup, {
      has: this.page.locator(S.projectName, { hasText: projectName }),
    });
    await project.locator(S.projectQuickAdd).click();
    await expect(this.page.locator(S.modal)).toBeVisible();

    // Submit the pre-filled form
    await this.page.click(`${S.newSessionForm} button[type="submit"]`);
    await expect(this.page.locator(S.modal)).toBeHidden();

    // Wait for chat screen
    await expect(this.page.locator(S.chatScreen)).toBeVisible({ timeout: 10_000 });
  }

  /** Send a message in the current session */
  async sendMessage(text: string) {
    await this.page.fill(S.userInput, text);
    await this.page.click(S.sendBtn);

    // Wait for user message to appear
    await expect(
      this.page.locator(S.messageUser).last()
    ).toContainText(text);
  }

  /** Wait for the LLM response to complete (thinking indicator disappears) */
  async waitForResponse(timeout = 90_000) {
    // First wait for thinking indicator to appear (response started)
    try {
      await expect(this.page.locator(S.thinkingIndicator)).toBeVisible({ timeout: 5_000 });
    } catch {
      // It may have already appeared and disappeared quickly
    }

    // Then wait for it to disappear (response complete)
    await expect(this.page.locator(S.thinkingIndicator)).toBeHidden({ timeout });
  }

  /** Click a session by name in the sidebar */
  async clickSession(name: string) {
    await this.page.locator(S.sessionName, { hasText: name }).click();
    // Wait for tab switch
    await this.page.waitForTimeout(300);
  }

  /** Click a tab by label text */
  async clickTab(label: string) {
    await this.page.locator(S.tabLabel, { hasText: label }).click();
    await this.page.waitForTimeout(200);
  }

  /** Rename a session via double-click inline editing */
  async renameSession(currentName: string, newName: string) {
    const nameEl = this.page.locator(S.sessionName, { hasText: currentName });
    await nameEl.dblclick();

    const input = this.page.locator(S.sessionRenameInput);
    await expect(input).toBeVisible();
    await input.fill(newName);
    await input.press('Enter');

    // Wait for rename to complete and re-render
    await this.page.waitForTimeout(500);
  }

  /** Delete a session by name */
  async deleteSession(name: string) {
    const sessionItem = this.page.locator(S.sessionItem, {
      has: this.page.locator(S.sessionName, { hasText: name }),
    });
    await sessionItem.locator(S.sessionDelete).click();

    await expect(this.page.locator(S.confirmModal)).toBeVisible();
    await this.page.click(S.confirmDelete);
    await expect(this.page.locator(S.confirmModal)).toBeHidden();
    await this.page.waitForTimeout(500);
  }

  /** Delete a project by name */
  async deleteProject(name: string) {
    const project = this.page.locator(S.projectGroup, {
      has: this.page.locator(S.projectName, { hasText: name }),
    });
    await project.locator(S.projectDelete).click();

    await expect(this.page.locator(S.confirmModal)).toBeVisible();
    await this.page.click(S.confirmDelete);
    await expect(this.page.locator(S.confirmModal)).toBeHidden();
    await this.page.waitForTimeout(500);
  }

  /** Open the file browser for a project */
  async openFileBrowser(projectName: string) {
    const project = this.page.locator(S.projectGroup, {
      has: this.page.locator(S.projectName, { hasText: projectName }),
    });
    await project.locator(S.projectFilesToggle).click();
    await this.page.waitForTimeout(500);
  }

  /** Type text into the active terminal and press Enter */
  async typeInTerminal(text: string) {
    await this.page.keyboard.type(text);
    await this.page.keyboard.press('Enter');
  }

  /** Wait for substring in active terminal's xterm buffer */
  async waitForTerminalOutput(substring: string, timeout = 30_000) {
    await waitForTerminalOutput(this.page, substring, timeout);
  }

  /** Check if active terminal has any content */
  async terminalHasContent(): Promise<boolean> {
    return terminalHasContent(this.page);
  }

  /** Close a tab by its label text */
  async closeTab(label: string) {
    const tab = this.page.locator(S.tab, {
      has: this.page.locator(S.tabLabel, { hasText: label }),
    });
    await tab.locator(S.tabClose).click();
    await this.page.waitForTimeout(300);
  }

  /**
   * Simulate drag-and-drop of a file onto the file tree.
   * Creates a DataTransfer with a File object and dispatches drop event.
   */
  async dropFileOnTree(projectName: string, fileName: string, content: string) {
    const project = this.page.locator(S.projectGroup, {
      has: this.page.locator(S.projectName, { hasText: projectName }),
    });
    const fileTree = project.locator(S.fileTree);
    await expect(fileTree).toBeVisible();

    await fileTree.evaluate(
      (el: HTMLElement, { fileName, content }: { fileName: string; content: string }) => {
        const file = new File([content], fileName, { type: 'text/markdown' });
        const dt = new DataTransfer();
        dt.items.add(file);

        const dragover = new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        el.dispatchEvent(dragover);

        const drop = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        el.dispatchEvent(drop);
      },
      { fileName, content }
    );
  }
}

// Extend Playwright's base test with our fixture
export const test = base.extend<{ eve: EvePage }>({
  eve: async ({ page }, use) => {
    const eve = new EvePage(page);
    await use(eve);
  },
});

export { expect };
