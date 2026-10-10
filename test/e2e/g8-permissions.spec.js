const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// One allowed model whose reply is a permission prompt for the named tool.
function gated(tool) {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-gated'];
  w.models = [
    { value: 'acme-gated', label: 'Acme Gated', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool } },
  ];
  return w;
}

const prompt = (page) => page.getByRole('heading', { name: 'Permission Request' });

async function askAndWaitForPrompt(page, text) {
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill(text);
  await ask.press('Enter');
  await expect(prompt(page)).toBeVisible();
}

test.describe('a gated tool', () => {
  test.use({ world: gated('Bash') });

  test('see which tool the agent wants to run @G8.1', async ({ eve, page }) => {
    await eve.open('/');
    await askAndWaitForPrompt(page, 'run it from testbox');
    await expect(page.getByText('Tool: Bash')).toBeVisible();
    await expect(page.getByText('Details:')).toBeVisible();
  });

  test('allow one tool call @G8.2', async ({ eve, page }) => {
    await eve.open('/');
    await askAndWaitForPrompt(page, 'run it from testbox');
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByText('echo: run it from testbox')).toBeVisible();
  });

  test('allow every tool call for this chat @G8.3', async ({ eve, page }) => {
    await eve.open('/');
    await askAndWaitForPrompt(page, 'first from testbox');
    await page.getByRole('button', { name: 'Allow All', exact: true }).click();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByText('echo: first from testbox')).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Type yes/no or your response...' });
    await composer.fill('second from testbox');
    await composer.press('Enter');
    await expect(page.getByText('echo: second from testbox')).toBeVisible();
    await expect(prompt(page)).toBeHidden();
  });

  test('deny a tool call @G8.4', async ({ eve, page }) => {
    await eve.open('/');
    await askAndWaitForPrompt(page, 'run it from testbox');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByText('denied', { exact: true })).toBeVisible();
    await expect(page.getByText('echo: run it from testbox')).toBeHidden();
  });

  test('deny a tool call with Escape @G8.5', async ({ eve, page }) => {
    await eve.open('/');
    await askAndWaitForPrompt(page, 'run it from testbox');
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByText('denied', { exact: true })).toBeVisible();
    await expect(page.getByText('echo: run it from testbox')).toBeHidden();
  });
});

function twoGated() {
  const w = worlds.base();
  w.models = [
    { value: 'acme-bash', label: 'Acme Bash', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
    { value: 'acme-read', label: 'Acme Read', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Read' } },
  ];
  return w;
}

test.describe('two gated threads', () => {
  test.use({ world: twoGated() });

  async function newChat(page, model) {
    await page.getByRole('button', { name: 'New Session' }).click();
    await page.getByRole('button', { name: 'Web Chat' }).click();
    await page.getByRole('combobox', { name: 'Model' }).selectOption({ label: model });
    await page.getByRole('button', { name: 'Start Chat' }).click();
  }

  test('answer the next prompt when several wait @G8.6', async ({ eve, page }) => {
    await eve.open('/');
    await newChat(page, 'Acme Bash');
    await expect(page.getByRole('tab')).toHaveCount(1);
    await newChat(page, 'Acme Read');
    await expect(page.getByRole('tab')).toHaveCount(2);
    const composer = page.getByRole('textbox', { name: 'Type your message...' });
    await composer.fill('read from testbox');
    await composer.press('Enter');
    await expect(prompt(page)).toBeVisible();
    await expect(page.getByText('Tool: Read')).toBeVisible();
    // The palette answers the keyboard over the prompt, so the person can reach the other thread.
    await page.keyboard.press('Control+K');
    await page.getByRole('option', { name: 'Acme Bash', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Acme - Acme Bash', selected: true })).toBeVisible();
    const other = page.getByRole('textbox', { name: /^Type / });
    await other.fill('bash from testbox');
    await other.press('Enter');
    await expect(page.getByText('bash from testbox')).toBeVisible();
    await expect(prompt(page)).toHaveCount(1);
    await expect(page.getByText('Tool: Read')).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Tool: Bash')).toBeVisible();
    await expect(page.getByText('Tool: Read')).toBeHidden();
    await expect(prompt(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByText('echo: bash from testbox')).toBeVisible();
  });
});
