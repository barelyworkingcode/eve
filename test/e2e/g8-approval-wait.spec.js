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
const waiting = (page) => page.getByRole('status').filter({ hasText: 'Disconnected, approval waiting. Reconnecting…' });
const plain = (page) => page.getByRole('status').filter({ hasText: /^Reconnecting…$/ });

async function askAndWaitForPrompt(page, text) {
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill(text);
  await ask.press('Enter');
  await expect(prompt(page)).toBeVisible();
}

test.use({ world: gated('Bash') });

test('G8.19 a second page that opens the thread shows the waiting prompt @G8.19', async ({ eve, page }) => {
  await eve.open('/');
  await askAndWaitForPrompt(page, 'run it from testbox');

  const other = await eve.openAnother('/');
  // Today's Continue list and the agent board both name the thread; either opens it.
  await other.getByRole('button', { name: 'run it from testbox' }).first().click();
  await expect(prompt(other)).toBeVisible();
  await expect(other.getByText('Tool: Bash')).toBeVisible();

  await other.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(prompt(other)).toBeHidden();
  await expect(other.getByText('echo: run it from testbox')).toBeVisible();
});

test('G8.19 a reload during a waiting prompt shows it again @G8.19', async ({ eve, page }) => {
  await eve.open('/');
  await askAndWaitForPrompt(page, 'run it from testbox');

  await eve.reload();
  await expect(prompt(page)).toBeVisible();

  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(prompt(page)).toBeHidden();
  await expect(page.getByText('echo: run it from testbox')).toBeVisible();
});

// The browser's own signal that its link was replaced: the heartbeat finds the socket
// stale and the page opens a new one. Resolves with a promise that settles when the new
// socket has received the replayed approval.
async function replaceSocketAndAwaitReplay(page) {
  let opened = false;
  let replayed;
  const replay = new Promise((resolve) => { replayed = resolve; });
  page.on('websocket', (ws) => {
    opened = true;
    ws.on('framereceived', (f) => { if (/"permission_request"/.test(String(f.payload))) replayed(); });
  });
  const socket = page.waitForEvent('websocket');
  await page.clock.fastForward('00:31');
  for (let step = 0; step < 6 && !opened; step += 1) {
    await Promise.race([socket, page.clock.fastForward('00:31')]);
  }
  await socket;
  return replay;
}

test('G8.19 one prompt per approval after a reconnect @G8.19', async ({ eve, page }) => {
  await page.clock.install();
  await eve.open('/');
  await askAndWaitForPrompt(page, 'run it from testbox');

  await replaceSocketAndAwaitReplay(page);

  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(prompt(page)).toBeHidden();
  await expect(page.getByText('echo: run it from testbox')).toBeVisible();
});

test('G1.45 the status says an approval waits while disconnected @G1.45', async ({ eve, page }) => {
  await eve.open('/');
  await eve.setOffline(true);
  await expect(plain(page)).toBeVisible();
  await expect(waiting(page)).toBeHidden();
  await eve.setOffline(false);
  await expect(plain(page)).toBeHidden();

  await askAndWaitForPrompt(page, 'run it from testbox');
  await eve.setOffline(true);
  await expect(waiting(page)).toBeVisible();
  await expect(plain(page)).toBeHidden();

  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(prompt(page)).toBeHidden();
  await expect(plain(page)).toBeVisible();
  await expect(waiting(page)).toBeHidden();
});
