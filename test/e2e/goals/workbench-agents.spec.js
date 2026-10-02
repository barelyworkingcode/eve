// S5a-A3 agent board: live terminals on Today and on the project page, each with
// its state and last line; a tap attaches, nothing opens by itself.
// docs/design-workbench.md
const os = require('os');
const path = require('path');
const { test, expect } = require('./fixture');
const { nav } = require('./today-helpers');

const TEMPLATES = [
  { id: 'claude', name: 'Claude Code', description: 'Agent', sandbox: true },
  { id: 'shell', name: 'Shell', description: 'Plain shell', sandbox: true },
];
const LOG_LINE = 'TERMINAL-LOG-BYTES'; // the fake's GET /api/terminals/:id/log body

const world = {
  projects: ({ alpha, beta }) => [
    { id: 'alpha', name: 'Alpha Project', path: alpha },
    { id: 'beta', name: 'Beta Project', path: beta },
    { id: 'homeonly', name: 'Home Only', path: path.join(beta, 'home'), mode: 'home' },
  ],
  seed: ({ relay, folders }) => {
    relay.setTerminalTemplates(TEMPLATES);
    const term = (terminalId, templateId, name, directory, extra = {}) =>
      relay.seedTerminal({ terminalId, templateId, name, directory, ...extra });
    term('t-a1', 'claude', 'Claude Code', folders.alpha);
    term('t-a2', 'shell', 'Shell', path.join(folders.alpha, 'src'));
    term('t-b1', 'shell', 'Shell', folders.beta);
    term('t-h1', 'shell', 'Shell', path.join(folders.beta, 'home'));
    term('t-x1', 'shell', 'Shell', path.join(os.tmpdir(), 'eve-no-project-dir'));
    // A task's terminal run: relay lists it like any other terminal.
    term('t-run', 'shell', 'Digest', folders.alpha);
    relay.seedTask({
      id: 'task-1', name: 'Digest', projectId: 'alpha', prompt: 'p', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'pty', lastTerminalId: 't-run',
    });
  },
};

const todayRow = (page, id) => page.getByTestId(`today-agent-${id}`);
const pageRow = (page, id) => page.getByTestId(`project-agent-${id}`);
const agentRows = (page, prefix) => page.locator(`[data-testid^="${prefix}-agent-"]`);
const screenText = (page, id) => page.evaluate((tid) => {
  const buf = window.client.terminalManager.terminals.get(tid)?.term?.buffer.active;
  let out = '';
  for (let i = 0; buf && i < buf.length; i++) out += `${buf.getLine(i)?.translateToString(true) || ''}\n`;
  return out;
}, id);
const logGets = (eve, id) => eve.relay.requests.filter((r) => r.method === 'GET' && r.path === `/api/terminals/${id}/log`);

async function openAlphaPage(page) {
  await nav(page).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('panel-project-page').click();
  await expect(page.getByTestId('project-page-alpha')).toBeVisible();
}

// Records any moment a terminal, a #terminal link or any tab appears, from the
// first script on a fresh load.
async function reloadWatchingForTerminals(page) {
  await page.addInitScript(() => {
    window.__opened = [];
    setInterval(() => {
      if (document.getElementById('terminal')?.checkVisibility()) window.__opened.push('#terminal shown');
      if (location.hash.startsWith('#terminal')) window.__opened.push(location.hash);
      const n = window.client?.tabManager?.tabs?.length;
      if (n) window.__opened.push(`${n} tab(s)`);
    }, 25);
  });
  await page.reload();
  await page.waitForFunction(() => !!window.client?.state);
}
const opened = (page) => page.evaluate(() => window.__opened);

