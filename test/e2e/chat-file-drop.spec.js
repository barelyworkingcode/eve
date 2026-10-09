// A person drops a text file on the chat input: it shows as attached, the drop
// highlight clears, and the message they send carries the file's content.
const { test, expect } = require('./goals/fixture');
const { startChatInAlpha } = require('./goals/today-helpers');

const NAME = 'acme-notes.txt';
const BODY = 'quarterly numbers for Acme\n';

test('dropping a text file on the chat input attaches it and the sent message carries it', async ({ page, eve }) => {
  await startChatInAlpha(page);
  const input = page.getByTestId('chat-input');

  const transfer = await page.evaluateHandle(({ name, body }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([body], name, { type: 'text/plain' }));
    return dt;
  }, { name: NAME, body: BODY });

  await input.dispatchEvent('dragenter', { dataTransfer: transfer });
  await input.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(input).toHaveClass(/dragover/);
  await input.dispatchEvent('drop', { dataTransfer: transfer });

  await expect(input).not.toHaveClass(/dragover/);
  await expect(page.locator('#attachedFiles .attached-file .file-name')).toHaveText(NAME);

  await input.fill('see the attached notes');
  await page.getByTestId('chat-submit').click();

  const sent = await eve.relay.waitForInbound((m) => m.type === 'send_message' && /see the attached notes/.test(m.text || ''));
  expect(sent.text).toContain(NAME);
  expect(sent.text).toContain(BODY.trim());
  await expect(page.locator('#attachedFiles .attached-file')).toHaveCount(0);
});
