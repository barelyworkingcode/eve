// eve#196: an errored headless Claude agent under "Needs you" offers Drop in. It
// opens an eve terminal on the same conversation; relay's refusal shows as its
// own words; other harnesses and non-headless sessions offer nothing.
// docs/design-workbench.md
const { test, expect } = require('./fixture');
const { nav } = require('./today-helpers');

const T0 = '2026-10-05T10:00:00.000Z';
const WITHIN_2S = { timeout: 2000 };
const TOOL_RUNNING = { error: 'tool_running', message: 'a tool is running (Bash); wait for it to finish or stop the turn, then try again' };

const errored = (folders, id, name, model, headless) => ({
  sessionId: id, name, projectId: 'alpha', directory: folders.alpha, model, headless,
  attention: { state: 'errored', since: T0 },
});

test.use({
  world: {
    seed: ({ relay, folders }) => {
      relay.seedSession(errored(folders, 's-claude', 'Acme build', 'haiku', true));
    },
  },
});

const group = (page, prefix, key) => page.getByTestId(`${prefix}-agents-group-${key}`);
const dropTab = (page) => page.locator('.tab', { hasText: 'Acme build (drop-in)' });

async function openAlphaPage(page) {
  await nav(page).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('panel-project-page').click();
  await expect(page.getByTestId('project-page-alpha')).toBeVisible();
}

test.describe('drop in from the agent board', () => {
  test('Drop in opens a terminal', async ({ page, eve }) => {
    await expect(group(page, 'today', 'needs').getByTestId('today-agent-s-claude')).toBeVisible();
    await page.getByTestId('today-drop-in-s-claude').click();

    await expect(dropTab(page)).toHaveClass(/active/);
    expect(eve.relay.dropIns).toEqual([{ sessionId: 's-claude', body: { cols: 80, rows: 24 } }]);
    const [{ terminalId }] = eve.relay.listTerminals();
    await eve.relay.waitForInbound((m) => m.type === 'join_terminal' && m.terminalId === terminalId);

    await dropTab(page).locator('.tab-close').click();
    const close = await eve.relay.waitForInbound((m) => m.type === 'terminal_close');
    expect(close.terminalId).toBe(terminalId);
    await expect(group(page, 'today', 'working').getByTestId('today-agent-s-claude')).toBeVisible(WITHIN_2S);
    await expect(group(page, 'today', 'needs').getByTestId('today-agent-s-claude')).toHaveCount(0);
  });

  test('the project page offers the same action', async ({ page }) => {
    await openAlphaPage(page);
    await expect(group(page, 'project', 'needs').getByTestId('project-agent-s-claude')).toBeVisible();
    await expect(page.getByTestId('project-drop-in-s-claude')).toBeVisible();
  });

  test('a refusal shows relay\'s reason, opens no terminal and leaves the button usable', async ({ page, eve }) => {
    eve.relay.failDropInWith(409, TOOL_RUNNING);
    const button = page.getByTestId('today-drop-in-s-claude');
    await button.click();
    await expect(page.locator('.toast__message', { hasText: TOOL_RUNNING.message })).toBeVisible(WITHIN_2S);
    await expect(button).toBeEnabled();
    await expect(page.locator('.tab', { hasText: '(drop-in)' })).toHaveCount(0);
    expect(eve.relay.listTerminals()).toHaveLength(0);
  });
});

test.describe('no Drop in for these rows', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        relay.seedSession(errored(folders, 's-claude', 'Acme build', 'haiku', true));
        relay.seedSession(errored(folders, 's-pi', 'Pi agent', 'pi/x', true));
        relay.seedSession(errored(folders, 's-codex', 'Codex agent', 'codex/x', true));
        relay.seedSession(errored(folders, 's-chat', 'Interactive', 'haiku', false));
      },
    },
  });

  test('pi, codex and non-headless rows sit under Needs you with no action; the headless Claude row has it', async ({ page }) => {
    for (const id of ['s-claude', 's-pi', 's-codex', 's-chat']) {
      await expect(group(page, 'today', 'needs').getByTestId(`today-agent-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('today-drop-in-s-claude')).toBeVisible();
    for (const id of ['s-pi', 's-codex', 's-chat']) {
      await expect(page.getByTestId(`today-drop-in-${id}`)).toHaveCount(0);
    }
  });
});
