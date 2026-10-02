// S5b-A2 Make this a routine, from a thread's header. docs/design-routines.md
const { test, expect } = require('./fixture');

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
const LONG_TITLE = 'Plan the launch checklist for the Acme spring release and its notes';
const MODELS = {
  models: [{ value: 'fake-model', label: 'Fake Model' }, { value: 'other-model', label: 'Other Model' }],
  providerSettings: {},
};
const panel = (page) => page.getByTestId('routine-panel');
const isTaskPost = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks';

function world(alphaExtra = {}) {
  return {
    projects: ({ alpha, beta }) => [
      { id: 'alpha', name: 'Alpha', path: alpha, ...alphaExtra },
      { id: 'beta', name: 'Beta', path: beta },
    ],
    seed: ({ relay, folders }) => {
      relay.setModels(MODELS);
      const thread = (sessionId, name, history, extra = {}) => relay.seedSession({
        sessionId, projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name, history,
        live: false, createdAt: iso(3), lastMessageAt: iso(2), messageCount: history.length, ...extra,
      });
      thread('s-plan', LONG_TITLE, [
        { timestamp: iso(3), role: 'user', content: 'Summarise the inbox.' },
        { timestamp: iso(3), role: 'assistant', content: [{ type: 'text', text: 'Three new messages.' }] },
      ]);
      thread('s-empty', 'Blank thread', []);
      thread('run9', 'Nightly', [{ timestamp: iso(5), role: 'user', content: 'Nightly prompt' }], { headless: true });
      relay.seedTask({
        id: 't9', name: 'Nightly', projectId: 'alpha', prompt: 'Nightly prompt', model: 'fake-model', schedule: { type: 'on_demand' },
        enabled: true, sessionType: 'headless', lastSessionId: 'run9', lastStatus: 'success', lastRun: iso(5),
      });
    },
  };
}

async function openPlanThread(page) {
  await page.getByTestId('home-session-s-plan').click();
  await expect(page.getByTestId('messages-container')).toContainText('Summarise the inbox.');
}

test.describe('S5b-A2 make this a routine', () => {
  test.use({ world: world() });

  test('the header action opens the panel filled from the thread, reading Every day at 09:00 by default', async ({ page }) => {
    await openPlanThread(page);
    await page.getByTestId('thread-make-routine').click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId('routine-panel-name')).toHaveValue(LONG_TITLE.slice(0, 60));
    await expect(page.getByTestId('routine-panel-prompt')).toHaveValue('Summarise the inbox.');
    await expect(page.getByTestId('routine-panel-model')).toHaveValue('fake-model');
    await expect(page.getByTestId('routine-panel-model-note')).toHaveCount(0);
    await expect(page.getByTestId('routine-panel-sentence')).toHaveText('Every day at 09:00, in Alpha, using Fake Model.');
  });

  test('Every Monday at 08:00: the read-back, one POST, the panel closes, and #routines shows the same sentence', async ({ page, eve }) => {
    await openPlanThread(page);
    await page.getByTestId('thread-make-routine').click();
    await page.getByTestId('routine-panel-prompt').fill('Summarise the inbox, briefly.');
    await page.getByTestId('routine-panel-when-weekly').click();
    await page.getByTestId('routine-panel-day').selectOption('monday');
    await page.getByTestId('routine-panel-time').fill('08:00');
    const readBack = page.getByTestId('routine-panel-sentence');
    await expect(readBack).toHaveText('Every Monday at 08:00, in Alpha, using Fake Model.');

    const posts = [];
    page.on('request', (r) => { if (isTaskPost(r)) posts.push(r.postDataJSON()); });
    await page.getByTestId('routine-panel-create').click();
    await expect(panel(page)).toBeHidden();
    await expect.poll(() => eve.relay.listTasks().length).toBe(2);
    expect(posts).toEqual([{
      name: LONG_TITLE.slice(0, 60), projectId: 'alpha', prompt: 'Summarise the inbox, briefly.', model: 'fake-model',
      schedule: { type: 'weekly', day: 'monday', time: '08:00' }, enabled: true, sessionType: 'headless', catchUp: false,
    }]);

    const created = eve.relay.listTasks().find((t) => t.id !== 't9');
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('Routines');
    await page.getByTestId('palette-item').filter({ hasText: 'Routines' }).first().click();
    await expect(page.getByTestId(`routine-${created.id}`).locator('.routine-row__sentence')).toHaveText('Every Monday at 08:00');
  });

  test('a failed create keeps the panel open and shows the save-error toast', async ({ page, eve }) => {
    eve.relay.failTaskCreateWith(400, { error: 'name is required' });
    await openPlanThread(page);
    await page.getByTestId('thread-make-routine').click();
    await page.getByTestId('routine-panel-create').click();
    await expect(page.locator('.toast[data-toast-id="task-save-error"]')).toBeVisible();
    await expect(panel(page)).toBeVisible();
  });

  test('no action on a thread without a first user message, nor on a task run', async ({ page }) => {
    await openPlanThread(page);
    await expect(page.getByTestId('thread-make-routine')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('Blank thread');
    await page.getByTestId('palette-item').filter({ hasText: 'Blank thread' }).first().click();
    await expect(page.getByTestId('tab-s-empty')).toBeVisible();
    await expect(page).toHaveURL(/#session\/s-empty/);
    await expect(page.getByTestId('thread-make-routine')).toBeHidden();

    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha', { exact: true }).click();
    await page.getByTestId('panel-project-page').click();
    await page.getByTestId('project-task-t9').click();
    await expect(page.getByTestId('messages-container')).toContainText('Nightly prompt');
    await expect(page.getByTestId('thread-make-routine')).toBeHidden();
  });
});

test.describe('S5b-A2 a thread typed live', () => {
  test.use({ world: world() });

  test('a new chat offers the action once its first message is sent, without a switch', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha', { exact: true }).click();
    await page.getByTestId('sidebar-new-session-alpha').click();
    await page.getByTestId('shell-card-web-chat').click();
    await page.getByRole('button', { name: 'Start Chat' }).click();
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('thread-make-routine')).toBeHidden();
    await page.getByTestId('chat-input').fill('Check the build every morning.');
    await page.getByTestId('chat-submit').click();
    await expect(page.getByTestId('messages-container')).toContainText('Hello from fake relay', { timeout: 15000 });
    await page.getByTestId('thread-make-routine').click({ timeout: 5000 });
    await expect(page.getByTestId('routine-panel-prompt')).toHaveValue('Check the build every morning.');
  });
});

test.describe('S5b-A2 a model the project no longer allows', () => {
  test.use({ world: world({ allowed_models: ['other-model'] }) });

  test('the panel uses the first allowed model and says why', async ({ page }) => {
    await openPlanThread(page);
    await page.getByTestId('thread-make-routine').click();
    await expect(page.getByTestId('routine-panel-model')).toHaveValue('other-model');
    // The contract does not pin whether <old> is the model's label or its id.
    await expect(page.getByTestId('routine-panel-model-note'))
      .toHaveText(/^(Fake Model|fake-model) isn't allowed in Alpha now, so this uses Other Model\.$/);
    await expect(page.getByTestId('routine-panel-sentence')).toHaveText('Every day at 09:00, in Alpha, using Other Model.');
  });
});
