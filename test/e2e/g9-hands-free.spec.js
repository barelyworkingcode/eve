const { test, expect } = require('./support/fixtures');

const HEARD = 'hello from the test microphone';
const REMINDER = "I'm still here.";

async function openThread(eve, page) {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  // The Ask turn's reply has rendered, so later counts start from one.
  await expect(page.getByRole('button', { name: 'Read aloud' })).toHaveCount(1);
}

function radio(page, name) {
  return page.getByRole('radiogroup', { name: 'Voice mode' }).getByRole('radio', { name });
}

function status(page) {
  return page.getByRole('status', { name: 'Voice status' });
}

async function chooseHandsFree(page) {
  await radio(page, 'Hands-free').click();
  await expect(radio(page, 'Hands-free')).toHaveAttribute('aria-checked', 'true');
}

// Hands-free with the speech mic: heard, answered, and the reply is being spoken.
async function speakingHandsFree(eve, page, voice, heard = HEARD) {
  await openThread(eve, page);
  await chooseHandsFree(page);
  await voice.stt.waitForRequest();
  await expect(page.getByRole('img', { name: 'Spoken' })).toBeVisible();
  await voice.tts.waitForRequest((r) => r.text && r.text.includes(heard));
  await expect(status(page).getByText('Speaking…')).toBeVisible();
}

