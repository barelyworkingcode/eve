// S3b-2 Ask in the other mode: a refused tool call in a thread offers "Ask in
// <Other>", which reruns the last user turn as a new thread in the other mode's
// project and never writes to the first. docs/design-mode-presets.md
const { test, expect } = require('./fixture');

const MODELS = {
  models: [
    { value: 'chat-b', label: 'Chat B', group: 'Broker', provider: 'chat' },
    { value: 'claude-a', label: 'Claude A', group: 'Claude', provider: 'claude' },
  ],
  providerSettings: { chat: [], claude: [] },
};
const FIRST_LINE = 'Check the Acme Corp mailbox for the March invoice and its due date';
const LAST_TURN = `${FIRST_LINE}\nThen tell me the amount.`;
const DENIED = "Error: mcp: call \"mail_send\": access denied: tool 'mail_send' is not in the allowed tools";
const QUICK = { id: 't-quick', name: 'Quick', model: 'chat-b', mode: 'text', voice: '', system_prompt: 'Be brief.', preset_for: ['work'] };
const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();

// Home default `ph` (Home only), Work default `pw` (Work only), unless overridden.
const world = ({ projects, defaults = { home: 'ph', work: 'pw' }, sessions = [['s-home', 'ph', 'Invoices']] } = {}) => ({
  models: MODELS,
  projects: ({ alpha, beta }) => projects ? projects({ alpha, beta }) : [
    { id: 'ph', name: 'Household', path: alpha, mode: 'home' },
    { id: 'pw', name: 'Acme Work', path: beta, mode: 'work' },
  ],
  seed: ({ relay, folders }) => {
    relay.setModels(MODELS);
    for (const [mode, id] of Object.entries(defaults)) relay.setDefaultProject(mode, id);
    for (const [sessionId, projectId, name] of sessions) {
      relay.seedSession({
        sessionId, projectId, directory: folders.alpha, model: 'chat-b', name, live: false, createdAt: iso(3), lastMessageAt: iso(2), messageCount: 3,
        history: [
          { timestamp: iso(3), role: 'user', content: 'Find the March invoice.' },
          { timestamp: iso(3), role: 'assistant', content: [{ type: 'text', text: 'Which account?' }] },
          { timestamp: iso(2), role: 'user', content: LAST_TURN },
        ],
      });
    }
  },
});

const button = (page) => page.getByTestId('thread-ask-elsewhere');
const toast = (page, text) => page.locator('.toast').filter({ hasText: text });
const toolResult = (extra) => ({ v: 2, type: 'result', subtype: 'tool_result', tool_use_id: 'tu-1', tool_name: 'mail_get_emails', content: 'Account is out of scope', ...extra });
const SCOPE = toolResult({ is_error: true, scope_violation: true });

async function openThread(page, eve, sessionId, name) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill(name);
  await page.getByTestId('palette-item').filter({ hasText: name }).first().click();
  await expect(page).toHaveURL(new RegExp(`#session/${sessionId}`));
  await eve.relay.waitForInbound((m) => m.type === 'join_session' && m.sessionId === sessionId);
  await expect(page.getByTestId('messages-container')).toContainText('Then tell me the amount.');
}

async function openHome(page, eve, sessionId = 's-home', name = 'Invoices') {
  await page.getByTestId('mode-home').click();
  await expect(page.getByTestId('mode-home')).toHaveAttribute('aria-checked', 'true');
  await openThread(page, eve, sessionId, name);
}

function refuse(eve, sessionId, event = SCOPE) {
  expect(eve.relay.emitToSession(sessionId, { type: 'llm_event', sessionId, event })).toBe(1);
}

// Every frame the page sends; reloads so eve's socket opens under the recorder.
async function recordFrames(page) {
  const frames = [];
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => { try { frames.push(JSON.parse(String(payload))); } catch {} }));
  await page.reload();
  await page.waitForFunction(() => !!window.client?.state);
  return frames;
}

