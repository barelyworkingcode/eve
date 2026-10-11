const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

function withModels() {
  const w = worlds.base();
  w.models = [
    { value: 'pi/test-model', label: 'Pi Test', group: 'Pi', provider: 'pi' },
  ];
  return w;
}

function withTemplate() {
  const w = worlds.base();
  w.projects[0].chat_templates = [{ id: 't_review', name: 'Review', model: 'sonnet' }];
  return w;
}

function withNoModelTemplate() {
  const w = worlds.base();
  w.projects[0].chat_templates = [{ id: 't_plain', name: 'Plain', model: '' }];
  return w;
}

function allowOne() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['sonnet'];
  return w;
}

function allowNone() {
  const w = worlds.base();
  // An empty list means "all models" to relay; a list naming only an unknown model allows none.
  w.projects[0].allowed_models = ['no-such-model'];
  return w;
}

async function openLauncher(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
}

async function openChatForm(eve, page) {
  await openLauncher(eve, page);
  await page.getByRole('button', { name: 'Web Chat' }).click();
  await expect(page.getByRole('button', { name: 'Start Chat' })).toBeVisible();
}

test('open the Launcher from the Project panel @G2.1', async ({ eve, page }) => {
  await openLauncher(eve, page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Acme', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Web Chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voice Chat' })).toBeVisible();
});

test('open the Launcher on the chat form from the Chat tile @G2.2', async ({ eve, page }) => {
  await eve.open('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Chat' })).toBeVisible();
});

test('open the Launcher from the Project page @G2.3', async ({ eve, page }) => {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
  await page.getByRole('button', { name: 'New thread' }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Acme', { exact: true })).toBeVisible();
});

test('open the Launcher from the Command palette @G2.4', async ({ eve, page }) => {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('textbox', { name: 'Jump to a session, project, file or action…' });
  await expect(palette).toBeVisible();
  await palette.fill('New session');
  await page.getByRole('option', { name: 'New session…' }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await expect(palette).toBeHidden();
});

test('start the Web Chat form from the Launcher @G2.5', async ({ eve, page }) => {
  await openLauncher(eve, page);
  await page.getByRole('button', { name: 'Web Chat' }).click();
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Chat' })).toBeVisible();
});

test.describe('a project that allows one model', () => {
  test.use({ world: allowOne() });

  test('the model list shows only the allowed models @G2.6', async ({ eve, page, relay }) => {
    await openChatForm(eve, page);
    const model = page.getByRole('combobox', { name: 'Model' });
    await expect(model.getByRole('option')).toHaveCount(1);
    await expect(model.getByRole('option', { name: /sonnet/i })).toBeAttached();
    await expect(model.getByRole('option', { name: /haiku/i })).toHaveCount(0);
    const listed = await relay.waitForEvent('model.list');
    expect(listed.event).toBe('model.list');
  });
});

test.describe('a project that allows no model', () => {
  test.use({ world: allowNone() });

  test('Start Chat asks for a model @G2.6.r1', async ({ eve, page }) => {
    await openChatForm(eve, page);
    await page.getByRole('button', { name: 'Start Chat' }).click();
    await expect(page.getByText('Pick a model for "" before starting a chat.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  });
});

test.describe('models with provider options', () => {
  test.use({ world: withModels() });

  test('provider options follow the picked model @G2.7', async ({ eve, page }) => {
    await openChatForm(eve, page);
    const model = page.getByRole('dialog').getByRole('combobox', { name: 'Model', exact: true });
    await model.selectOption('pi/test-model');
    await expect(page.getByRole('textbox', { name: 'Thinking Level' })).toBeVisible();
    await model.selectOption({ label: 'Claude Haiku' });
    await expect(page.getByRole('textbox', { name: 'Thinking Level' })).toBeHidden();
  });
});

test('go back from the chat form to the cards @G2.9', async ({ eve, page }) => {
  await openChatForm(eve, page);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'Web Chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voice Chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Chat' })).toBeHidden();
});

test.describe('a chat template', () => {
  test.use({ world: withTemplate() });

  test('start a chat from a template card @G2.10', async ({ eve, page, relay }) => {
    await openLauncher(eve, page);
    const since = relay.mark();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeEnabled();
    await expect(page.getByRole('tab', { name: /Acme.*Review/ })).toBeVisible();
    await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
  });
});

test.describe('a template with no model', () => {
  test.use({ world: withNoModelTemplate() });

  test('the template asks for a model @G2.10.r1', async ({ eve, page }) => {
    await openLauncher(eve, page);
    await page.getByRole('button', { name: 'Plain', exact: true }).click();
    await expect(page.getByText('Pick a model for "Plain" before starting a chat.')).toBeVisible();
  });
});

test('close the Launcher without starting @G2.11', async ({ eve, page }) => {
  await openLauncher(eve, page);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New Session' }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toHaveCount(0);
});
