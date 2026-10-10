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
async function speakingHandsFree(eve, page, voice) {
  await openThread(eve, page);
  await chooseHandsFree(page);
  await voice.stt.waitForRequest();
  await expect(page.getByRole('img', { name: 'Spoken' })).toBeVisible();
  await voice.tts.waitForRequest((r) => r.text && r.text.includes(HEARD));
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
    await speakingHandsFree(eve, page, voice);
    await page.getByRole('img', { name: 'Spoken' }).hover();
    await page.mouse.wheel(0, -600);
    await page.mouse.wheel(0, 600);
    await expect(status(page).getByText('Speaking…')).toBeVisible();
    await expect(status(page).getByRole('button', { name: 'Stop reply' })).toBeVisible();
  });

  test('switching to Text stops listening and speech on the same tap @G9.46', async ({ eve, page, voice }) => {
    await speakingHandsFree(eve, page, voice);
    await radio(page, 'Text').click();
    await expect(radio(page, 'Text')).toHaveAttribute('aria-checked', 'true');
    await expect(status(page)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
  });

  test('Hands-free hides the textarea and Send and keeps attach @G9.43', async ({ eve, page }) => {
    await openThread(eve, page);
    await chooseHandsFree(page);
    await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
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
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Speed' })).toBeHidden();
  }
});
