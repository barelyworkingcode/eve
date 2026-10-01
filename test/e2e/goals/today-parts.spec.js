// S1-A6 Today is built from independent parts. The two journeys the epic names,
// written red first: one part failing, one part slow. docs/design-today-s1.md
const { test, expect } = require('./fixture');
const { MODELS } = require('./fixture');
const { part } = require('./today-helpers');

const state = (page, id) => part(page, id).getAttribute('data-state');

test.describe('S1-A6 one part failing', () => {
  test.use({
    world: {
      seed: ({ relay }) => {
        relay.setModels(MODELS);
        relay.setDefaultProject('work', 'alpha');
        relay.failRoute('GET', '/api/tasks', 503, { error: 'scheduler unavailable' });
      },
    },
  });

  test('its source is down: that part shows one line with Retry; the others render normally', async ({ page, eve }) => {
    await expect(part(page, 'needs-you')).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('today-error-needs-you')).toBeVisible();
    await expect(page.getByTestId('today-retry-needs-you')).toBeVisible();
    for (const ok of ['summary', 'ask', 'start', 'projects']) {
      await expect(part(page, ok)).toHaveAttribute('data-state', 'ready');
    }
    await expect(page.getByTestId('home-project-alpha')).toBeVisible();
    await expect(page.getByTestId('today-ask-input')).toBeFocused();

    eve.relay.clearRouteFaults();
    await page.getByTestId('today-retry-needs-you').click();
    await expect(part(page, 'needs-you')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('today-error-needs-you')).toHaveCount(0);
  });

  test('Continue does not list task runs as threads while it cannot tell: it shows its own error too', async ({ page }) => {
    await expect(part(page, 'continue')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('[data-testid^="home-session-"]')).toHaveCount(0);
  });

  test('a part that is down does not stop the sidebar or a thread from starting', async ({ page, eve }) => {
    await page.getByTestId('today-ask-input').fill('still works');
    await page.getByTestId('today-ask-input').press('Enter');
    await expect.poll(() => eve.relay.sessionCreates.length).toBe(1);
  });
});

test.describe('S1-A6 one part slow', () => {
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        relay.setModels(MODELS);
        relay.setDefaultProject('work', 'alpha');
        relay.delayRoute('GET', '/api/tasks', 4000);
        relay.seedSession({ sessionId: 's1', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Old thread', live: false, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(), messageCount: 1 });
      },
    },
  });

  test('a slow source shows a skeleton while the others are ready and usable', async ({ page, eve }) => {
    await expect(part(page, 'needs-you')).toHaveAttribute('data-state', 'loading');
    await expect(part(page, 'ask')).toHaveAttribute('data-state', 'ready');
    await expect(part(page, 'projects')).toHaveAttribute('data-state', 'ready');
    await expect(part(page, 'start')).toHaveAttribute('data-state', 'ready');

    // Usable: type and press Return while the slow part is still loading.
    await page.getByTestId('today-ask-input').fill('not waiting for tasks');
    await page.getByTestId('today-ask-input').press('Enter');
    await expect.poll(() => eve.relay.sessionCreates.length).toBe(1);
    expect(await state(page, 'needs-you')).not.toBe('error');
  });

  test('a slow tasks call does not delay projects, sessions or tab restore', async ({ page }) => {
    await expect(page.getByTestId('home-project-alpha')).toBeVisible({ timeout: 2000 });
    await page.waitForFunction(() => window.client.state.sessions.has('s1'), null, { timeout: 2000 });
  });

  test('Continue stays loading rather than showing a task run as a thread, then fills in', async ({ page }) => {
    await expect(part(page, 'continue')).toHaveAttribute('data-state', 'loading');
    await expect(part(page, 'continue')).toHaveAttribute('data-state', 'ready', { timeout: 15000 });
    await expect(page.getByTestId('home-session-s1')).toBeVisible();
  });
});

test.describe('S1-A6 events reach only the parts that subscribe', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); } } });

  test('a session and a project event leave Ask\'s node, text and focus alone', async ({ page }) => {
    const input = page.getByTestId('today-ask-input');
    await input.fill('half a thought');
    await page.evaluate(() => { document.querySelector('[data-testid="today-ask-input"]').__kept = true; });
    await page.evaluate(() => {
      const st = window.client.state;
      st.addSession({ id: 'late', projectId: 'alpha', name: 'Late', directory: '/x', model: 'm', live: false, createdAt: new Date().toISOString(), messageCount: 1 });
      st.updateSession('late', { name: 'Renamed' });
      st.setProjects([...st.projects.values()]);
    });
    await expect(page.getByTestId('home-session-late')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('[data-testid="today-ask-input"]').__kept)).toBe(true);
    await expect(input).toHaveValue('half a thought');
    await expect(input).toBeFocused();
  });
});
