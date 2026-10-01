// S1-A3 truthful states. "running" is a turn in progress or an executing task run;
// a merely live provider process is not. docs/design-today-s1.md
const { test, expect } = require('./fixture');
const { relayFrames } = require('../../integration/protocol');
const { part, startChatInAlpha, backToToday } = require('./today-helpers');

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test.describe('S1-A3 a live but idle thread is not running', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        relay.seedSession({ sessionId: 's-live', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Live one', live: true, createdAt: iso(HOUR), lastMessageAt: iso(HOUR / 2), messageCount: 1 });
      },
    },
  });

  test('no dot, not counted, not in Running; its row is still in Continue', async ({ page }) => {
    await expect(page.getByTestId('home-session-s-live')).toBeVisible();
    await expect(page.locator('.home__subtitle')).toContainText('Nothing running');
    await expect(page.locator('.home__live')).toHaveCount(0);
    await expect(page.getByTestId('today-running-row-s-live')).toHaveCount(0);
  });

  test('a thread this browser never joined has no turn state anywhere', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-tab-sessions').click();
    await expect(page.getByTestId('sidebar-session-s-live')).toBeVisible();
    await expect(page.locator('.rail__live, .project-tree__live')).toHaveCount(0);
  });
});

test.describe('S1-A3 a turn in progress', () => {
  test('is running until the turn completes', async ({ page, eve }) => {
    const sessionId = await startChatInAlpha(page);
    // A delta with no message_complete: the turn stays in progress.
    eve.relay.scriptSession(sessionId, [relayFrames.assistantDelta({ sessionId, text: 'thinking out loud' })]);
    await page.getByTestId('chat-input').fill('go');
    await page.getByTestId('chat-submit').click();
    await expect(page.getByTestId('messages-container')).toContainText('thinking out loud');
    await backToToday(page);

    await expect(page.getByTestId(`today-running-row-${sessionId}`)).toBeVisible();
    await expect(page.locator('.home__subtitle')).toContainText('1 session running');
    await expect(page.getByTestId(`home-session-${sessionId}`).locator('.home__live')).toHaveCount(1);

    eve.relay.emitToSession(sessionId, relayFrames.messageComplete({ sessionId }));
    await expect(page.getByTestId(`today-running-row-${sessionId}`)).toHaveCount(0);
    await expect(page.locator('.home__subtitle')).toContainText('Nothing running');
    await expect(page.getByTestId(`home-session-${sessionId}`).locator('.home__live')).toHaveCount(0);
    eve.relay.scriptSession(sessionId, undefined);
  });

  test('after the relay leg drops, a turn that may have finished is no longer called running', async ({ page, eve }) => {
    const sessionId = await startChatInAlpha(page);
    eve.relay.scriptSession(sessionId, [relayFrames.assistantDelta({ sessionId, text: 'partial' })]);
    await page.getByTestId('chat-input').fill('go');
    await page.getByTestId('chat-submit').click();
    await backToToday(page);
    await expect(page.getByTestId(`today-running-row-${sessionId}`)).toBeVisible();

    eve.relay.closeRelaySockets();
    await expect(page.getByTestId(`today-running-row-${sessionId}`)).toHaveCount(0, { timeout: 15000 });
    eve.relay.scriptSession(sessionId, undefined);
  });
});

