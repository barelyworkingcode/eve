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

test.describe('a blocked microphone', () => {
  test.use({ micBlocked: true });

  // Waits: the refusal text; no recording starts.
  test('dictating says the microphone is blocked @G9.37.r1', async ({ eve, page, voice }) => {
    await eve.open('/');
    const ask = page.getByRole('textbox', { name: 'Ask' });
    await ask.fill('open a thread from testbox');
    await ask.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();

    await page.getByRole('button', { name: 'Dictate (Speech-to-Text)' }).click();
    await expect(page.getByText('Microphone access denied. Check browser permissions.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Recording\.\.\./ })).toHaveCount(0);
    expect(voice.stt.requests).toHaveLength(0);
  });
});

// Waits: the Recording timer button, then the STT request that failed, then the text.
test('a failed transcription says to try again @G9.37.r2', async ({ eve, page, voice }) => {
  voice.stt.reply({ error: 'engine down' });
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  const composer = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(composer).toBeVisible();

  await page.getByRole('button', { name: 'Dictate (Speech-to-Text)' }).click();
  const recording = page.getByRole('button', { name: /^Recording\.\.\./ });
  await expect(recording).toBeVisible();
  await recording.click();

  await voice.stt.waitForRequest();
  await expect(page.getByText('Transcription failed: engine down')).toBeVisible();
  await expect(composer).toHaveValue('');
});