test.describe('A11-A13 a refused Home thread asks again in Work', () => {
  test.use({ world: world() });

  test('scope refusal: "Ask in Work"; the click creates one Work thread with the last turn, switches mode, and leaves the Home thread alone', async ({ page, eve }) => {
    await page.evaluate(() => localStorage.setItem('eve-ask-model', 'claude-a'));
    const frames = await recordFrames(page);
    await openHome(page, eve);
    await expect(button(page)).toBeHidden();
    refuse(eve, 's-home');
    await expect(button(page)).toHaveText('Ask in Work');

    const before = frames.length;
    const relayBefore = eve.relay.requests.length;
    await button(page).click();
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'pw', model: 'claude-a', name: `Acme Work - ${FIRST_LINE.slice(0, 48)}` });
    const created = eve.relay.listSessions().find((s) => s.projectId === 'pw');
    await expect.poll(() => frames.slice(before).filter((f) => f.type === 'user_input').length).toBe(1);
    expect(frames.slice(before).find((f) => f.type === 'user_input')).toMatchObject({ sessionId: created.sessionId, text: LAST_TURN, files: [] });
    await expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe(created.sessionId);

    await page.waitForTimeout(750);
    expect(await page.evaluate(() => window.client.tabManager.tabs.some((t) => t.id === 's-home'))).toBe(true);
    expect(frames.slice(before).filter((f) => f.sessionId === 's-home')).toEqual([]);
    expect(eve.relay.requests.slice(relayBefore).filter((r) => r.method !== 'GET' && r.path.includes('s-home'))).toEqual([]);
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(eve.relay.listSessions().find((s) => s.sessionId === 's-home').projectId).toBe('ph');
  });

  for (const [label, event, shows] of [
    ['is_error with relay\'s "access denied: " text', toolResult({ is_error: true, content: DENIED }), true],
    ['a Claude user-message tool_result block with is_error and "access denied: "',
      { v: 2, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: [{ type: 'text', text: DENIED }] }] } }, true],
    ['is_error with other text', toolResult({ is_error: true, content: 'Error: mcp: timeout' }), false],
    ['is_error false that mentions access denied', toolResult({ is_error: false, content: DENIED }), false],
  ]) {
    test(`${label}: ${shows ? 'the button' : 'no button'}`, async ({ page, eve }) => {
      await openHome(page, eve);
      refuse(eve, 's-home', event);
      if (shows) {
        await expect(button(page)).toHaveText('Ask in Work');
        return;
      }
      await page.waitForTimeout(750);
      await expect(button(page)).toBeHidden();
      // The same thread does show it for a refusal, so the hidden button above is the frame's doing.
      refuse(eve, 's-home');
      await expect(button(page)).toBeVisible();
    });
  }
});

test.describe('A11 A12 a refusal on a background tab', () => {
  test.use({ world: world({ sessions: [['s-home', 'ph', 'Invoices'], ['s-home2', 'ph', 'Recipes']] }) });

  test('shows on switching to that tab and hides on switching away', async ({ page, eve }) => {
    await openHome(page, eve);
    await openThread(page, eve, 's-home2', 'Recipes');
    refuse(eve, 's-home');
    await page.waitForTimeout(500);
    await expect(button(page)).toBeHidden();
    await page.getByTestId('tab-s-home').click();
    await expect(button(page)).toHaveText('Ask in Work');
    await page.getByTestId('tab-s-home2').click();
    await expect(button(page)).toBeHidden();
  });
});

test.describe('A13 Work has an Ask preset', () => {
  for (const [label, pw, allowed] of [
    ['the rerun carries its model and system prompt', {}, true],
    ['a preset model Work\'s project does not allow: the toast, no create', { allowed_models: ['claude-a'] }, false],
  ]) {
    test.describe(label, () => {
      test.use({
        world: world({
          projects: ({ alpha, beta }) => [
            { id: 'ph', name: 'Household', path: alpha, mode: 'home' },
            { id: 'pw', name: 'Acme Work', path: beta, mode: 'work', chat_templates: [QUICK], ...pw },
          ],
        }),
      });

      test(label, async ({ page, eve }) => {
        await page.evaluate(() => localStorage.setItem('eve-ask-model', 'claude-a'));
        await openHome(page, eve);
        refuse(eve, 's-home');
        await button(page).click();
        if (allowed) {
          await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
          expect(eve.relay.sessionCreates[0]).toMatchObject({
            projectId: 'pw', model: 'chat-b', systemPrompt: 'Be brief.', appendClaudeMd: true, settings: { useRelayTools: true },
          });
          return;
        }
        await expect(toast(page, "The Work Ask preset uses a model Acme Work doesn't allow.")).toBeVisible();
        await page.waitForTimeout(750);
        expect(eve.relay.sessionCreates).toHaveLength(0);
      });
    });
  }
});

