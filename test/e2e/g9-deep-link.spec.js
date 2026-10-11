const { test, expect, profiles } = require('./support/fixtures');

test.use({ ...profiles.phone, mic: 'silence' });

function modeRadio(page, name) {
  return page.getByRole('radiogroup', { name: 'Voice mode' }).getByRole('radio', { name });
}

function voiceStatus(page) {
  return page.getByRole('status', { name: 'Voice status' });
}

// Today's greeting heading marks the Today screen.
function todayGreeting(page) {
  return page.getByRole('heading', { level: 1, name: /^(Good morning\.|Good afternoon\.|Good evening\.|Working late\.)$/ });
}

// Today's Continue row for the voice thread (the project name is in its text).
function voiceRow(page) {
  return page.getByRole('button', { name: /Voice/ }).filter({ hasText: 'Acme' });
}

// Waits: the Launcher heading, the Hands-free radio checked, the status "Listening…", session.launch.
async function startVoiceChat(eve, page, relay) {
  await eve.open('/');
  const since = await relay.mark();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await page.getByRole('button', { name: 'Start Voice Chat' }).click();
  await expect(modeRadio(page, 'Hands-free')).toBeChecked();
  await expect(voiceStatus(page).getByText('Listening…')).toBeVisible();
  await relay.waitForEvent('session.launch', { since });
  return since;
}

// Waits: the mic track stops (Hands-free ends), Today's greeting heading, the status gone.
async function leaveWithBackArrow(page, voice) {
  const stopsBefore = voice.mic.stops;
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await voice.mic.waitForStop(stopsBefore);
  await expect(todayGreeting(page)).toBeVisible();
  await expect(voiceStatus(page)).toHaveCount(0);
}

// Waits: the Hands-free radio and status after the link; the launch log holds only the first launch.
// This world has no voice preset, so a new launch would toast instead of opening the chat.
test('the deep link reuses a recent voice thread after the back arrow @G9.3', async ({ eve, page, relay, voice }) => {
  const since = await startVoiceChat(eve, page, relay);
  await leaveWithBackArrow(page, voice);

  await eve.open('/#/voice-chat');
  await expect(modeRadio(page, 'Hands-free')).toBeChecked();
  await expect(voiceStatus(page).getByText('Listening…')).toBeVisible();
  expect(await relay.logs({ event: 'session.launch', since })).toHaveLength(1);
  expect((await relay.json('ctl', 'state', '--json')).sessions).toHaveLength(1);
});

// Waits: the radio "Text" checked, the composer visible, the status gone.
test('the Text radio stops Hands-free and keeps the same conversation @G9.12', async ({ eve, page, relay }) => {
  const since = await startVoiceChat(eve, page, relay);
  await modeRadio(page, 'Text').click();
  await expect(modeRadio(page, 'Text')).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await expect(voiceStatus(page)).toHaveCount(0);
  expect(await relay.logs({ event: 'session.launch', since })).toHaveLength(1);
  expect((await relay.json('ctl', 'state', '--json')).sessions).toHaveLength(1);
});

// Waits: Today's greeting heading and the thread's row, then the radio "Text" checked.
test('a voice thread opened from the thread list starts in Text @G9.12', async ({ eve, page, relay, voice }) => {
  await startVoiceChat(eve, page, relay);
  await leaveWithBackArrow(page, voice);
  const row = voiceRow(page);
  await expect(row).toBeVisible();
  await row.click();
  await expect(modeRadio(page, 'Text')).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  await expect(voiceStatus(page)).toHaveCount(0);
});

// Waits: the Hands-free status, the mic track stopping, Today's greeting heading, the thread's row.
test('the back arrow closes the chat, stops Hands-free and keeps the session @G9.13', async ({ eve, page, relay, voice }) => {
  await startVoiceChat(eve, page, relay);
  await leaveWithBackArrow(page, voice);
  await expect(page.getByRole('radiogroup', { name: 'Voice mode' })).toHaveCount(0);
  const row = voiceRow(page);
  await expect(row).toBeVisible();
  expect((await relay.json('ctl', 'state', '--json')).sessions).toHaveLength(1);
  await row.click();
  await expect(modeRadio(page, 'Text')).toBeChecked();
});

// Waits: the Hands-free status after a voice launch; the removed view's controls are absent.
test('a voice launch leaves no full-screen voice view @G9.1', async ({ eve, page, relay }) => {
  await startVoiceChat(eve, page, relay);
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hold to record' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Voice controls' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Orb settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch to text chat' })).toHaveCount(0);
  // The chat's own composer area is still there, with the mode radios.
  await expect(page.getByRole('radiogroup', { name: 'Voice mode' })).toBeVisible();
});