test.describe('with a microphone that hears speech', () => {
  test.use({ mic: 'speech' });

  // Waits: voice.stt.waitForRequest, then the Spoken turn and the TTS request for the reply.
  test('Hands-free hears, answers and speaks without a tap @G9.43 @G9.44', async ({ eve, page, voice }) => {
    await openThread(eve, page);
    await chooseHandsFree(page);
    await expect(status(page).getByText('Listening…')).toBeVisible();

    await voice.stt.waitForRequest();
    await expect(page.getByRole('img', { name: 'Spoken' })).toBeVisible();
    await expect(page.getByText(HEARD).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read aloud' })).toHaveCount(2);
    const spoken = await voice.tts.waitForRequest((r) => r.text && r.text.includes(HEARD));
    expect(spoken.text).toContain(HEARD);
    await expect(status(page).getByText('Speaking…')).toBeVisible();
  });

  test('Stop reply stops the speech and listening returns @G9.45', async ({ eve, page, voice }) => {
    await speakingHandsFree(eve, page, voice);
    await status(page).getByRole('button', { name: 'Stop reply' }).click();
    await expect(status(page).getByText('Speaking…')).toHaveCount(0);
    await expect(status(page).getByRole('button', { name: 'Stop reply' })).toHaveCount(0);
    await expect(status(page).getByText('Listening…')).toBeVisible();
  });

  test('a tap on the orb while speaking stops the speech @G9.45', async ({ eve, page, voice }) => {
    await speakingHandsFree(eve, page, voice);
    await status(page).getByRole('button', { name: 'Voice orb' }).click();
    await expect(status(page).getByText('Speaking…')).toHaveCount(0);
    await expect(status(page).getByText('Listening…')).toBeVisible();
  });

  test('scrolling the chat does not stop the reply @G9.45', async ({ eve, page, voice }) => {
    // A short window so the two turns overflow and the chat really scrolls.
    await page.setViewportSize({ width: 1280, height: 380 });
    await speakingHandsFree(eve, page, voice);
    const firstTurn = page.getByText('echo: open a thread from testbox');
    await expect(firstTurn).not.toBeInViewport();
    await page.getByRole('img', { name: 'Spoken' }).hover();
    await page.mouse.wheel(0, -2000);
    await expect(firstTurn).toBeInViewport();
    await expect(status(page).getByText('Speaking…')).toBeVisible();
    await expect(status(page).getByRole('button', { name: 'Stop reply' })).toBeVisible();
    // Still the first reply: a stop would let the looping mic start a second turn.
    await expect(page.getByRole('img', { name: 'Spoken' })).toHaveCount(1);
  });

  // Waits: the popup event from the click; the link opens in a new tab.
  test('tapping a link in a reply does not stop the speech @G9.45', async ({ eve, page, voice }) => {
    voice.stt.reply({ text: 'see https://example.test/page' });
    await speakingHandsFree(eve, page, voice, 'see');
    const link = page.getByRole('link', { name: /example\.test/ }).first();
    await expect(link).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await popup.close();
    await expect(status(page).getByText('Speaking…')).toBeVisible();
    await expect(status(page).getByRole('button', { name: 'Stop reply' })).toBeVisible();
    // Still the first reply: a stop would let the looping mic start a second turn.
    await expect(page.getByRole('img', { name: 'Spoken' })).toHaveCount(1);
  });

  async function switchToTextAndType(page) {
    await radio(page, 'Text').click();
    await expect(radio(page, 'Text')).toHaveAttribute('aria-checked', 'true');
    await expect(status(page)).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Type your message...' });
    await expect(composer).toBeVisible();
    await composer.fill('typed after leaving');
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Read aloud' })).toHaveCount(3);
  }

  // Waits: voice.speech.waitForStop, the page stopping the spoken reply; the typed turn's
  // reply (a third "Read aloud") closes the window for the no-new-turn checks.
  test('switching to Text while speaking stops the speech and starts no new turn @G9.46', async ({ eve, page, voice }) => {
    await speakingHandsFree(eve, page, voice);
    const heardBefore = voice.stt.requests.length;
    const stopsBefore = voice.speech.stops;
    await radio(page, 'Text').click();
    await voice.speech.waitForStop(stopsBefore);
    await switchToTextAndType(page);
    expect(voice.stt.requests).toHaveLength(heardBefore);
    await expect(page.getByRole('img', { name: 'Spoken' })).toHaveCount(1);
    await expect(status(page)).toHaveCount(0);
  });

  // Waits: the picker shows the choice, the sheet closes, voice.tts.waitForRequest on the voice id.
  // The microphone hears a sentence every few seconds, so a reply is spoken after the choice is made.
  test('the voice picked in Voice settings reads the spoken reply in Hands-free @G9.28', async ({ eve, page, voice }) => {
    // Every action is slow under CI load; a short reply lets listening resume so a later utterance goes out with the new choice.
    test.slow();
    await voice.tts.reply({ seconds: 0.1 });
    await openThread(eve, page);
    await chooseHandsFree(page);
    await page.getByRole('button', { name: 'Voice settings' }).click();
    const picker = page.getByRole('combobox', { name: 'Voice', exact: true });
    await picker.selectOption({ label: 'George' });
    await expect(picker.getByRole('option', { name: 'George', selected: true })).toBeAttached();
    await voice.tts.waitForRequest((r) => r.voice === 'bm_george');
  });

  test('Hands-free hides the textarea and Send and keeps attach @G9.43', async ({ eve, page }) => {
    await openThread(eve, page);
    await chooseHandsFree(page);
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
  });
});

test.describe('with a silent microphone, listening and nothing heard', () => {
  test.use({ mic: 'silence' });

  // Waits: voice.mic.waitForStop, the page stopping the fake microphone track.
  test('switching to Text while listening stops the microphone @G9.46', async ({ eve, page, voice }) => {
    await openThread(eve, page);
    await chooseHandsFree(page);
    await expect(status(page).getByText('Listening…')).toBeVisible();
    const stopsBefore = voice.mic.stops;
    await radio(page, 'Text').click();
    await voice.mic.waitForStop(stopsBefore);
    await expect(status(page)).toHaveCount(0);
  });
});

test.describe('with a silent microphone and a 5 second reminder', () => {
  test.use({ mic: 'silence', eveSettings: { voice: { handsFreeReminderSeconds: 5 } } });

  // Waits: voice.tts.waitForRequest carrying the reminder text.
  test('after the quiet period eve says the reminder and sends no turn @G9.47', async ({ eve, page, voice }) => {
    await openThread(eve, page);
    await chooseHandsFree(page);
    await expect(status(page).getByText('Listening…')).toBeVisible();

    await voice.tts.waitForRequest((r) => r.text === REMINDER);
    await expect(status(page).getByText(REMINDER)).toBeVisible();
    await expect(radio(page, 'Hands-free')).toHaveAttribute('aria-checked', 'true');
    // No turn went to the model: still one reply, no spoken turn, nothing heard.
    await expect(page.getByRole('img', { name: 'Spoken' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Read aloud' })).toHaveCount(1);
    expect(voice.stt.requests).toHaveLength(0);
    await expect(page.getByText(REMINDER)).toHaveCount(1); // the status line only, never a chat turn
  });
});

test.describe('a blocked microphone', () => {
  test.use({ micBlocked: true });

  // Waits: the refusal text, then the Text radio checked.
  test('Hands-free that cannot start says why and falls back to Text @G9.43.r1', async ({ eve, page }) => {
    await openThread(eve, page);
    await radio(page, 'Hands-free').click();
    await expect(page.getByText(/Hands-free could not start: ./)).toBeVisible();
    await expect(radio(page, 'Text')).toBeChecked();
    await expect(status(page)).toHaveCount(0);
  });
});

test('Voice settings opens only the voice and speed controls in every mode @G9.48', async ({ eve, page }) => {
  await openThread(eve, page);
  for (const mode of ['Text', 'Talk', 'Hands-free']) {
    await radio(page, mode).click();
    await expect(radio(page, mode)).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Voice settings' }).click();
    await expect(page.getByRole('combobox', { name: 'Voice' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Speed' })).toBeVisible();
    // Only the Voice group: no control from the Display, Modes or Files groups.
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await expect(sheet.getByRole('heading', { name: 'Display' })).toHaveCount(0);
    await expect(sheet.getByRole('heading', { name: 'Modes' })).toHaveCount(0);
    await expect(sheet.getByRole('slider', { name: 'Text size' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Speed' })).toBeHidden();
  }
});

// The same locators find those controls in the full Settings sheet, so the zero counts above mean "absent".
test('the full Settings sheet holds the groups the Voice settings sheet leaves out @G9.48', async ({ eve, page }) => {
  await openThread(eve, page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet.getByRole('heading', { name: 'Display' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Modes' })).toBeVisible();
  await expect(sheet.getByRole('slider', { name: 'Text size' })).toBeVisible();
});

// Waits: the TTS request for the second turn's reply, matched on its text.
test('a speed picked in Voice settings reaches the next spoken reply @G9.48 @G9.28', async ({ eve, page, voice }) => {
  await openThread(eve, page);
  const speaker = page.getByRole('button', { name: 'Speak replies' });
  await speaker.click();
  await expect(speaker).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Voice settings' }).click();
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption({ label: '1.5×' });
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();

  const composer = page.getByRole('textbox', { name: 'Type your message...' });
  await composer.fill('second bravo');
  await composer.press('Enter');
  const spoken = await voice.tts.waitForRequest((r) => r.text && r.text.includes('second bravo'));
  expect(spoken.speed).toBe(1.5);
});
