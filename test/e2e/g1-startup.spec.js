const { test, expect } = require('./support/fixtures');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;
const SUMMARY = /^1 project · /;
const starting = (page) => page.getByRole('status').filter({ hasText: 'Starting…' });
const silent = (page) => page.getByRole('status').filter({ hasText: "eve isn't responding." });

// Holds eve's upstream session socket. That withholds only `ready`, so a feature that
// still waits on its own load check would act early and fail.
async function holdSocket(relay, extra = []) {
  const hold = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'slow', ...extra);
  expect(hold.code).toBe(0);
  return JSON.parse(hold.stdout).id;
}

// The browser's own signal that its link was replaced: the heartbeat finds the socket
// stale and the page opens a new one. Advances the clock in steps until it does.
async function replaceSocket(page) {
  let opened = false;
  const socket = page.waitForEvent('websocket').then(() => { opened = true; });
  await page.clock.fastForward('00:31');
  for (let step = 0; step < 6 && !opened; step += 1) {
    await Promise.race([socket, page.clock.fastForward('00:31')]);
  }
  await socket;
}

async function release(relay, id) {
  expect((await relay.ctl('fault', 'release', '--id', id)).code).toBe(0);
  expect((await relay.ctl('fault', 'clear')).code).toBe(0);
}

test('cold load shows Starting… then the page, a dropped socket shows it again and recovers @G1.44', async ({ eve, page, relay }) => {
  const since = relay.mark();
  const hold = await holdSocket(relay);
  await eve.open('/', { preReady: 'the Starting… banner shows before eve is ready' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  await expect(starting(page)).toBeVisible();
  await release(relay, hold);
  await eve.ready();
  await expect(starting(page)).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
  await expect(page.getByText(SUMMARY)).toBeVisible();

  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('draft from testbox');
  const down = await relay.ctl('fault', 'add', '--route', 'GET /ws', '--mode', 'down');
  expect(down.code).toBe(0);
  await expect(starting(page)).toBeVisible();
  expect((await relay.ctl('fault', 'clear')).code).toBe(0);
  await expect(starting(page)).toBeHidden();
  await expect(ask).toHaveValue('draft from testbox');
});

test('Return in Ask before ready sends itself once, when eve is ready @G1.44', async ({ eve, page, relay }) => {
  await eve.open('/');
  const since = relay.mark();
  const hold = await holdSocket(relay);
  await eve.reload({ preReady: 'acting before eve is ready is the row' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('hello from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Sending when eve is ready…' })).toBeVisible();
  await release(relay, hold);
  await eve.ready();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
  expect((await relay.logs({ event: 'session.launch', since })).length).toBe(1);
});

test('a deep link and the open tabs come back only once eve is ready @G1.44', async ({ eve, page, relay }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('first from testbox');
  await ask.press('Enter');
  const first = page.getByRole('tab', { name: 'Acme - first from testbox' });
  await expect(first).toBeVisible();
  await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });

  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await page.getByRole('button', { name: 'Web Chat' }).click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(2);
  const sessions = (await relay.json('ctl', 'state', '--json')).sessions;
  expect(sessions.length).toBe(2);
  const second = sessions.find((s) => !s.name.includes('first from testbox'));
  const secondTab = page.getByRole('tab', { name: second.name });
  await expect(secondTab).toBeVisible();
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');

  const since = relay.mark();
  const hold = await holdSocket(relay);
  await eve.open(`/index.html#session/${second.id}`, { preReady: 'restoring before eve is ready is the row' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  await expect(starting(page)).toBeVisible();
  await expect(first).toBeHidden();
  await expect(secondTab).toBeHidden();
  await release(relay, hold);
  await eve.ready();
  await expect(first).toBeVisible();
  await expect(secondTab).toBeVisible();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(starting(page)).toBeHidden();
});

test('open tabs come back after a socket replaced before the first ready @G1.44', async ({ eve, page, relay }) => {
  await page.clock.install();
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('restore from testbox');
  await ask.press('Enter');
  const tab = page.getByRole('tab', { name: 'Acme - restore from testbox' });
  await expect(tab).toBeVisible();
  await relay.waitForEvent('session.launch', { match: (l) => l.status === 'ok' });

  const since = relay.mark();
  const hold = await holdSocket(relay);
  // A real navigation to the bare page: a reload would keep the #session hash and deep-link the tab back.
  await eve.open('/index.html', { preReady: 'tab restore before eve is ready is the row' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  await expect(starting(page)).toBeVisible();
  await expect(page).not.toHaveURL(/#session/);
  await expect(tab).toBeHidden();
  await replaceSocket(page);
  await expect(starting(page)).toBeVisible();
  await expect(tab).toBeHidden();
  await release(relay, hold);
  await eve.ready();
  await expect(starting(page)).toBeHidden();
  await expect(tab).toBeVisible();
});

test('no ready after about two minutes says eve is not responding @G1.44.r1', async ({ eve, page, relay }) => {
  await page.clock.install();
  const since = relay.mark();
  const hold = await holdSocket(relay);
  await eve.open('/', { preReady: 'the wait for ready is the row' });
  await relay.waitForEvent('fakerelay.fault', { since, match: (l) => l.action === 'held' });
  await expect(starting(page)).toBeVisible();
  await expect(silent(page)).toBeHidden();
  await page.clock.fastForward('02:00');
  await expect(silent(page)).toBeVisible();
  await release(relay, hold);
  await eve.ready();
  await expect(silent(page)).toBeHidden();
  await expect(starting(page)).toBeHidden();
});

test('a replaced socket shows Starting… and recovers with the draft kept @G1.44', async ({ eve, page, relay }) => {
  await page.clock.install();
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('draft from testbox');
  const hold = await holdSocket(relay);
  await replaceSocket(page);
  await expect(starting(page)).toBeVisible();
  await release(relay, hold);
  await expect(starting(page)).toBeHidden();
  await expect(ask).toHaveValue('draft from testbox');
});
