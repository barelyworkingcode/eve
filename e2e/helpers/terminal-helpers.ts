import { Page } from '@playwright/test';

/**
 * Waits for a substring to appear in the active xterm.js terminal buffer.
 * xterm renders to canvas, so we read from the buffer API directly.
 */
export async function waitForTerminalOutput(
  page: Page,
  substring: string,
  timeout = 30_000
): Promise<void> {
  await page.waitForFunction(
    (needle: string) => {
      const tm = (window as any).client?.terminalManager;
      if (!tm?.activeTerminalId) return false;
      const terminal = tm.terminals.get(tm.activeTerminalId);
      if (!terminal) return false;
      const buffer = terminal.term.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)?.translateToString(true);
        if (line && line.includes(needle)) return true;
      }
      return false;
    },
    substring,
    { timeout }
  );
}

/**
 * Checks if the active terminal buffer has any non-empty lines.
 */
export async function terminalHasContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const tm = (window as any).client?.terminalManager;
    if (!tm?.activeTerminalId) return false;
    const terminal = tm.terminals.get(tm.activeTerminalId);
    if (!terminal) return false;
    const buffer = terminal.term.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)?.translateToString(true)?.trim();
      if (line) return true;
    }
    return false;
  });
}
