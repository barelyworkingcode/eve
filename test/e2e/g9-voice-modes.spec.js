const { test, expect, profiles } = require('./support/fixtures');

const HEARD = 'hello from the test microphone';
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function openThread(eve, page) {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await ask.fill('open a thread from testbox');
  await ask.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Type your message...' })).toBeVisible();
}

function modes(page) {
  return page.getByRole('radiogroup', { name: 'Voice mode' });
}

async function chooseTalk(page) {
  await modes(page).getByRole('radio', { name: 'Talk' }).click();
  await expect(modes(page).getByRole('radio', { name: 'Talk' })).toHaveAttribute('aria-checked', 'true');
}

// Press and keep the Talk button down until the recorder has started.
async function holdToTalk(page) {
  const hold = page.getByRole('button', { name: 'Hold to talk' });
  await hold.hover();
  await page.mouse.down();
  await expect(page.getByRole('button', { name: 'Release to send' })).toHaveAttribute('aria-pressed', 'true');
}

async function release(page) {
  await page.mouse.up();
}

async function modeControl(eve, page) {
  await openThread(eve, page);
  const group = modes(page);
  await expect(group.getByRole('radio', { name: 'Text' })).toBeVisible();
  await expect(group.getByRole('radio', { name: 'Talk' })).toBeVisible();
  await expect(group.getByRole('radio', { name: 'Hands-free' })).toBeVisible();
  await expect(group.getByRole('radio', { name: 'Talk' })).toHaveAttribute('aria-checked', 'false');
  await group.getByRole('radio', { name: 'Talk' }).click();
  await expect(group.getByRole('radio', { name: 'Talk' })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'false');
  await group.getByRole('radio', { name: 'Text' }).click();
  await expect(group.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
}

test('the chat offers Text, Talk and Hands-free and one tap switches @G9.38', async ({ eve, page }) => {
  await modeControl(eve, page);
});

test.describe('on a phone', () => {
  test.use(profiles.phone);

  test('the phone shows the same mode control @G9.38', async ({ eve, page }) => {
    await modeControl(eve, page);
  });
});

test('hold to talk records only while held and sends a spoken turn @G9.39 @G9.41', async ({ eve, page, voice }) => {
  await openThread(eve, page);
  await chooseTalk(page);

  const hold = page.getByRole('button', { name: 'Hold to talk' });
  await expect(hold).toBeVisible();
  expect(voice.stt.requests).toHaveLength(0);

  await holdToTalk(page);
  await release(page);

  await expect(page.getByRole('img', { name: 'Spoken' })).toBeVisible();
  await expect(page.getByText(HEARD).first()).toBeVisible();
  // The reply arrives as text too.
  await expect(page.getByRole('button', { name: 'Read aloud' })).toBeVisible();
  await expect(page.getByText(HEARD)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Hold to talk' })).toHaveAttribute('aria-pressed', 'false');
});

test('the chat shows the words while the Talk button is still held @G9.39', async ({ eve, page, voice }) => {
  voice.stt.reply({ text: 'words said while holding' });
  await openThread(eve, page);
  await chooseTalk(page);

  await holdToTalk(page);
  await voice.stt.waitForRequest();
  await expect(page.getByText('words said while holding')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release to send' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Spoken' })).toHaveCount(0);
  await release(page);
  await expect(page.getByRole('img', { name: 'Spoken' })).toBeVisible();
});

test('the speaker is off on a fresh device and the setting survives a reload @G9.40', async ({ eve, page }) => {
  await openThread(eve, page);
  const speaker = page.getByRole('button', { name: 'Speak replies' });
  await expect(speaker).toHaveAttribute('aria-pressed', 'false');
  await speaker.click();
  await expect(speaker).toHaveAttribute('aria-pressed', 'true');

  await eve.reload();
  await expect(page.getByRole('button', { name: 'Speak replies' })).toHaveAttribute('aria-pressed', 'true');
});

async function sendText(page, text) {
  const composer = page.getByRole('textbox', { name: 'Type your message...' });
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Read aloud' })).toBeVisible();
}

test('with the speaker on, a reply is spoken @G9.40', async ({ eve, page, voice }) => {
  await openThread(eve, page);
  await page.getByRole('button', { name: 'Speak replies' }).click();
  await expect(page.getByRole('button', { name: 'Speak replies' })).toHaveAttribute('aria-pressed', 'true');

  await sendText(page, 'speak this from testbox');
  const request = await voice.tts.waitForRequest((r) => JSON.stringify(r).includes('speak this from testbox'));
  expect(request.text).toContain('speak this from testbox');
});

test('with the speaker off, a reply is not spoken @G9.40', async ({ eve, page, voice }) => {
  await openThread(eve, page);
  await expect(page.getByRole('button', { name: 'Speak replies' })).toHaveAttribute('aria-pressed', 'false');

  await sendText(page, 'stay quiet from testbox');
  // Read aloud is the positive marker that the reply finished rendering.
  await expect(page.getByRole('button', { name: 'Read aloud' })).toBeVisible();
  expect(voice.tts.requests.filter((r) => r.action !== 'list_voices')).toHaveLength(0);
});

test('an image attached in Talk goes with the next spoken turn @G9.42', async ({ eve, page }) => {
  await openThread(eve, page);
  await chooseTalk(page);

  const attach = page.getByRole('button', { name: 'Attach files' });
  await expect(attach).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await attach.click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('photo.png')).toBeVisible();

  await holdToTalk(page);
  await release(page);
  await expect(page.getByRole('img', { name: 'Spoken' })).toBeVisible();
  // The turn consumed the attachment: it now shows once, in the sent message.
  await expect(page.getByRole('button', { name: 'Remove attachment', exact: true })).toHaveCount(0);
  await expect(page.getByText('photo.png')).toBeVisible();
});
