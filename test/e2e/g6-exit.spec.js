const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// Crash is on a model whose provider exits at launch with code 127; Flop is on
// a model that only fails its turn, so it carries no exit detail.
function exitWorld() {
  const w = worlds.base();
  w.chief_of_staff = { project_id: 'p_acme', model: 'haiku', daily_model_calls: 20 };
  w.models = [
    { value: 'acme-crash', label: 'Acme Crash', group: 'Claude', provider: 'claude', reply: { kind: 'exit', code: 127, stderr: ['acme-line-1', 'env: /opt/acme/bin/claude: No such file or directory'] } },
    { value: 'acme-fail', label: 'Acme Fail', group: 'Claude', provider: 'claude', reply: { kind: 'fail' } },
  ];
  w.sessions = [
    { id: 's_crash', project_id: 'p_acme', name: 'Crash', model: 'acme-crash', state: 'idle', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] },
    { id: 's_flop', project_id: 'p_acme', name: 'Flop', model: 'acme-fail', state: 'idle', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] },
  ];
  return w;
}

const LINE = 'env: /opt/acme/bin/claude: No such file or directory (exit 127)';

function row(page, name, state) {
  return page.getByRole('button', { name, exact: true }).filter({ hasText: state });
}

// The board is the Agents section of the Acme Project page (Today has not listed the agents
// since eve#615), read from a second browser.
function openBoard(eve) {
  return eve.openAnother('/#project/p_acme');
}

// Opens the agent from Today and sends it a message. The modal covers that
// page, so the board is read from another browser. Callers wait for their own
// signal: a provider exit shows a system line, a failed turn does not.
async function failTurn(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await box.fill('run it from testbox');
  await box.press('Enter');
}

async function openCos(page) {
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tell an agent' })).toBeVisible();
}

test.describe('an agent whose provider exits', () => {
  test.use({ world: exitWorld() });

  test("an errored agent's row shows why its provider exited @G6.20", async ({ eve, page }) => {
    const watcher = await openBoard(eve);
    await eve.open('/');
    await failTurn(page, 'Crash');
    await expect(page.getByText('Provider process exited. Will restart on next message.')).toBeVisible();
    await expect(row(watcher, 'Crash', 'errored')).toContainText(LINE);
    const fresh = await openBoard(eve);
    await expect(row(fresh, 'Crash', 'errored')).toContainText(LINE);
  });

  test('the rail and the alert post show the exit line @G6.38 @G6.45', async ({ eve, page }) => {
    await eve.open('/');
    await failTurn(page, 'Crash');
    await expect(page.getByText('Provider process exited. Will restart on next message.')).toBeVisible();
    const other = await eve.openAnother('/');
    await openCos(other);
    const rail = other.getByRole('navigation', { name: 'Agents' });
    await expect(rail.getByRole('button', { name: 'Crash', exact: true })).toContainText(LINE);
    const post = other.getByRole('article').filter({ has: other.getByRole('heading', { name: 'Crash stopped with an error' }) });
    await expect(post).toContainText(LINE);
  });

  test('an errored agent with no exit detail reads as before @G6.20 @G6.45', async ({ eve, page }) => {
    await eve.open('/');
    await failTurn(page, 'Flop');
    const other = await openBoard(eve);
    const flop = row(other, 'Flop', 'errored');
    // The Project page's rows carry no project name.
    await expect(flop).toHaveText(/^Flop\s*errored$/);
    await openCos(other);
    const post = other.getByRole('article').filter({ has: other.getByRole('heading', { name: 'Flop stopped with an error' }) });
    await expect(post).toContainText('Open it to see what happened.');
    await expect(post.getByRole('blockquote')).toHaveCount(0);
  });
});
