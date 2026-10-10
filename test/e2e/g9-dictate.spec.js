const { test, expect } = require('./support/fixtures');

test('dictate a message into the composer @G9.37', async ({ eve, page }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  const composer = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(composer).toBeVisible();

  await page.getByRole('button', { name: 'Dictate (Speech-to-Text)' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  // eve drops recordings under 300 ms; the button renames itself on the timer tick.
  const recording = page.getByRole('button', { name: /^Recording\.\.\./ });
  await expect(recording).toBeVisible();
  await recording.click();

  await expect(composer).toHaveValue('hello from the test microphone');
});
