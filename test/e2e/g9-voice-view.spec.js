const { test, expect, profiles } = require('./support/fixtures');

const HEARD = 'hello from the test microphone';

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

// The echo reply caption ("echo: <words>") also contains the words, so match the user's own text exactly.
// It shows twice: as the user caption and as the user turn in the thread behind the voice view.
async function expectHeardCaption(page) {
  await expect(page.getByText(HEARD, { exact: true })).toHaveCount(2);
}

test.describe('with a silent microphone', () => {
  test.use({ mic: 'silence' });

  test('the view names the speech engines in use @G9.24', async ({ eve, page, relay }) => {
    await openVoiceView(eve, page, relay);
    await expect(page.getByText(/TTS: server\s+·\s+STT: server/)).toBeVisible();
  });

  // Waits: the prompt text after each press.
  test('the mode button flips between hands-free and push-to-talk @G9.11', async ({ eve, page, relay }) => {
    await openVoiceView(eve, page, relay);
    await page.getByRole('button', { name: 'Hands-free' }).click();
    await expect(page.getByRole('button', { name: 'Push-to-talk' })).toBeVisible();
    await expect(page.getByText('Hold spacebar to speak...')).toBeVisible();
    await page.getByRole('button', { name: 'Push-to-talk' }).click();
    await expect(page.getByRole('button', { name: 'Hands-free' })).toBeVisible();
    await expect(page.getByText('Listening...')).toBeVisible();
  });

  // Waits: the tab goes; Today lists the thread.
  test('End session closes the voice tab and keeps the thread for Today @G9.13', async ({ eve, page, relay }) => {
    await openVoiceView(eve, page, relay);
    const tab = page.getByRole('tab', { name: /Voice/ });
    await expect(tab).toBeVisible();
    await page.getByRole('button', { name: 'End session' }).click();
    await expect(tab).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hold to record' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /Voice/ }).filter({ hasText: 'Acme' })).toBeVisible();
    expect((await relay.json('ctl', 'state', '--json')).sessions).toHaveLength(1);
  });

  // Waits: the composer shows; the launch log holds only the first launch.
  test('Switch to text chat opens the same thread as text @G9.12', async ({ eve, page, relay }) => {
    const since = await openVoiceView(eve, page, relay);
    await page.getByRole('button', { name: 'Voice controls' }).click();
    await page.getByRole('button', { name: 'Switch to text chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hold to record' })).toHaveCount(0);
    expect(await relay.logs({ event: 'session.launch', since })).toHaveLength(1);
    expect((await relay.json('ctl', 'state', '--json')).sessions).toHaveLength(1);
  });
});

test.describe('on a phone', () => {
  test.use({ ...profiles.phone, mic: 'silence' });

  test('push-to-talk reads "Hold mic to speak..." on a phone @G9.11', async ({ eve, page, relay }) => {
    await openVoiceView(eve, page, relay);
    await page.getByRole('button', { name: 'Hands-free' }).click();
    await expect(page.getByRole('button', { name: 'Push-to-talk' })).toBeVisible();
    await expect(page.getByText('Hold mic to speak...')).toBeVisible();
  });
});

test.describe('with a microphone that hears speech', () => {
  test.use({ mic: 'speech' });

  // Waits: voice.stt.waitForRequest, the user caption (exact), chat.turn, the TTS request, "Speaking...".
  // "Transcribing..." and "Thinking..." flash too fast to assert; those parts stay open.
  test('talking without holding anything sends the words and speaks the reply @G9.10', async ({ eve, page, relay, voice }) => {
    await openVoiceView(eve, page, relay);
    const since = await relay.mark();
    await voice.stt.waitForRequest();
    // The echo reply caption also contains the words, so the user's own caption is matched exactly.
    await expectHeardCaption(page);
    await relay.waitForEvent('chat.turn', { since });
    await voice.tts.waitForRequest((r) => r.text && r.text.includes(HEARD));
    await expect(page.getByText('Speaking...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hands-free' })).toBeVisible();
  });
});