test.describe('S1-A3 waiting and failed', () => {
  test('a permission request puts the thread in Needs you as waiting; answering clears it', async ({ page, eve }) => {
    const sessionId = await startChatInAlpha(page);
    await backToToday(page);
    eve.relay.emitToSession(sessionId, relayFrames.permissionRequest({ sessionId, permissionId: 'perm-1', toolName: 'Bash', toolInput: '{}', toolUseId: 'tu-1' }));
    const row = page.getByTestId(`today-needs-row-${sessionId}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-kind', 'waiting');
    await expect(row).toContainText('waiting for you');
    await page.getByTestId('modal-permission-allow').click();
    await expect(row).toHaveCount(0);
  });

  test('a turn that ends in an error is failed, in plain words; the next turn clears it', async ({ page, eve }) => {
    const sessionId = await startChatInAlpha(page);
    await backToToday(page);
    eve.relay.emitToSession(sessionId, relayFrames.error({ message: 'model unavailable', sessionId }));
    const row = page.getByTestId(`today-needs-row-${sessionId}`);
    await expect(row).toHaveAttribute('data-kind', 'failed');
    await expect(row).toContainText('model unavailable');
    eve.relay.emitToSession(sessionId, relayFrames.assistantDelta({ sessionId, text: 'again' }));
    await expect(row).toHaveCount(0);
  });

  test('an error with no session, and resume_required, never mark a thread failed', async ({ page, eve }) => {
    const sessionId = await startChatInAlpha(page);
    await backToToday(page);
    eve.relay.emitToRelay({ type: 'error', message: 'something unrelated' });
    eve.relay.emitToSession(sessionId, relayFrames.resumeRequired({ sessionId }));
    await page.waitForTimeout(500);
    await expect(page.getByTestId(`today-needs-row-${sessionId}`)).toHaveCount(0);
  });
});

test.describe('S1-A3 tasks', () => {
  test.use({
    world: {
      seed: ({ relay }) => {
        const base = { projectId: 'alpha', prompt: 'p', model: 'fake-model', schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless' };
        relay.seedTask({ ...base, id: 't-err', name: 'Broke', lastStatus: 'error' });
        relay.seedTask({ ...base, id: 't-timeout', name: 'Slow one', lastStatus: 'timeout' });
        relay.seedTask({ ...base, id: 't-ok', name: 'Fine', lastStatus: 'success' });
        relay.seedTask({ ...base, id: 't-run', name: 'Busy', lastStatus: 'running' });
      },
    },
  });

  test('error and timeout runs are in Needs you; success is not; an executing run is in Running', async ({ page }) => {
    await expect(page.getByTestId('today-needs-row-t-err')).toHaveAttribute('data-kind', 'failed');
    await expect(page.getByTestId('today-needs-row-t-timeout')).toHaveAttribute('data-kind', 'failed');
    await expect(page.getByTestId('today-needs-row-t-ok')).toHaveCount(0);
    await expect(page.getByTestId('today-running-row-t-run')).toBeVisible();
    await expect(page.getByTestId('today-running-row-t-err')).toHaveCount(0);
  });

  test('Needs you says "Nothing needs you" only when its sources loaded', async ({ page }) => {
    await expect(part(page, 'needs-you')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('today-needs-row-t-err')).toBeVisible();
    await expect(part(page, 'needs-you')).not.toContainText('Nothing needs you');
  });
});

test.describe('S1-A3 relay unreachable', () => {
  test('a project, session or task list that could not load is not presented as empty', async ({ page, eve }) => {
    await eve.relay.close();
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start with a project' })).toHaveCount(0);
    await expect(page.getByText('Nothing yet. Start a session above')).toHaveCount(0);
    await expect(page.getByTestId('today-error-projects')).toContainText("Can't reach relay");
    await expect(page.getByTestId('today-retry-projects')).toBeVisible();
    await expect(page.getByTestId('today-ask-input')).toBeVisible();
  });

  test('Retry brings the projects back once relay returns', async ({ page, eve }) => {
    await eve.relay.close();
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await expect(page.getByTestId('today-retry-projects')).toBeVisible();
    await eve.reviveRelay({ projects: [{ id: 'alpha', name: 'Alpha Project', path: eve.folders.alpha }] });
    await page.getByTestId('today-retry-projects').click();
    await expect(page.getByTestId('home-project-alpha')).toBeVisible({ timeout: 15000 });
    await expect(part(page, 'projects')).toHaveAttribute('data-state', 'ready');
  });
});
