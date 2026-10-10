const { test, expect } = require('./support/fixtures');

test('pick the speed at which replies are read @G9.29', async ({ eve, page, voice }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  const composer = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(composer).toBeVisible();
  await composer.fill('say something');
  await composer.press('Enter');
  const read = page.getByRole('button', { name: 'Read aloud' });
  await expect(read.first()).toBeVisible();

  await page.getByRole('button', { name: 'Voice controls' }).click();
  const speed = page.getByRole('combobox', { name: 'Playback speed' });
  await speed.selectOption({ label: '1.5×' });
  await expect(speed.getByRole('option', { name: '1.5×', selected: true })).toBeAttached();

  await read.last().click();
  const request = await voice.tts.waitForRequest((r) => r.action !== 'list_voices' && r.speed === 1.5);
  expect(request.speed).toBe(1.5);
});