test.describe('S5a-A3 agent board', () => {
  test.use({ world });

  test('Today lists the in-mode and project-less terminals, the page lists alpha\'s, task runs neither; nothing opens', async ({ page, eve }) => {
    await reloadWatchingForTerminals(page);
    await page.waitForFunction(() => window.client.state.isTaskRun('t-run'));
    for (const id of ['t-a1', 't-a2', 't-b1', 't-x1']) await expect(todayRow(page, id)).toBeVisible();
    await expect(agentRows(page, 'today')).toHaveCount(4);
    const a1 = todayRow(page, 't-a1');
    for (const text of ['Claude Code', 'Alpha Project', 'open']) await expect(a1).toContainText(text);
    await expect(todayRow(page, 't-b1')).toContainText('Beta Project');
    expect(await opened(page)).toEqual([]);

    await openAlphaPage(page);
    await expect(pageRow(page, 't-a1')).toBeVisible();
    await expect(pageRow(page, 't-a2')).toBeVisible();
    await expect(agentRows(page, 'project')).toHaveCount(2);
    await expect(pageRow(page, 't-a1')).not.toContainText('Alpha Project');
    await expect(page.locator('#terminal')).toBeHidden();
    expect((await opened(page)).filter((e) => e.includes('#terminal'))).toEqual([]);
    expect(eve.relay.inbound.filter((m) => m.type === 'join_terminal' || m.type === 'terminal_create')).toEqual([]);
  });

  test('a terminal listed and then joined unasked never activates', async ({ page, eve }) => {
    await reloadWatchingForTerminals(page);
    await expect(todayRow(page, 't-a1')).toBeVisible();
    await eve.relay.emitToRelay({
      type: 'terminal_joined', terminalId: 't-a1', templateId: 'claude', name: 'Claude Code',
      directory: eve.folders.alpha, state: 'running', cols: 80, rows: 24, scrollback: Buffer.from('$ ').toString('base64'), host: null,
    });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('home-screen')).toBeVisible();
    expect((await opened(page)).filter((e) => e.includes('#terminal'))).toEqual([]);
  });

  test('a tap opens that terminal, a second tap switches to its tab; no new terminal', async ({ page, eve }) => {
    await todayRow(page, 't-a1').click();
    await expect(page.locator('#terminal')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.client.terminalManager.activeTerminalId)).toBe('t-a1');

    await nav(page).getByTitle('Beta Project', { exact: true }).click();
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await todayRow(page, 't-a1').click();
    await expect(page.locator('#terminal')).toBeVisible();
    expect(await page.evaluate(() => window.client.tabManager.tabs.filter((t) => t.id === 't-a1').length)).toBe(1);
    expect(eve.relay.inbound.filter((m) => m.type === 'terminal_create')).toEqual([]);
  });

  test('the last line comes from the log, fetched once across both boards and a second terminal_list', async ({ page, eve }) => {
    await expect(todayRow(page, 't-a1').locator('.agent-row__last')).toHaveText(LOG_LINE);
    await openAlphaPage(page);
    await expect(pageRow(page, 't-a1').locator('.agent-row__last')).toHaveText(LOG_LINE);
    await page.evaluate(() => window.client.terminalManager.requestTerminalList());
    await page.waitForTimeout(1000);
    expect(logGets(eve, 't-a1')).toHaveLength(1);
  });

  test('a held terminal\'s line is read from its screen', async ({ page }) => {
    await todayRow(page, 't-a1').click();
    await expect(page.locator('#terminal')).toBeVisible();
    await page.locator('#terminal .xterm-screen').filter({ visible: true }).last().click();
    await page.keyboard.type('echo held-screen-line');
    await expect.poll(() => screenText(page, 't-a1')).toContain('held-screen-line');
    await page.getByTestId('panel-project-page').click();
    await expect(pageRow(page, 't-a1').locator('.agent-row__last')).toContainText('held-screen-line');
  });

  test('a held terminal that exits says "exited 1"', async ({ page, eve }) => {
    await todayRow(page, 't-a1').click();
    await expect(page.locator('#terminal')).toBeVisible();
    await page.getByTestId('panel-project-page').click();
    await expect(pageRow(page, 't-a1')).toContainText('open');
    eve.relay.seedTerminal({ terminalId: 't-a1', templateId: 'claude', name: 'Claude Code', directory: eve.folders.alpha, state: 'stopped' });
    await eve.relay.emitToRelay({ type: 'terminal_exit', terminalId: 't-a1', exitCode: 1 });
    await expect(pageRow(page, 't-a1')).toContainText('exited 1');
  });

  test('a stopped terminal says exited', async ({ page, eve }) => {
    eve.relay.seedTerminal({ terminalId: 't-a2', templateId: 'shell', name: 'Shell', directory: eve.folders.alpha, state: 'stopped' });
    await page.reload();
    await expect(todayRow(page, 't-a2')).toContainText('exited');
    await expect(todayRow(page, 't-a2')).not.toContainText('open');
  });
});

test.describe('S5a-A3 agent board, a log relay has not got', () => {
  test.use({ world: { ...world, seed: (eve) => { world.seed(eve); eve.relay.failRoute('GET', '/api/terminals/t-a2/log', 404); } } });

  test('a log 404 shows no line', async ({ page, eve }) => {
    await expect(todayRow(page, 't-a1').locator('.agent-row__last')).toHaveText(LOG_LINE);
    await expect.poll(() => logGets(eve, 't-a2').length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(todayRow(page, 't-a2')).toBeVisible();
    await expect(todayRow(page, 't-a2')).not.toContainText(LOG_LINE);
    expect(await todayRow(page, 't-a2').evaluate((el) => el.querySelector('.agent-row__last')?.textContent || '')).toBe('');
  });
});

test.describe('S5a-A3 agent board with nothing to show', () => {
  test('no terminals reads "No agents running"', async ({ page }) => {
    await expect(page.getByTestId('today-part-agents')).toContainText('No agents running');
  });

  test('relay down says "Can\'t reach relay"', async ({ page, eve }) => {
    await eve.relay.close();
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await expect(page.getByTestId('today-part-agents')).toContainText("Can't reach relay");
  });
});
