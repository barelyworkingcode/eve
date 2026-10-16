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
const expired = (page) => page.getByRole('status').filter({ hasText: 'Approval expired. The tool call did not run.' });
const reconnected = (page) => page.getByRole('status').filter({ hasText: 'Reconnected to relay.' });
const waiting = (page) => page.getByRole('status').filter({ hasText: 'Disconnected, approval waiting. Reconnecting…' });
const plain = (page) => page.getByRole('status').filter({ hasText: /^Reconnecting…$/ });

async function askAndWaitForPrompt(page, text) {
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill(text);
  await ask.press('Enter');
  await expect(prompt(page)).toBeVisible();
}

test.use({ world: gated('Bash') });

test('G8.19 an expired prompt closes and says so @G8.19 @G8.19.r1', async ({ eve, relay, page }) => {
  await eve.open('/');
  await askAndWaitForPrompt(page, 'run it from testbox');

  await relay.ctl('clock', 'advance', '60000');

  await expect(prompt(page)).toBeHidden();
  await expect(expired(page)).toBeVisible();

  // No prompt waits any more, so a lost link reads as a plain reconnect.
  await eve.setOffline(true);
  await expect(plain(page)).toBeVisible();
  await expect(waiting(page)).toBeHidden();
});

test('G8.19 a prompt that expired while relay was away is gone after the reconnect @G8.19 @G8.19.r1', async ({ eve, relay, page }) => {
  // The browser's own signal that the page has the thread's state again. The page keeps its
  // socket to eve while relay is away, so listen on every socket from the first one, and
  // count only a join that arrives once the prompt is up.
  let armed = false;
  let joined;
  const rejoined = new Promise((resolve) => { joined = resolve; });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => { if (armed && /"session_joined"/.test(String(f.payload))) joined(); });
  });

  await eve.open('/');
  await askAndWaitForPrompt(page, 'run it from testbox');
  armed = true;

  await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down');
  await relay.ctl('clock', 'advance', '60000');
  await relay.ctl('fault', 'clear');

  await expect(reconnected(page)).toBeVisible();
  await rejoined;

  await expect(prompt(page)).toBeHidden();
  await expect(expired(page)).toBeHidden();
});
