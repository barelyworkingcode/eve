// S4 · Research answers show their sources, and every citation opens its
// excerpt. A brave_web_search result in a turn becomes a numbered row of
// source cards above the answer; links to those sources become chips that
// open one popover with the excerpt the model read. docs/design-research.md
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');

const TOOL = 'worldsearch__brave_web_search';
const LONG_TITLE = `Acme launch notes ${'n'.repeat(200)}`;
const IMG_TITLE = '<img src=x onerror=alert(1)>';
const WIDGET_FACTS = 'Widget facts are many. '.repeat(40);
// Brave 2.1.4: one compact JSON object per result, joined by relay with no
// separator and cut at 8,192 bytes (the long last one is left incomplete).
const RESULTS = [
  { url: 'https://www.acme.example/launch', title: LONG_TITLE, description: 'Acme <strong>ships</strong> rockets &amp; &quot;widgets&quot;', extra_snippets: ['Launch is on &lt;Monday&gt;.'] },
  { url: 'javascript:alert(1)', title: 'Script', description: 'not a source' },
  { url: 'https://widgets.example/w/', title: IMG_TITLE, description: WIDGET_FACTS },
  { url: 'https://gizmo.example/g', title: 'Gizmo', description: 'z'.repeat(9000) },
];
const RESULT = `${Buffer.from(RESULTS.map((r) => JSON.stringify(r)).join('')).subarray(0, 8192).toString()}\n...(truncated)`;
const ANSWER = [
  'Acme ships rockets [Acme launch](https://www.acme.example/launch#intro).',
  'Widgets are small [2](https://WIDGETS.example/w/).',
  'Source: [https://www.acme.example/launch](https://www.acme.example/launch)',
  'Compare [elsewhere](https://other.example/page).',
].join('\n\n');
const FOLLOW_UP = 'Again: [Acme launch](https://www.acme.example/launch) and [more](https://widgets.example/w).';

