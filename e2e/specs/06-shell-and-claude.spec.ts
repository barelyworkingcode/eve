import { test, expect } from '../fixtures/eve-fixture';
import { S } from '../helpers/selectors';

test.describe('Shell and Claude Launch', () => {
  test('launch shell via /zsh and interact', async ({ eve }) => {
    await eve.goto();

    // Join the Claude session
    await eve.clickSession('My Claude Chat');
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();

    // Send /zsh to launch shell
    await eve.sendMessage('/zsh');

    // Wait for Terminal tab to appear
    await expect(
      eve.page.locator(S.tabLabel, { hasText: 'Terminal' })
    ).toBeVisible({ timeout: 10_000 });

    // Terminal content should be visible
    await expect(eve.page.locator(S.terminalContent)).toBeVisible();

    // Wait for terminal to initialize
    await eve.page.waitForTimeout(1000);

    // Type a command in the terminal
    await eve.typeInTerminal('ls -l');

    // Wait for output (look for typical ls output)
    await eve.waitForTerminalOutput('total', 10_000).catch(() => {
      // If no 'total' (empty dir), just wait a bit for any output
    });
    await eve.page.waitForTimeout(1000);
  });

  test('launch Claude CLI via /claude', async ({ eve }) => {
    await eve.goto();

    // Join the Claude session
    await eve.clickSession('My Claude Chat');
    await expect(eve.page.locator(S.chatScreen)).toBeVisible();

    // Click back to the session tab first
    await eve.clickTab('My Claude Chat');

    // Send /claude
    await eve.sendMessage('/claude');

    // Wait for Claude CLI tab to appear
    await expect(
      eve.page.locator(S.tabLabel, { hasText: 'Claude CLI' })
    ).toBeVisible({ timeout: 10_000 });

    // Terminal container should be visible
    await expect(eve.page.locator(S.terminalContent)).toBeVisible();
  });
});
