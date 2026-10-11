const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// One allowed model whose reply is the given fakerelay reply.
function replyWorld(reply) {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-reply'];
  w.models = [{ value: 'acme-reply', label: 'Acme Reply', group: 'Claude', provider: 'claude', reply }];
  return w;
}

async function ask(page, text) {
  const box = page.getByRole('textbox', { name: 'Ask' });
  await box.fill(text);
  await box.press('Enter');
}

test.describe('a tool step', () => {
  test.use({ world: replyWorld({ kind: 'permission', tool: 'Bash' }) });

  test('open a tool step to see its input and result @G2.24', async ({ eve, page }) => {
    await eve.open('/');
    await ask(page, 'run it from testbox');
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('echo: run it from testbox')).toBeVisible();
    // The answered permission prompt also names the tool and stays in the page, hidden.
    const step = page.getByText('Bash', { exact: true }).filter({ visible: true });
    const input = page.getByText('{}', { exact: true }).filter({ visible: true });
    const result = page.getByText('ok', { exact: true }).filter({ visible: true });
    await expect(step).toBeVisible();
    await expect(input).toHaveCount(0);
    await expect(result).toHaveCount(0);
    await step.click();
    await expect(input).toBeVisible();
    await expect(result).toBeVisible();
  });
});

test.describe('a reply with reasoning', () => {
  test.use({ world: replyWorld({ kind: 'text', text: '<think>The crate is under the stairs.</think>It is on the shelf.' }) });

  test('open a thinking block to read the reasoning @G2.25', async ({ eve, page }) => {
    await eve.open('/');
    await ask(page, 'where is the crate from testbox');
    await expect(page.getByText('It is on the shelf.')).toBeVisible();
    await expect(page.getByText('The crate is under the stairs.')).toBeHidden();
    await page.getByText('Thinking', { exact: true }).click();
    await expect(page.getByText('The crate is under the stairs.')).toBeVisible();
  });
});

test.describe('a turn that fails', () => {
  test.use({ world: replyWorld({ kind: 'fail' }) });

  test('see an error in the thread when a turn fails @G2.27', async ({ eve, page, relay }) => {
    await eve.open('/');
    await ask(page, 'fail from testbox');
    await expect(page.getByText('No response from model')).toBeVisible();
    await relay.waitForEvent('chat.turn');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  });
});

test('see the reply speed after it ends @G2.29', async ({ eve, page }) => {
  await eve.open('/');
  await ask(page, 'speed from testbox');
  await expect(page.getByText('echo: speed from testbox')).toBeVisible();
  await expect(page.getByText(/^\(TTFT \d+\.\ds, \d+\.\d tps\)$/)).toBeVisible();
});

function dormantWorld() {
  const w = worlds.base();
  w.sessions = [{
    id: 's_ledger',
    project_id: 'p_acme',
    name: 'Ledger',
    model: 'haiku',
    state: 'dormant',
    messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }],
  }];
  return w;
}

// Opens the sleeping thread from the Project page and returns its message box.
async function openLedger(eve, page) {
  await eve.open('/');
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Project page' }).click();
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeEnabled();
  await expect(page.getByText('earlier answer')).toBeVisible();
  return box;
}

async function resumes(relay) {
  return (await relay.logs({ event: 'session.resume' })).length;
}

test.describe('a thread relay has put to sleep', () => {
  test.use({ world: dormantWorld() });

  test('send a message and get the reply with no extra step @G2.55', async ({ eve, page, relay }) => {
    const box = await openLedger(eve, page);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await box.press('Enter');
    await expect(page.getByText('echo: hello from testbox')).toBeVisible();
    await relay.waitForEvent('session.resume', { since, match: (l) => l.status === 'ok' });
    await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  });

  test('relay refuses the resume @G2.55.r1', async ({ eve, page, relay }) => {
    const box = await openLedger(eve, page);
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions/{id}/resume', '--mode', 'error', '--status', '500', '--body', '{"error":"refused"}');
    expect(added.code).toBe(0);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await box.press('Enter');
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
    await expect(page.getByText('Resume failed (500)').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('echo: hello from testbox')).toBeHidden();
  });

  test('relay is down for the resume @G2.55.r2', async ({ eve, page, relay }) => {
    const box = await openLedger(eve, page);
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions/{id}/resume', '--mode', 'down');
    expect(added.code).toBe(0);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await box.press('Enter');
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
    await expect(page.getByText('Resume failed: relay unavailable').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('echo: hello from testbox')).toBeHidden();
  });

  test('a resume that wakes nothing leaves the thread asleep @G2.55.r3', async ({ eve, page, relay }) => {
    const box = await openLedger(eve, page);
    const added = await relay.ctl('fault', 'add', '--route', 'POST /api/sessions/{id}/resume', '--mode', 'error', '--status', '200', '--body', '{"resumed":false}');
    expect(added.code).toBe(0);
    const since = relay.mark();
    await box.fill('hello from testbox');
    await box.press('Enter');
    await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'applied' });
    await expect(page.getByText('Session needs to be resumed').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('echo: hello from testbox')).toBeHidden();
    expect(await resumes(relay)).toBe(0);
  });
});
