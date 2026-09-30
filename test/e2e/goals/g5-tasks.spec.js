// G5 · Hand a task off and come back later. G6 · Check what my agents did.
// The task is saved, runs when told, and its last run is readable afterwards.
const { test, expect } = require('./fixture');

test.use({
  world: {
    seed: ({ relay }) => {
      relay.setModels({ models: [{ value: 'fake-model', label: 'Fake Model' }], providerSettings: {} });
    },
  },
});

async function openTasks(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('panel-tab-tasks').click();
}

async function createTask(page, name) {
  await page.getByTestId('sidebar-task-new-alpha').click();
  const dialog = page.getByTestId('dialog-task-dialog');
  await dialog.locator('.dialog__tab[data-tab="new"]').click();
  await dialog.locator('[name="taskName"]').fill(name);
  await dialog.locator('[name="taskType"]').selectOption('headless');
  await dialog.locator('[name="taskPrompt"]').fill('Summarise the README.');
  await dialog.locator('[name="scheduleType"]').selectOption('on_demand');
  const model = dialog.locator('[name="taskModel"]');
  await expect(model.locator('option[value="fake-model"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Create Task' }).click();
}

test.describe('G5/G6 tasks', () => {
  test('a new task is saved at the scheduler and listed under the project', async ({ page, eve }) => {
    await openTasks(page);
    await createTask(page, 'Readme digest');
    await expect.poll(() => eve.relay.listTasks().length).toBe(1);
    expect(eve.relay.listTasks()[0]).toMatchObject({
      name: 'Readme digest', projectId: 'alpha', prompt: 'Summarise the README.', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true,
    });
    const item = page.locator('[data-testid^="sidebar-task-task-"]');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Readme digest');
    await expect(page.getByTestId('panel-tab-tasks')).toContainText('1');
  });

  test('Run Now runs it, and its last run opens as the thread it produced', async ({ page, eve }) => {
    eve.relay.seedTask({
      id: 't1', name: 'Readme digest', projectId: 'alpha', prompt: 'Summarise the README.', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
    await page.reload();
    await page.waitForFunction(() => window.client?.state?.tasks?.size > 0);
    await openTasks(page);
    const item = page.getByTestId('sidebar-task-t1');
    await expect(item).toBeVisible();

    await item.getByTitle('Run Now').click();
    await expect.poll(() => eve.relay.taskHistory('t1').length).toBe(1);
    await expect.poll(() => eve.relay.taskHistory('t1')[0].status).toBe('success');
    await expect.poll(() => page.evaluate(() => window.client.state.getTask('t1')?.lastStatus)).toBe('success');
    expect(eve.relay.listTasks()[0]).toMatchObject({ lastStatus: 'success', view: { kind: 'interactive', hasLastRun: true } });

    // The run is a headless session: it is not a thread in the sidebar or on Home.
    await expect(page.locator('[data-testid^="home-session-"]')).toHaveCount(0);

    await item.click();
    await expect(page.getByTestId('messages-container')).toContainText('Summarise the README.');
    await expect(page.getByTestId('messages-container')).toContainText('done');
  });

  test('a run that fails is shown as failed in the task list', async ({ page, eve }) => {
    eve.relay.seedTask({
      id: 't2', name: 'Flaky', projectId: 'alpha', prompt: 'x', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
    eve.relay.holdTaskRuns();
    await page.reload();
    await page.waitForFunction(() => window.client?.state?.tasks?.size > 0);
    await openTasks(page);
    await page.getByTestId('sidebar-task-t2').getByTitle('Run Now').click();
    await expect.poll(() => eve.relay.taskHistory('t2').length).toBe(1);
    eve.relay.finishTask('t2', { status: 'error', error: 'model unavailable' });
    await expect.poll(() => page.evaluate(() => window.client.state.getTask('t2')?.lastStatus)).toBe('error');
  });

  test('editing a task saves the new definition at the scheduler', async ({ page, eve }) => {
    eve.relay.seedTask({
      id: 't3', name: 'Old name', projectId: 'alpha', prompt: 'p', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
    await page.reload();
    await page.waitForFunction(() => window.client?.state?.tasks?.size > 0);
    await openTasks(page);
    await page.getByTestId('sidebar-task-t3').getByTitle('Edit').click();
    const dialog = page.getByTestId('dialog-task-dialog');
    await dialog.locator('[name="taskName"]').fill('New name');
    await dialog.getByRole('button', { name: /Save|Update/ }).click();
    await expect.poll(() => eve.relay.listTasks()[0].name).toBe('New name');
    await expect(page.getByTestId('sidebar-task-t3')).toContainText('New name');
  });

  test('deleting a task from the dialog removes it at the scheduler and from the list', async ({ page, eve }) => {
    eve.relay.seedTask({
      id: 't4', name: 'Doomed', projectId: 'alpha', prompt: 'p', model: 'fake-model',
      schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless',
    });
    await page.reload();
    await page.waitForFunction(() => window.client?.state?.tasks?.size > 0);
    await openTasks(page);
    await page.getByTestId('sidebar-task-new-alpha').click();
    const dialog = page.getByTestId('dialog-task-dialog');
    await dialog.locator('.dialog__tab[data-tab="tasks"]').click();
    // The confirmation is a native confirm(); Playwright dismisses it unless told.
    const asked = new Promise((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
    await dialog.getByTestId('task-dialog-item-t4').getByRole('button', { name: 'Delete' }).click();
    expect(await asked).toBe('Delete task "Doomed"?');
    await expect.poll(() => eve.relay.listTasks().length).toBe(0);
    await expect(page.getByTestId('sidebar-task-t4')).toHaveCount(0);
  });
});