test.describe('A13 two Work projects and no Work default', () => {
  test.use({
    world: world({
      projects: ({ alpha, beta }) => [
        { id: 'ph', name: 'Household', path: alpha, mode: 'home' },
        { id: 'pw', name: 'Acme Work', path: beta, mode: 'work' },
        { id: 'pw2', name: 'Acme Labs', path: beta, mode: 'work' },
      ],
      defaults: { home: 'ph' },
    }),
  });

  test('the toast names what to set, and nothing is created', async ({ page, eve }) => {
    await openHome(page, eve);
    refuse(eve, 's-home');
    await button(page).click();
    await expect(toast(page, 'Set a default Work project in Relay to ask there.')).toBeVisible();
    await page.waitForTimeout(750);
    expect(eve.relay.sessionCreates).toHaveLength(0);
  });
});

test.describe('A12 a Both project that is the default for both modes', () => {
  test.use({
    world: world({
      projects: ({ alpha }) => [
        { id: 'pb', name: 'Everything', path: alpha, mode: 'both' },
        { id: 'ph', name: 'Household', path: alpha, mode: 'home' },
      ],
      defaults: { home: 'pb', work: 'pb' },
      sessions: [['s-both', 'pb', 'Both thread'], ['s-home', 'ph', 'Invoices']],
    }),
  });

  test('no button there; a Home-only thread in the same setup gets one', async ({ page, eve }) => {
    await openHome(page, eve, 's-both', 'Both thread');
    refuse(eve, 's-both');
    await page.waitForTimeout(750);
    await expect(button(page)).toBeHidden();
    await openThread(page, eve, 's-home', 'Invoices');
    refuse(eve, 's-home');
    await expect(button(page)).toHaveText('Ask in Work');
  });
});

test.describe('A14 Today\'s Ask is not touched', () => {
  test.use({ world: world() });

  for (const refused of [false, true]) {
    test(refused ? 'a rerun relay refuses: a plain-words toast, Ask keeps its text and shows no failure' : 'text typed in Ask survives a rerun', async ({ page, eve }) => {
      await page.getByTestId('mode-home').click();
      await page.getByTestId('today-ask-input').fill('draft for later');
      await openThread(page, eve, 's-home', 'Invoices');
      if (refused) eve.relay.failSessionCreateWith(403, { error: 'model not allowed for this project' });
      refuse(eve, 's-home');
      await button(page).click();
      await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
      if (refused) {
        await expect(toast(page, "isn't allowed")).toBeVisible();
        await expect(toast(page, 'HTTP')).toHaveCount(0);
      } else {
        await expect.poll(() => eve.relay.inbound.some((m) => m.type === 'send_message' && m.text.includes('Then tell me'))).toBe(true);
      }
      await page.waitForTimeout(500);
      await expect(page.getByTestId('today-ask-input')).toHaveValue('draft for later');
      await expect(page.getByTestId('today-ask-status')).not.toContainText("isn't allowed");
      await expect(page.getByTestId('today-ask-status')).not.toContainText("Couldn't start");
    });
  }
});

test.describe('A12 a voice thread', () => {
  test.use({ world: world({ sessions: [['s-voice', 'ph', 'Kitchen talk'], ['s-home', 'ph', 'Invoices']] }) });

  test('a refusal there shows no button; a text thread beside it does', async ({ page, eve }) => {
    await page.evaluate(() => localStorage.setItem('eve-session-meta', JSON.stringify({ 's-voice': { sessionType: 'voice' } })));
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await openHome(page, eve, 's-voice', 'Kitchen talk');
    // Setup guard: eve took the thread as voice.
    expect(await page.evaluate(() => window.client.state.sessions.get('s-voice')?.sessionType)).toBe('voice');
    refuse(eve, 's-voice');
    await page.waitForTimeout(750);
    await expect(button(page)).toBeHidden();
    await openThread(page, eve, 's-home', 'Invoices');
    refuse(eve, 's-home');
    await expect(button(page)).toBeVisible();
  });
});

test.describe('A15 touch', () => {
  test.use({ world: world(), viewport: { width: 820, height: 1180 }, hasTouch: true });

  test('under a coarse pointer the button is at least 44x44', async ({ page, eve }) => {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await openHome(page, eve);
    refuse(eve, 's-home');
    await expect(button(page)).toBeVisible();
    const box = await button(page).boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(43.99);
    expect(box.height).toBeGreaterThanOrEqual(43.99);
  });
});
