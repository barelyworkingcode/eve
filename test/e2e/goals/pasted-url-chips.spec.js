// #166 Pasted-URL chips: a link pasted into Today's Ask or the chat box is a
// chip, travels as a sources block after the typed text, shows as a chip in the
// thread, and a page the model read with web_fetch joins the sources row.
// Pastes go through the real clipboard and keyboard (ControlOrMeta+V).
const { test, expect, MODELS } = require('./fixture');
const { reloadEve } = require('../fixtures');
const { startChatInAlpha } = require('./today-helpers');

const HEAD = '\n\nSources to read (fetch each one before you answer, and cite it with a markdown link to its URL):\n';
const block = (...urls) => HEAD + urls.map((u) => `- ${u}`).join('\n');
const DOC = 'https://www.docs.example/release/2.0/?ref=paste#notes';
const DOC_LABEL = 'docs.example/release/2.0';

const ask = (page) => page.getByTestId('today-ask-input');
const chat = (page) => page.getByTestId('chat-input');
const thread = (page) => page.getByTestId('messages-container');
const sentTexts = (eve) => eve.relay.inbound.filter((m) => m.type === 'send_message').map((m) => m.text);

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
  world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.setDefaultProject('work', 'beta'); } },
});

async function paste(page, box, text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await box.focus();
  await page.keyboard.press('ControlOrMeta+V');
}

async function expectBubbleChips(page, labelsAndHrefs, text) {
  const bubble = thread(page).getByTestId('message-user').last();
  const chips = bubble.getByTestId('message-url-chip');
  await expect(chips).toHaveText(labelsAndHrefs.map(([label]) => label));
  for (const [i, [, href]] of labelsAndHrefs.entries()) await expect(chips.nth(i)).toHaveAttribute('title', href);
  await expect(bubble).toContainText(text);
  await expect(thread(page)).not.toContainText('Sources to read');
}

test.describe('Today Ask', () => {
  test('1 a pasted URL is a chip, not text; Return sends text then the block; the bubble shows a chip', async ({ page, eve }) => {
    await paste(page, ask(page), `  ${DOC}\n`);
    const chip = page.getByTestId('today-ask-url-1');
    await expect(chip).toContainText(DOC_LABEL);
    await expect(chip).toHaveAttribute('title', DOC);
    await expect(ask(page)).toHaveValue('');

    await ask(page).type('What changed in this release?');
    await ask(page).press('Enter');
    await expect.poll(() => sentTexts(eve), { timeout: 15000 }).toEqual([`What changed in this release?${block(DOC)}`]);
    await expect(page.getByTestId('today-ask-url-1')).toHaveCount(0);
    await expectBubbleChips(page, [[DOC_LABEL, DOC]], 'What changed in this release?');
  });

  test.describe('2 other pastes', () => {
    for (const text of ['see https://a.example/x', 'https://a.example/x https://b.example/y', 'javascript:alert(1)', 'ftp://files.example/a', `https://a.example/${'x'.repeat(2040)}`]) {
      test(`${text.slice(0, 40)} pastes as text and makes no chip`, async ({ page }) => {
        await paste(page, ask(page), text);
        await expect(ask(page)).toHaveValue(text);
        await expect(page.getByTestId('today-ask-url-1')).toHaveCount(0);
      });
    }
  });

  test('3 × removes a chip; a repeat adds nothing; a sixth URL pastes as text; only chips are sent', async ({ page, eve }) => {
    const u = (i) => `https://acme.example/page-${i}`;
    for (const i of [1, 1, 2, 3, 4, 5]) await paste(page, ask(page), u(i));
    await expect(ask(page)).toHaveValue('');
    await expect(page.getByTestId('today-ask-urls').locator('.ask-chip')).toHaveCount(5);
    await paste(page, ask(page), u(6));
    await expect(ask(page)).toHaveValue(u(6));
    await expect(page.getByTestId('today-ask-url-6')).toHaveCount(0);

    await expect(page.getByTestId('today-ask-url-remove-2')).toHaveAttribute('aria-label', 'Remove link acme.example/page-2');
    await page.getByTestId('today-ask-url-remove-2').click();
    await expect(page.getByTestId('today-ask-urls').locator('.ask-chip')).toHaveCount(4);
    await expect(page.getByTestId('today-ask-url-2')).toHaveAttribute('title', u(3));

    await ask(page).press('End');
    await ask(page).type(' compare these');
    await ask(page).press('Enter');
    await expect.poll(() => sentTexts(eve), { timeout: 15000 }).toEqual([`${u(6)} compare these${block(u(1), u(3), u(4), u(5))}`]);
  });

  test('8 a refused Ask keeps its text and chips, and the retry carries them', async ({ page, eve }) => {
    eve.relay.failSessionCreateWith(403, { error: 'model not allowed for this project' });
    await paste(page, ask(page), DOC);
    await ask(page).type('please');
    await ask(page).press('Enter');
    await expect(page.getByTestId('today-ask-status')).toContainText("isn't allowed");
    await expect(ask(page)).toHaveValue('please');
    await expect(page.getByTestId('today-ask-url-1')).toHaveAttribute('title', DOC);

    eve.relay.clearSessionCreateFail();
    await ask(page).press('Enter');
    await expect.poll(() => sentTexts(eve), { timeout: 15000 }).toEqual([`please${block(DOC)}`]);
  });
});

