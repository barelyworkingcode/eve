const { test, expect } = require('./support/fixtures');

const QUESTION = 'ping from testbox';

async function startThreadWithReply(eve, page) {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill(QUESTION);
  await ask.press('Enter');
  await expect(page.getByRole('button', { name: 'Read aloud' })).toBeVisible();
}

test('have one reply read aloud @G9.35', async ({ eve, page, voice }) => {
  await startThreadWithReply(eve, page);
  await page.getByRole('button', { name: 'Read aloud' }).click();

  const request = await voice.tts.waitForRequest((r) => JSON.stringify(r).includes(QUESTION));
  expect(JSON.stringify(request)).toContain(QUESTION);
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
});

test('stop a reply that is being read aloud @G9.36', async ({ eve, page, voice }) => {
  await startThreadWithReply(eve, page);
  await page.getByRole('button', { name: 'Read aloud' }).click();
  await voice.tts.waitForRequest((r) => JSON.stringify(r).includes(QUESTION));

  await page.getByRole('button', { name: 'Stop speaking' }).click();
  await expect(page.getByRole('button', { name: 'Read aloud' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeHidden();
});
