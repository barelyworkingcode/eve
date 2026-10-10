const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A model whose reply is a permission prompt: the turn stays open, so no echo of the
// sent text (which carries the added "Sources to read" block) reaches the screen.
function holdWorld() {
  const w = worlds.base();
  w.projects[0].allowed_models = ['acme-ask'];
  w.models = [
    { value: 'acme-ask', label: 'Acme Ask', group: 'Claude', provider: 'claude', reply: { kind: 'permission', tool: 'Bash' } },
  ];
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

const link = (n) => `https://docs.acme.test/page${n}`;
const shown = (n) => `docs.acme.test/page${n}`;
const remove = (page, n) => page.getByRole('button', { name: `Remove link ${shown(n)}`, exact: true });

// A trusted paste: cut what the box holds, then paste it back, so the page gets a paste
// carrying the link and the browser inserts any text the page leaves to it.
async function cutAndPaste(page, box, text) {
  await box.fill(text);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+X');
  await page.keyboard.press('ControlOrMeta+V');
}

test('turn a pasted link into a chip in the composer @G2.34', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.paste(box, [link(1)]);
  await expect(remove(page, 1)).toBeVisible();
  await expect(box).toHaveValue('');
});

test('the sixth link pastes as plain text @G2.34.r1', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  for (let n = 1; n <= 5; n++) {
    await desktop.paste(box, [link(n)]);
    await expect(remove(page, n)).toBeVisible();
  }
  await cutAndPaste(page, box, link(6));
  await expect(box).toHaveValue(link(6));
  await expect(remove(page, 6)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove link / })).toHaveCount(5);
});

test('the same link twice stays one chip @G2.34.r2', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.paste(box, [link(1)]);
  await expect(remove(page, 1)).toBeVisible();
  // The repeat is swallowed, so a different link pasted after it is the marker that it was handled.
  await cutAndPaste(page, box, link(1));
  await desktop.paste(box, [link(2)]);
  await expect(remove(page, 2)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove link / })).toHaveCount(2);
});

test('remove a pasted link chip from the composer @G2.35', async ({ eve, page, desktop }) => {
  const box = await startThread(eve, page);
  await desktop.paste(box, [link(1)]);
  await desktop.paste(box, [link(2)]);
  await expect(remove(page, 2)).toBeVisible();
  await remove(page, 1).click();
  await expect(remove(page, 1)).toHaveCount(0);
  await expect(remove(page, 2)).toBeVisible();
  await expect(box).toBeFocused();
});

test.describe('a turn that is held', () => {
  test.use({ world: holdWorld() });

  test('send a message with link chips @G2.36', async ({ eve, page, desktop }) => {
    await eve.open('/');
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
    await page.getByRole('button', { name: 'New Session' }).click();
    await page.getByRole('button', { name: 'Web Chat' }).click();
    await page.getByRole('button', { name: 'Start Chat' }).click();
    const box = page.getByRole('textbox', { name: 'Type your message...' });
    await expect(box).toBeEnabled();
    await desktop.paste(box, [link(1)]);
    await expect(remove(page, 1)).toBeVisible();
    await box.fill('read this from testbox');
    await box.press('Enter');
    await expect(page.getByRole('heading', { name: 'Permission Request' })).toBeVisible();
    // The sent message holds the chip and the typed text together.
    await expect(page.getByText('read this from testbox')).toBeVisible();
    await expect(page.getByText(shown(1), { exact: true })).toBeVisible();
    await expect(remove(page, 1)).toHaveCount(0);
    await expect(page.getByText('Sources to read')).toBeHidden();
  });
});

test('turn a pasted link into a chip in Today\'s Ask box @G2.37', async ({ eve, page, desktop }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await desktop.paste(ask, [link(1)]);
  await expect(remove(page, 1)).toBeVisible();
  await expect(ask).toHaveValue('');
});

test('the sixth link in Ask pastes as plain text @G2.37.r1', async ({ eve, page, desktop }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  for (let n = 1; n <= 5; n++) {
    await desktop.paste(ask, [link(n)]);
    await expect(remove(page, n)).toBeVisible();
  }
  await cutAndPaste(page, ask, link(6));
  await expect(ask).toHaveValue(link(6));
  await expect(remove(page, 6)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove link / })).toHaveCount(5);
});

test('remove a pasted link chip from Today\'s Ask box @G2.38', async ({ eve, page, desktop }) => {
  await eve.open('/');
  const ask = page.getByRole('textbox', { name: 'Ask' });
  await desktop.paste(ask, [link(1)]);
  await desktop.paste(ask, [link(2)]);
  await expect(remove(page, 2)).toBeVisible();
  await remove(page, 1).click();
  await expect(remove(page, 1)).toHaveCount(0);
  await expect(remove(page, 2)).toBeVisible();
});