test.describe('Today Ask on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('8 the chip row fits the viewport and × is at least 44 px', async ({ page }) => {
    await ask(page).tap();
    await paste(page, ask(page), `https://acme.example/${'long-path-segment/'.repeat(6)}`);
    const row = await page.getByTestId('today-ask-urls').boundingBox();
    expect(row.x).toBeGreaterThanOrEqual(0);
    expect(row.x + row.width).toBeLessThanOrEqual(390);
    const x = await page.getByTestId('today-ask-url-remove-1').boundingBox();
    expect(x.width).toBeGreaterThanOrEqual(44);
    expect(x.height).toBeGreaterThanOrEqual(44);
    expect(x.x + x.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

// relay's chat stream (chat_base.go / events.go): a tool's input arrives only at content_block_stop.
const ev = (event) => ({ type: 'llm_event', event: { v: 2, ...event } });
function toolCall(id, name, input, content, isError = false) {
  const block = (stop) => ({ type: 'tool_use', id, name, input: stop ? input : {} });
  return [
    ev({ type: 'assistant', index: 0, content_block: block(false) }),
    ev({ type: 'assistant', index: 0, content_block_stop: true, content_block: block(true) }),
    ev({ type: 'result', subtype: 'tool_result', tool_use_id: id, tool_name: name, content, is_error: isError }),
  ];
}
const answerFrames = (text) => [
  ev({ type: 'assistant', index: 1, content_block: { type: 'text' } }),
  ev({ type: 'assistant', index: 1, delta: { type: 'text_delta', text } }),
  ev({ type: 'assistant', index: 1, content_block_stop: true }),
  { type: 'message_complete' },
];

const PAGE = 'https://lighthouse.example/guide';
const FETCH = 'macmcp__web_fetch';
const SEARCH = 'worldsearch__brave_web_search';
const HTML = '<!doctype html><html><head><title>Lighthouse &lt;img src=x onerror=alert(1)&gt; guide</title>'
  + '<style>p { color: green }</style></head>\n<body><!-- hidden note -->\n<h1>Lighthouse</h1>\n'
  + '<script>window.__pwned = "lighthouse-script-marker"</script>\n'
  + '<p>The lighthouse is painted <b>green</b> &amp; white.</p>\n<p>Visit &lt;daily&gt;.</p>\n</body></html>';
const fetched = (status, body) => `HTTP ${status} — text/html; charset=utf-8 — ${body.length} bytes\n\n${body}`;
const SEARCH_RESULT = JSON.stringify({ url: 'https://acme.example/launch', title: 'Acme launch', description: 'Acme ships.' });

test.describe('chat input', () => {
  async function pasteAndSend(page, eve, frames, text) {
    const sessionId = await startChatInAlpha(page);
    if (frames) eve.relay.scriptSession(sessionId, frames);
    await paste(page, chat(page), PAGE);
    await expect(page.getByTestId('chat-url-1')).toContainText('lighthouse.example/guide');
    await expect(chat(page)).toHaveValue('');
    await chat(page).type(text);
    await page.getByTestId('chat-submit').click();
    return sessionId;
  }

  test('4 paste and send: W2 text, chip cleared, bubble chip, and no sources row without a fetch', async ({ page, eve }) => {
    await pasteAndSend(page, eve, null, 'What colour is it?');
    await expect.poll(() => sentTexts(eve), { timeout: 15000 }).toEqual([`What colour is it?${block(PAGE)}`]);
    await expect(page.getByTestId('chat-url-1')).toHaveCount(0);
    await expectBubbleChips(page, [['lighthouse.example/guide', PAGE]], 'What colour is it?');
    await expect(thread(page)).toContainText('Hello from fake relay', { timeout: 15000 });
    await expect(page.getByTestId('answer-sources')).toHaveCount(0);
  });

  test('5 with a text file: text, then the block, then the file block', async ({ page, eve }) => {
    await startChatInAlpha(page);
    await page.locator('#fileInput').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\n') });
    await paste(page, chat(page), PAGE);
    await chat(page).type('Summarise');
    await page.getByTestId('chat-submit').click();
    await expect.poll(() => sentTexts(eve), { timeout: 15000 })
      .toEqual([`Summarise${block(PAGE)}\n\nAttached file: notes.txt\n\`\`\`\nfirst line\n\n\`\`\``]);
  });

  test('2 an image paste attaches the image as today and makes no chip', async ({ page }) => {
    await startChatInAlpha(page);
    await page.evaluate(async (url) => {
      const c = document.createElement('canvas');
      c.width = 2; c.height = 2;
      const png = await new Promise((r) => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png, 'text/plain': new Blob([url], { type: 'text/plain' }) })]);
    }, PAGE);
    await chat(page).focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.locator('#attachedFiles .attached-image')).toHaveCount(1);
    await expect(page.getByTestId('chat-url-1')).toHaveCount(0);
  });

  test('6 a 2xx web_fetch is source 1 with title and excerpt as text; a search numbers after it; no request to the page', async ({ page, eve }) => {
    const origin = new URL(eve.baseUrl).origin;
    const offOrigin = [];
    page.on('request', (r) => { if (!/^(data|blob):/.test(r.url()) && new URL(r.url()).origin !== origin) offOrigin.push(r.url()); });
    await pasteAndSend(page, eve, [
      ...toolCall('tu-f', FETCH, { url: PAGE }, `${fetched(200, HTML)}\n...(truncated)`),
      ...toolCall('tu-s', SEARCH, { query: 'acme' }, SEARCH_RESULT),
      ...answerFrames(`It is green [the guide](${PAGE}).`),
    ], 'What colour is the lighthouse?');

    const answer = thread(page).locator('.message.assistant').filter({ hasText: 'It is green' }).last();
    await expect(answer).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('answer-source-1')).toHaveText(/lighthouse\.example\s*1\s*$/);
    await expect(page.getByTestId('answer-source-2')).toHaveText(/acme\.example\s*2\s*$/);
    await answer.getByTestId('cite-chip-1').click();
    const pop = page.getByTestId('cite-popover');
    expect(await pop.locator('.cite-title').textContent()).toBe('Lighthouse <img src=x onerror=alert(1)> guide');
    expect(await pop.locator('.cite-excerpt').textContent()).toBe('Lighthouse The lighthouse is painted green & white. Visit <daily>.');
    await expect(pop.locator('img, iframe, script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    await page.waitForTimeout(300);
    expect(offOrigin).toEqual([]);
  });

  test('7 a 404, a refusal and an error result give no sources row', async ({ page, eve }) => {
    await pasteAndSend(page, eve, [
      ...toolCall('tu-1', FETCH, { url: PAGE }, fetched(404, '<title>Gone</title><p>Not found</p>')),
      ...toolCall('tu-2', FETCH, { url: PAGE }, 'Error: access denied: outbound access is not allowed for this project'),
      ...toolCall('tu-3', FETCH, { url: PAGE }, 'Error: mcp: call "web_fetch": context deadline exceeded', true),
      ...answerFrames(`I could not read [the guide](${PAGE}).`),
    ], 'What colour is the lighthouse?');
    const answer = thread(page).locator('.message.assistant').filter({ hasText: 'I could not read' }).last();
    await expect(answer).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('answer-sources')).toHaveCount(0);
    await expect(answer.locator('.cite-chip')).toHaveCount(0);
  });
});

