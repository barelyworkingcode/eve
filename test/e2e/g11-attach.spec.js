const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function codexWorld() {
  const w = worlds.base();
  w.models = [{ value: 'codex/gpt-test', label: 'Codex Test', group: 'Codex', provider: 'codex' }];
  w.projects[0].chat_templates = [{ id: 't_codex', name: 'Codex chat', model: 'codex/gpt-test' }];
  return w;
}

async function startThread(eve, page) {
  await eve.open('/');
  await page.getByRole('textbox', { name: 'Ask' }).fill('hello from testbox');
  await page.getByRole('textbox', { name: 'Ask' }).press('Enter');
  const box = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(box).toBeVisible();
  await expect(box).toBeEnabled();
  return box;
}

test('attach files with the Attach button @G11.1', async ({ eve, page }) => {
  await startThread(eve, page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('some notes\n') },
    { name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') },
  ]);
  await expect(page.getByText('notes.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('dot.png', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'dot.png', exact: true })).toBeVisible();
});

test.describe('a model that takes no attachments', () => {
  test.use({ world: codexWorld() });

  test('no Attach button is shown @G11.1.r1', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'New Session' }).click();
    await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
    await page.getByRole('button', { name: 'Codex chat' }).click();
    const box = page.getByRole('textbox', { name: 'Type your message...' });
    await expect(box).toBeVisible();
    await expect(box).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  });
});

test('a file that cannot be read is refused @G11.1.r2', async ({ eve, page, desktop }) => {
  await startThread(eve, page);
  const path = desktop.unreadableFile('locked.txt');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles(await path);
  await expect(page.getByText('Failed to read file: locked.txt', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove locked.txt' })).toHaveCount(0);
});

test('paste an image from the clipboard @G11.2', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.paste(box, [{ name: 'image.png', type: 'image/png', base64: PNG_BASE64 }]);
  await expect(page.getByText(/^pasted-.*\.png$/)).toBeVisible();
});

test('drop files onto the message box @G11.3', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.dropFiles(box, [
    { name: 'first.txt', text: 'one\n' },
    { name: 'second.txt', text: 'two\n' },
  ]);
  await expect(page.getByText('first.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('second.txt', { exact: true })).toBeVisible();
});

test('remove an attached file before sending @G11.4', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.dropFiles(box, [
    { name: 'keep.txt', text: 'keep\n' },
    { name: 'drop.txt', text: 'drop\n' },
  ]);
  await expect(page.getByText('keep.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('drop.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove drop.txt' }).click();
  await expect(page.getByText('drop.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('keep.txt', { exact: true })).toBeVisible();
});

test('send a message with attached files @G11.5', async ({ eve, page, relay, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.dropFiles(box, [
    { name: 'alpha.txt', text: 'one\n' },
    { name: 'beta.txt', text: 'two\n' },
  ]);
  await expect(page.getByRole('button', { name: 'Remove alpha.txt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove beta.txt' })).toBeVisible();
  const since = relay.mark();
  await box.fill('read these');
  await box.press('Enter');
  // The composer chips clear; the sent message keeps a chip of each name.
  await expect(page.getByRole('button', { name: 'Remove alpha.txt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove beta.txt' })).toHaveCount(0);
  await expect(page.getByText('alpha.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('beta.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('echo: read these')).toBeVisible();
  await relay.waitForEvent('chat.turn', { since, match: (l) => l.status === 'ok' });
});

test('a dropped video is skipped @G11.6 @G11.6.r1 @G11.3.r1', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.dropFiles(box, [
    { name: 'clip.mp4', size: 1024, type: 'video/mp4' },
    { name: 'marker.txt', text: 'kept\n' },
  ]);
  // The marker chip shows once the drop has been handled, so the video had its turn.
  await expect(page.getByText('marker.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('Skipped unsupported file type: clip.mp4', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove clip.mp4' })).toHaveCount(0);
});
