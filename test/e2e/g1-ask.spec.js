const { test, expect } = require('./support/fixtures');

test('start a thread by typing in Ask and pressing Return @G1.4', async ({ eve, page, relay }) => {
  const since = relay.mark();
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('hello from testbox');
  await ask.press('Enter');

  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  const launch = await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
  expect(launch.status).toBe('ok');
  const turn = await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
  expect(turn.status).toBe('ok');
});