test.describe('replay', () => {
  const TEXT = `Seeded question${block(PAGE, DOC)}\n\nAttached file: notes.txt\n\`\`\`\nfirst line\n\`\`\``;
  test.use({
    world: {
      seed: ({ relay, folders }) => {
        relay.setModels(MODELS);
        const at = new Date(Date.now() - 3600000).toISOString();
        relay.seedSession({
          sessionId: 's-urls', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Seeded urls',
          live: false, createdAt: at, lastMessageAt: at, messageCount: 2,
          history: [
            { timestamp: at, role: 'user', content: TEXT },
            { timestamp: at, role: 'assistant', content: [{ type: 'text', text: 'Seeded answer' }] },
          ],
        });
      },
    },
  });

  test('5 a stored block and file replay as chips with clean text, after a reload too', async ({ page }) => {
    const expectReplay = async () => {
      await expect(thread(page)).toContainText('Seeded answer', { timeout: 15000 });
      await expectBubbleChips(page, [['lighthouse.example/guide', PAGE], [DOC_LABEL, DOC]], 'Seeded question');
      const bubble = thread(page).getByTestId('message-user').last();
      await expect(bubble.locator('.message-file:not(.message-url)')).toHaveText(['notes.txt']);
      await expect(bubble).not.toContainText('Attached file');
      await expect(bubble).not.toContainText('first line');
    };
    await page.getByTestId('home-session-s-urls').click();
    await expectReplay();
    await reloadEve(page);
    await expectReplay();
  });
});