const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();
const WORLD = {
  seed: ({ relay, folders }) => {
    relay.seedSession({
      sessionId: 's-research', projectId: 'alpha', directory: folders.alpha, model: 'fake-model', name: 'Acme research',
      live: false, createdAt: iso(3), lastMessageAt: iso(2), messageCount: 4,
      history: [
        { timestamp: iso(3), role: 'user', content: 'Research the Acme launch' },
        { timestamp: iso(3), role: 'assistant', content: [{ type: 'tool_use', id: 'tu-s1', name: TOOL, input: { query: 'acme launch' } }] },
        { timestamp: iso(3), role: 'tool', content: RESULT, toolName: TOOL, toolUseId: 'tu-s1' },
        { timestamp: iso(2), role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      ],
    });
  },
};

// relay's chat stream for one turn (chat_base.go / events.go), optionally after a search.
const ev = (event) => ({ type: 'llm_event', event: { v: 2, ...event } });
function turn(answer, search) {
  const tool = (stop) => ({ type: 'tool_use', id: 'tu-live', name: TOOL, input: stop ? { query: 'acme launch' } : {} });
  return [
    ...(search ? [
      ev({ type: 'assistant', index: 0, content_block: tool(false) }),
      ev({ type: 'assistant', index: 0, content_block_stop: true, content_block: tool(true) }),
      ev({ type: 'result', subtype: 'tool_result', tool_use_id: 'tu-live', tool_name: TOOL, content: RESULT, is_error: false }),
    ] : []),
    ev({ type: 'assistant', index: 1, content_block: { type: 'text' } }),
    ev({ type: 'assistant', index: 1, delta: { type: 'text_delta', text: answer } }),
    ev({ type: 'assistant', index: 1, content_block_stop: true }),
    { type: 'message_complete' },
  ];
}

async function startChat(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('sidebar-new-session-alpha').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
  return page.evaluate(() => window.client.currentSessionId);
}

async function send(page, eve, sessionId, text, frames) {
  eve.relay.scriptSession(sessionId, frames);
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-submit').click();
}

async function openResearch(page) {
  await page.getByTestId('home-session-s-research').click();
  await expect(answer(page)).toBeVisible();
}

const thread = (page) => page.getByTestId('messages-container');
const answer = (page, text = 'Acme ships rockets') => thread(page).locator('.message.assistant').filter({ hasText: text }).last();
const popover = (page) => page.getByTestId('cite-popover');
const nextSiblingText = (el) => el.nextElementSibling && el.nextElementSibling.textContent;

// A1-A3: the row and chips any research answer must show, live or reopened.
async function expectResearchAnswer(page) {
  const row = page.getByTestId('answer-sources');
  await expect(row).toHaveCount(1);
  // Sources in result order; the javascript: and the cut-off results are none.
  await expect(row.locator('[data-testid^="answer-source-"]')).toHaveCount(2);
  await expect(page.getByTestId('answer-source-1')).toHaveText(/^\s*A\s*acme\.example\s*1\s*$/);
  await expect(page.getByTestId('answer-source-2')).toHaveText(/^\s*W\s*widgets\.example\s*2\s*$/);
  expect(await row.evaluate(nextSiblingText)).toContain('Acme ships rockets');

  const msg = answer(page);
  await expect(msg.locator('.cite-chip')).toHaveText(['1', '2', '1']);
  expect(await msg.locator('.cite-chip').evaluateAll((els) => els.map((e) => e.tagName))).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
  const paras = msg.locator('p');
  await expect(paras.nth(0)).toContainText('Acme ships rockets Acme launch'); // link text kept as plain text
  await expect(paras.nth(0).locator('a')).toHaveCount(0);
  expect(await paras.nth(1).textContent()).toBe('Widgets are small 2.'); // digits-only text dropped
  expect(await paras.nth(2).textContent()).toBe('Source: 1'); // URL-as-text dropped
}

test.describe('S4 research citations', () => {
  test.use({ world: WORLD });

  test('1 a live search turn shows the sources row and numbered chips', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await send(page, eve, sessionId, 'Research the Acme launch', turn(ANSWER, true));
    await expect(answer(page)).toBeVisible({ timeout: 15000 });
    await expectResearchAnswer(page);
  });

  test('2 the same thread from history, and after a reload, shows the same row and numbers', async ({ page }) => {
    await openResearch(page);
    await expectResearchAnswer(page);
    await reloadEve(page);
    await expect(answer(page)).toBeVisible({ timeout: 15000 });
    await expectResearchAnswer(page);
  });

  test('3 a link the search did not return stays an ordinary link', async ({ page }) => {
    await openResearch(page);
    const other = answer(page).locator('a[href="https://other.example/page"]');
    await expect(other).toHaveText('elsewhere');
    await expect(answer(page).locator('.cite-chip')).toHaveCount(3);
  });

  test('4 a chip opens its title, the stripped and decoded excerpt, and Open source', async ({ page }) => {
    await openResearch(page);
    await answer(page).getByTestId('cite-chip-1').first().click();
    const pop = popover(page);
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute('role', 'dialog');
    await expect(pop.locator('.cite-mono')).toHaveText('A');
    await expect(pop.locator('.cite-host')).toHaveText('acme.example');
    await expect(pop.locator('.cite-n')).toHaveText('1');
    expect(await pop.locator('.cite-title').textContent()).toBe(LONG_TITLE.slice(0, 160));
    expect(await pop.locator('.cite-excerpt').textContent()).toBe('Acme ships rockets & "widgets"\n\nLaunch is on <Monday>.');
    const open = pop.getByTestId('cite-open');
    await expect(open).toHaveText('Open source');
    await expect(open).toHaveAttribute('href', 'https://www.acme.example/launch');
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    await page.keyboard.press('Escape');
    await answer(page).getByTestId('cite-chip-2').focus();
    await page.keyboard.press('Enter');
    // The result's own spelling, trailing "/" included, not the normalized key.
    await expect(popover(page).getByTestId('cite-open')).toHaveAttribute('href', 'https://widgets.example/w/');
  });

  test('5 Esc, a tap outside and Close each close it; focus returns; one popover at a time', async ({ page }) => {
    await openResearch(page);
    const chip1 = answer(page).getByTestId('cite-chip-1').first();
    const chip2 = answer(page).getByTestId('cite-chip-2');

    await chip2.click();
    await expect(popover(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover(page)).toBeHidden();
    await expect(chip2).toBeFocused();

    await page.getByTestId('answer-source-1').focus();
    await page.keyboard.press('Enter');
    await expect(popover(page).locator('.cite-host')).toHaveText('acme.example');
    await chip2.focus(); // the open popover may cover chip 2, so open it from the keyboard
    await page.keyboard.press('Enter');
    await expect(popover(page)).toHaveCount(1);
    await expect(popover(page).locator('.cite-host')).toHaveText('widgets.example');
    await page.getByTestId('message-user').click();
    await expect(popover(page)).toBeHidden();
    await expect(chip2).toBeFocused(); // a tap outside returns focus too

    await chip1.focus();
    await page.keyboard.press('Space');
    await expect(popover(page).locator('.cite-n')).toHaveText('1');
    await page.getByTestId('cite-close').click();
    await expect(popover(page)).toBeHidden();
    await expect(chip1).toBeFocused();

    // A tap on another control closes it and keeps focus there.
    await chip2.focus();
    await page.keyboard.press('Enter');
    await expect(popover(page)).toBeVisible();
    await page.getByTestId('chat-input').click();
    await expect(popover(page)).toBeHidden();
    await expect(page.getByTestId('chat-input')).toBeFocused();
  });

  test('6 source text is inert: the title shows literally, no img/iframe/script, no request off eve', async ({ page, eve }) => {
    const origin = new URL(eve.baseUrl).origin;
    const offOrigin = [];
    let dialogs = 0;
    page.on('request', (r) => { if (!/^(data|blob):/.test(r.url()) && new URL(r.url()).origin !== origin) offOrigin.push(r.url()); });
    page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });
    await openResearch(page);
    await answer(page).getByTestId('cite-chip-2').click();
    expect(await popover(page).locator('.cite-title').textContent()).toBe(IMG_TITLE);
    for (const scope of [popover(page), page.getByTestId('answer-sources'), answer(page)]) {
      await expect(scope.locator('img, iframe, script')).toHaveCount(0);
    }
    await page.waitForTimeout(300);
    expect(offOrigin).toEqual([]);
    expect(dialogs).toBe(0);
  });

  test('7 a turn without search gets no row, its links stay links, and the earlier turn keeps its row', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await send(page, eve, sessionId, 'Research the Acme launch', turn(ANSWER, true));
    await expect(page.getByTestId('answer-sources')).toBeVisible({ timeout: 15000 });
    await send(page, eve, sessionId, 'And again?', turn(FOLLOW_UP, false));
    const followUp = answer(page, 'Again:');
    await expect(followUp).toBeVisible({ timeout: 15000 });

    await expect(followUp.locator('a[href="https://www.acme.example/launch"]')).toHaveText('Acme launch');
    await expect(followUp.locator('a[href="https://widgets.example/w"]')).toHaveText('more');
    await expect(followUp.locator('.cite-chip')).toHaveCount(0);
    expect(await followUp.evaluate((el) => !!(el.previousElementSibling && el.previousElementSibling.matches('[data-testid="answer-sources"]')))).toBe(false);
    await expect(page.getByTestId('answer-sources')).toHaveCount(1);
    expect(await page.getByTestId('answer-sources').evaluate(nextSiblingText)).toContain('Acme ships rockets');
  });
});

test.describe('S4 on a phone with touch', () => {
  test.use({ world: WORLD, viewport: { width: 390, height: 844 }, hasTouch: true });

  test('8 the popover stays in the viewport, targets are 44x44, and the page does not overflow', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await openResearch(page);
    const chip = answer(page).getByTestId('cite-chip-2');
    await chip.tap();
    await expect(popover(page)).toBeVisible();

    const box = await popover(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    for (const target of [chip, page.getByTestId('answer-source-1'), page.getByTestId('cite-close')]) {
      const b = await target.boundingBox();
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
