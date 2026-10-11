const { test, expect } = require('./support/fixtures');

test.use({ mic: 'silence' });

async function openVoiceView(eve, page, relay) {
  await eve.open('/');
  const since = await relay.mark();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await page.getByRole('button', { name: 'Start Voice Chat' }).click();
  await expect(page.getByRole('button', { name: 'Hold to record' })).toBeVisible();
  await expect(page.getByText('Listening...')).toBeVisible();
  await relay.waitForEvent('session.launch', { since });
  return since;
}

async function openTextThread(eve, page) {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read aloud' })).toBeVisible();
}

// Waits: the strip's button hidden, then visible.
test('the drawer in a text chat offers Switch to Voice UI @G9.26', async ({ eve, page }) => {
  await openTextThread(eve, page);
  await expect(page.getByRole('button', { name: 'Switch to Voice UI' })).toBeHidden();
  await page.getByRole('button', { name: 'Voice controls' }).click();
  await expect(page.getByRole('button', { name: 'Switch to Voice UI' })).toBeVisible();
});

// Waits: the pickers hidden, then visible.
test('the drawer in the voice view holds the pickers and Switch to text chat @G9.27', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Voice controls' }).click();
  await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Playback speed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch to text chat' })).toBeVisible();
});

// Waits: the picker shows the choice; voice.tts.waitForRequest on the voice id.
// The microphone hears a sentence every few seconds, so a reply is spoken after the choice is made.
test.describe('with a microphone that hears speech', () => {
  test.use({ mic: 'speech' });

  test('the voice picked in the drawer reads the spoken reply @G9.30', async ({ eve, page, relay, voice }) => {
    await openVoiceView(eve, page, relay);
    await page.getByRole('button', { name: 'Voice controls' }).click();
    const picker = page.getByRole('combobox', { name: 'Voice', exact: true });
    await picker.selectOption({ label: 'George' });
    await expect(picker.getByRole('option', { name: 'George', selected: true })).toBeAttached();
    const request = await voice.tts.waitForRequest((r) => r.voice === 'bm_george');
    expect(request.voice).toBe('bm_george');
  });
});

// Waits: the picker shows the choice; voice.tts.waitForRequest on the speed.
test.describe('with a microphone that hears speech, at a set speed', () => {
  test.use({ mic: 'speech' });

  test('the speed picked in the drawer reads the spoken reply @G9.31', async ({ eve, page, relay, voice }) => {
    await openVoiceView(eve, page, relay);
    await page.getByRole('button', { name: 'Voice controls' }).click();
    const picker = page.getByRole('combobox', { name: 'Playback speed', exact: true });
    await picker.selectOption({ label: '1.25×' });
    await expect(picker.getByRole('option', { name: '1.25×', selected: true })).toBeAttached();
    const request = await voice.tts.waitForRequest((r) => r.speed === 1.25);
    expect(request.speed).toBe(1.25);
  });
});

// Waits: the voice view's button; the launch log holds only the thread's own launch.
test('Switch to Voice UI opens the voice view on the same conversation @G9.33', async ({ eve, page, relay }) => {
  const since = await relay.mark();
  await openTextThread(eve, page);
  await page.getByRole('button', { name: 'Voice controls' }).click();
  await page.getByRole('button', { name: 'Switch to Voice UI' }).click();
  await expect(page.getByRole('button', { name: 'Hold to record' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeHidden();
  expect(await relay.logs({ event: 'session.launch', since })).toHaveLength(1);
  expect((await relay.json('ctl', 'state', '--json')).sessions).toHaveLength(1);
});
