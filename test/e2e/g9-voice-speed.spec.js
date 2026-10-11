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

  await page.getByRole('button', { name: 'Voice settings' }).click();
  const speed = page.getByRole('combobox', { name: 'Speed', exact: true });
  await speed.selectOption({ label: '1.5×' });
  await expect(speed.getByRole('option', { name: '1.5×', selected: true })).toBeAttached();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();

  await read.last().click();
  const request = await voice.tts.waitForRequest((r) => r.action !== 'list_voices' && r.speed === 1.5);
  expect(request.speed).toBe(1.5);
});

async function openThreadInHandsFree(eve, page) {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read aloud' })).toHaveCount(1);
  const handsFree = page.getByRole('radiogroup', { name: 'Voice mode' }).getByRole('radio', { name: 'Hands-free' });
  await handsFree.click();
  await expect(handsFree).toBeChecked();
}

async function pickSpeed(page, label) {
  await page.getByRole('button', { name: 'Voice settings' }).click();
  const picker = page.getByRole('combobox', { name: 'Speed', exact: true });
  await picker.selectOption({ label });
  await expect(picker.getByRole('option', { name: label, selected: true })).toBeAttached();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

// Waits: the picker shows the choice; voice.tts.waitForRequest on the speed.
// The microphone hears a sentence every few seconds, so a reply is spoken after the choice is made.
test.describe('Hands-free with a microphone that hears speech', () => {
  test.use({ mic: 'speech' });

  test('the speed picked in Voice settings reads the spoken reply in Hands-free @G9.29', async ({ eve, page, voice }) => {
    // Every action is slow under CI load; a short reply lets listening resume so a later utterance goes out with the new choice.
    test.slow();
    await voice.tts.reply({ seconds: 0.1 });
    await openThreadInHandsFree(eve, page);
    await pickSpeed(page, '1.25×');
    await voice.tts.waitForRequest((r) => r.speed === 1.25);
  });

  // Waits: voice.tts.waitForRequest (first synth, answered); "Speaking…" visible; expect.poll on voice.tts.requests
  // (a second synth, held); the picker shows the choice; "Listening…" visible; voice.tts.waitForRequest on the speed.
  // Eve sends no reply to the pick's frame, so nothing shows it reached the server before release();
  // the frame leaves the page inside selectOption, and release() follows a further browser round trip.
  test('a speed picked while a reply is spoken leaves Hands-free listening again @G9.29', async ({ eve, page, voice }) => {
    test.slow();
    const synth = (r) => !r.action;
    await voice.tts.reply({ seconds: 0.5 });
    // The reply's first chunk plays; the rest of its synthesis waits until after the pick.
    voice.tts.hold({ after: 1 });
    await openThreadInHandsFree(eve, page);
    await voice.tts.waitForRequest(synth);
    const status = page.getByRole('status', { name: 'Voice status' });
    await expect(status.getByText('Speaking…')).toBeVisible();
    await expect.poll(() => voice.tts.requests.filter(synth).length).toBeGreaterThan(1);
    await pickSpeed(page, '1.25×');
    voice.tts.release();
    await expect(status.getByText('Listening…')).toBeVisible({ timeout: 30000 });
    await voice.tts.waitForRequest((r) => r.speed === 1.25);
  });
});
