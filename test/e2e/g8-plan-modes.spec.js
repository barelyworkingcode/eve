const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const PLAN = '# Testbox plan\n\n1. Tidy the shelf.\n2. Label the boxes.\n';

function planning() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-plan'];
  w.models = [
    { value: 'acme-plan', label: 'Acme Plan', group: 'Claude', provider: 'claude', reply: { kind: 'plan', text: PLAN } },
  ];
  return w;
}

async function askForPlan(page) {
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('plan the shelf from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('heading', { name: 'Testbox plan' })).toBeVisible();
}

// The plan tab takes focus by itself; the person goes back to the thread from the Rail.
async function backToThread(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await expect(page.getByText('Plan ready for review')).toBeVisible();
}

test.describe('a plan', () => {
  test.use({ world: planning() });

  test('a tab opens with the plan when it is ready @G8.8', async ({ eve, page }) => {
    await eve.open('/');
    await askForPlan(page);
    await expect(page.getByRole('tab', { name: /\.md$/, selected: true })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Tidy the shelf.' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Label the boxes.' })).toBeVisible();
  });

  test('the thread says the plan is ready for review @G8.11', async ({ eve, page }) => {
    await eve.open('/');
    await askForPlan(page);
    await backToThread(page);
    await expect(page.getByRole('button', { name: 'Revise', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve Plan', exact: true })).toBeVisible();
  });

  test('ask for changes to the plan @G8.10', async ({ eve, page, relay }) => {
    await eve.open('/');
    await askForPlan(page);
    await backToThread(page);
    await expect.poll(async () => (await relay.logs({ event: 'chat.turn' })).length).toBe(1);
    await page.getByRole('button', { name: 'Revise', exact: true }).click();
    const box =page.getByRole('textbox', { name: 'Describe what to change in the plan...' });
    await expect(box).toBeFocused();
    await expect(page.getByRole('button', { name: 'Approve Plan', exact: true })).toBeHidden();
    await box.fill('shorter please');
    await box.press('Enter');
    await expect(page.getByText('shorter please')).toBeVisible();
    await expect.poll(async () => (await relay.logs({ event: 'chat.turn' })).length).toBe(2);
  });

  test('approve the plan @G8.9', async ({ eve, page, relay }) => {
    await eve.open('/');
    await askForPlan(page);
    await backToThread(page);
    await expect.poll(async () => (await relay.logs({ event: 'chat.turn' })).length).toBe(1);
    await page.getByRole('button', { name: 'Approve Plan', exact: true }).click();
    // The fake plans again on every turn, so the thread leaves the screen for the new plan tab:
    // the bar is gone from the thread and the second turn is the agent starting work.
    await expect(page.getByRole('button', { name: 'Approve Plan', exact: true })).toBeHidden();
    await expect.poll(async () => (await relay.logs({ event: 'chat.turn' })).length).toBe(2);
    await backToThread(page);
    await expect(page.getByText('Yes, proceed with the plan.')).toBeVisible();
  });
});

// The button's pressed look has no accessible state, so only the banner is proven here.
test('turn plan mode on and off for the thread @G8.12', async ({ eve, page }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('plain from testbox');
  await ask.press('Enter');
  await expect(page.getByText('echo: plain from testbox')).toBeVisible();
  await expect(page.getByText(/Plan mode/)).toBeHidden();
  const toggle = page.getByRole('button', { name: 'Toggle plan mode' });
  await toggle.click();
  await expect(page.getByText(/Plan mode/)).toBeVisible();
  await toggle.click();
  await expect(page.getByText(/Plan mode/)).toBeHidden();
});

function chatOnly() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-chat'];
  w.models = [
    { value: 'acme-chat', label: 'Acme Chat', group: 'Local', provider: 'chat', reply: { kind: 'echo' } },
  ];
  return w;
}

test.describe('a model with no permission modes', () => {
  test.use({ world: chatOnly() });

  test('no plan mode button for a model without modes @G8.12.r1', async ({ eve, page }) => {
    await eve.open('/');
    const ask = page.getByRole('textbox', { name: 'Ask' });
    await ask.fill('chat from testbox');
    await ask.press('Enter');
    await expect(page.getByText('echo: chat from testbox')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle plan mode' })).toBeHidden();
  });
});
