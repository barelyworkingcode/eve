// S3b-1 per-mode presets: the template editor's preset row, Settings' presets
// line, Ask on the mode's Ask preset, and the Action Button (#/voice-chat) on
// the mode's voice preset. docs/design-mode-presets.md
const { test, expect } = require('./fixture');
const { nav } = require('./today-helpers');

const MODELS = {
  models: [
    { value: 'claude-a', label: 'Claude A', group: 'Claude', provider: 'claude' },
    { value: 'chat-b', label: 'Chat B', group: 'Broker', provider: 'chat' },
  ],
  providerSettings: { chat: [{ key: 'useRelayTools', label: 'Use Relay Tools', type: 'boolean', default: false }], claude: [] },
};
const T = (id, name, mode, extra = {}) => ({ id, name, model: 'chat-b', mode, voice: mode === 'voice' ? 'af_bella' : '', system_prompt: '', ...extra });
const QUICK = T('t-quick', 'Quick', 'text', { system_prompt: 'Be brief.', preset_for: ['work'] });
const KITCHEN = T('t-kitchen', 'Kitchen', 'voice', { preset_for: ['work'] });
const PLAIN = T('t-plain', 'Plain', 'text', { model: 'claude-a' });
const unmarked = ({ preset_for: _drop, ...t }) => t;
const SIX_KEYS = ['id', 'mode', 'model', 'name', 'system_prompt', 'voice'];

// Alpha (both modes) and Beta (Work only, Ask "Quick" and voice "Kitchen"); Beta is Work's default.
const world = ({ alpha = {}, beta = {}, workDefault = 'beta' } = {}) => ({
  models: MODELS,
  projects: ({ alpha: a, beta: b }) => [
    { id: 'alpha', name: 'Alpha Project', path: a, ...alpha },
    { id: 'beta', name: 'Beta Project', path: b, mode: 'work', chat_templates: [QUICK, KITCHEN, PLAIN], ...beta },
  ],
  seed: ({ relay }) => { if (workDefault) relay.setDefaultProject('work', workDefault); },
});

const ask = (page) => page.getByTestId('today-ask-input');
const toast = (page, text) => page.locator('.toast').filter({ hasText: text });
const storedTemplates = (eve, id) => eve.relay.getProject(id).chat_templates;
const isPut = (id) => (r) => r.method() === 'PUT' && new URL(r.url()).pathname === `/api/projects/${id}`;

async function openTemplates(page, projectId) {
  await page.waitForFunction((id) => window.client?.projects?.has(id), projectId);
  await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(2);
  await page.evaluate((id) => window.client.bus.emit('dialog:project', { projectId: id }), projectId);
  const dialog = page.getByTestId('dialog-project-dialog');
  await dialog.locator('.dialog__tab[data-tab="templates"]').click();
  return dialog;
}
const templateRow = (dialog, name) => dialog.locator('.project-dialog__template-item').filter({ hasText: name });
async function editTemplate(dialog, name) {
  await templateRow(dialog, name).getByTitle('Edit').click();
  return dialog.locator('.project-dialog__template-form');
}

// A fresh document, as the Action Button opens it: from the already-open page a
// goto that only adds the hash would be a same-document navigation.
async function coldLoad(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

// The page's create_session frames: sessionType and voice stop at eve, so relay never sees them.
function recordCreateFrames(page) {
  const frames = [];
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
    try { const m = JSON.parse(String(payload)); if (m.type === 'create_session') frames.push(m); } catch {}
  }));
  return frames;
}

test.describe('A3 the preset row on a Work-only project', () => {
  test.use({ world: world({ beta: { chat_templates: [unmarked(QUICK), unmarked(KITCHEN), PLAIN] } }) });

  test('Text reads "Ask preset in", Voice "Voice preset in", Work only, no checkbox; Save sends preset_for on that template only', async ({ page, eve }) => {
    const dialog = await openTemplates(page, 'beta');
    let form = await editTemplate(dialog, 'Kitchen');
    await expect(form.getByText('Voice preset in', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Back' }).click();

    form = await editTemplate(dialog, 'Quick');
    await expect(form.getByText('Ask preset in', { exact: true })).toBeVisible();
    await expect(form.getByTestId('project-template-preset-home')).toHaveCount(0);
    const work = form.getByTestId('project-template-preset-work');
    await expect(work).toHaveAttribute('aria-pressed', 'false');
    await expect(work).toHaveAttribute('type', 'button');
    await expect(form.locator('input[type="checkbox"]')).toHaveCount(0);
    await form.getByRole('radio', { name: 'Voice' }).check();
    await expect(form.getByText('Voice preset in', { exact: true })).toBeVisible();
    await form.getByRole('radio', { name: 'Text' }).check();
    await expect(form.getByText('Ask preset in', { exact: true })).toBeVisible();

    await work.click();
    await expect(work).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('button', { name: 'Save Template' }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => storedTemplates(eve, 'beta').find((t) => t.id === 't-quick').preset_for).toEqual(['work']);
    for (const t of storedTemplates(eve, 'beta').filter((x) => x.id !== 't-quick')) expect(Object.keys(t).sort()).toEqual(SIX_KEYS);
  });
});

test.describe('A3 one Ask preset per mode', () => {
  test.use({ world: world() });

  test('pressing Work on a second Text template clears it from the first; the list shows one "Work Ask" badge', async ({ page, eve }) => {
    const dialog = await openTemplates(page, 'beta');
    const form = await editTemplate(dialog, 'Plain');
    await form.getByTestId('project-template-preset-work').click();
    await form.getByRole('button', { name: 'Save Template' }).click();

    await expect(dialog.getByTestId('project-template-preset-badge').filter({ hasText: 'Work Ask' })).toHaveCount(1);
    await expect(templateRow(dialog, 'Plain').getByTestId('project-template-preset-badge')).toHaveText(['Work Ask']);
    await expect(templateRow(dialog, 'Quick').getByTestId('project-template-preset-badge')).toHaveCount(0);
    await expect(templateRow(dialog, 'Kitchen').getByTestId('project-template-preset-badge')).toHaveText(['Work voice']);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => storedTemplates(eve, 'beta').map((t) => [t.id, t.preset_for]))
      .toEqual([['t-quick', undefined], ['t-kitchen', ['work']], ['t-plain', ['work']]]);
  });
});

test.describe('A3 a project leaving a mode drops its presets there', () => {
  test.use({
    world: world({
      alpha: { chat_templates: [T('t-both', 'Both Ask', 'text', { preset_for: ['home', 'work'] }), KITCHEN, PLAIN] },
      beta: { mode: 'both', chat_templates: [PLAIN] },
    }),
  });

  async function moveToHome(page, id) {
    await page.waitForFunction((pid) => window.client?.projects?.has(pid), id);
    await page.evaluate((pid) => window.client.bus.emit('dialog:project', { projectId: pid }), id);
    await page.getByTestId('project-mode-home').click();
    const [request] = await Promise.all([page.waitForRequest(isPut(id)), page.getByTestId('project-save').click()]);
    await expect(page.getByTestId('project-save')).toBeHidden();
    return request.postDataJSON();
  }

  test('Both to Home drops work from every preset_for; with nothing to drop the PUT has no chat_templates', async ({ page }) => {
    const pruned = await moveToHome(page, 'alpha');
    expect(pruned.mode).toBe('home');
    expect(pruned.chat_templates.map((t) => [t.id, t.preset_for])).toEqual([['t-both', ['home']], ['t-kitchen', undefined], ['t-plain', undefined]]);
    expect(Object.keys(pruned.chat_templates[1]).sort()).toEqual(SIX_KEYS);

    const untouched = await moveToHome(page, 'beta');
    expect(untouched.mode).toBe('home');
    expect(untouched).not.toHaveProperty('chat_templates');
  });
});

test.describe('A4 Settings names a mode\'s presets', () => {
  for (const [label, beta, expected] of [
    ['with presets', {}, 'Ask: Quick · Voice: Kitchen'],
    ['without presets', { chat_templates: [PLAIN] }, 'Ask: none · Voice: none'],
  ]) {
    test.describe(label, () => {
      test.use({ world: world({ beta }) });

      test(`settings-presets-work reads "${expected}"; Home with no default has no presets row`, async ({ page }) => {
        await page.getByTestId('sidebar-settings').click();
        const sheet = page.getByTestId('dialog-settings-dialog');
        await expect(sheet.getByTestId('settings-presets-work')).toHaveText(expected);
        await expect(sheet.getByTestId('settings-default-work')).toHaveText('Work starts in Beta Project');
        await expect(sheet.getByTestId('settings-default-home')).toHaveText('Home: no default. Ask lets you pick.');
        await expect(sheet.getByTestId('settings-presets-home')).toHaveCount(0);
      });
    });
  }
});

test.describe('A5 Ask in Work with an Ask preset', () => {
  test.use({ world: world() });

  test('one create with the preset\'s model and prompt and both chat flags; eve-ask-model is neither read nor written', async ({ page, eve }) => {
    await page.evaluate(() => localStorage.setItem('eve-ask-model', 'claude-a'));
    await ask(page).fill('what changed today?');
    await ask(page).press('Enter');
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({
      projectId: 'beta', model: 'chat-b', systemPrompt: 'Be brief.', appendClaudeMd: true, settings: { useRelayTools: true },
    });
    await page.waitForTimeout(500);
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem('eve-ask-model'))).toBe('claude-a');
  });

  test('Ask about a file in another Work project uses the S1 model and no system prompt', async ({ page, eve }) => {
    await page.evaluate(() => localStorage.setItem('eve-ask-model', 'claude-a'));
    await nav(page).getByTitle('Alpha Project', { exact: true }).click();
    await page.getByTestId('panel-tab-files').click();
    await page.getByTestId('file-tree-item-/notes.txt').click({ button: 'right' });
    await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Ask about this' }).click();
    await expect(page.getByTestId('today-ask-attachment')).toContainText('notes.txt');
    await ask(page).fill('what is this?');
    await ask(page).press('Enter');
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'alpha', model: 'claude-a', systemPrompt: '' });
  });
});

test.describe('A5 an Ask preset on a model the project does not allow', () => {
  test.use({ world: world({ beta: { allowed_models: ['claude-a'] } }) });

  test('says why, disables Send and sends nothing', async ({ page, eve }) => {
    await ask(page).fill('hello');
    await expect(page.getByTestId('today-ask-status')).toHaveText("The Work Ask preset uses a model Beta Project doesn't allow.");
    await expect(page.getByTestId('today-ask-send')).toBeDisabled();
    await ask(page).press('Enter');
    await page.waitForTimeout(750);
    expect(eve.relay.sessionCreates).toHaveLength(0);
  });
});

test.describe('A6 #/voice-chat launches the mode\'s voice preset', () => {
  test.use({ world: world() });

  for (const how of ['cold', 'hashchange']) {
    test(`${how}: one create with the preset's model, sessionType voice and its voice`, async ({ page, eve }) => {
      const frames = recordCreateFrames(page);
      if (how === 'cold') {
        await coldLoad(page, `${eve.baseUrl}/#/voice-chat`);
      } else {
        await page.goto(eve.baseUrl);
        await page.waitForFunction(() => window.client?._hashListenerAdded && window.client.projects.has('beta'));
        await page.evaluate(() => { window.location.hash = '#/voice-chat'; });
      }
      await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
      expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'beta', model: 'chat-b' });
      expect(frames).toEqual([expect.objectContaining({ model: 'chat-b', sessionType: 'voice', voice: 'af_bella' })]);
      await page.waitForTimeout(500);
      expect(eve.relay.sessionCreates).toHaveLength(1);
    });
  }
});

test.describe('A6 a mode project without a voice preset', () => {
  test.use({ world: world({ beta: { chat_templates: [QUICK, unmarked(KITCHEN), PLAIN] } }) });

  test('toasts where to pick one and opens that project\'s launcher on Voice Chat; no create', async ({ page, eve }) => {
    await coldLoad(page, `${eve.baseUrl}/#/voice-chat`);
    await expect(toast(page, 'No Work voice preset. Pick one in Edit Project → Templates.')).toBeVisible({ timeout: 10000 });
    const launcher = page.getByTestId('dialog-shell-launcher-dialog');
    await expect(launcher.locator('.dialog__title-bar')).toContainText('Beta Project');
    await expect(launcher.getByRole('button', { name: 'Start Voice Chat' })).toBeVisible();
    await page.waitForTimeout(750);
    expect(eve.relay.sessionCreates).toHaveLength(0);
  });
});

test.describe('A6 two Work projects and no default', () => {
  test.use({ world: world({ workDefault: null }) });

  test('toasts "Set a default Work project" and creates nothing', async ({ page, eve }) => {
    await coldLoad(page, `${eve.baseUrl}/#/voice-chat`);
    await expect(toast(page, 'Set a default Work project in Relay to use the Action Button.')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(750);
    expect(eve.relay.sessionCreates).toHaveLength(0);
  });
});

test.describe('A7 #/voice-chat resumes a voice thread from the last 30 minutes', () => {
  test.use({ world: world({ alpha: { mode: 'home' } }) });

  for (const [label, projectId, minutesAgo, resumes] of [
    ['a Work voice thread created 29 minutes ago is joined, no create', 'beta', 29, true],
    ['one created 31 minutes ago is left and the preset launches', 'beta', 31, false],
    ['one in a Home-only project is left in Work and the preset launches', 'alpha', 29, false],
  ]) {
    test(label, async ({ page, eve }) => {
      const id = 'sess-voice-earlier';
      eve.relay.seedSession({
        sessionId: id, projectId, directory: eve.folders[projectId], model: 'chat-b', name: 'Voice',
        createdAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      });
      // Relay's session list carries no sessionType; eve-session-meta says voice.
      await page.evaluate((sid) => localStorage.setItem('eve-session-meta', JSON.stringify({ [sid]: { sessionType: 'voice' } })), id);
      await coldLoad(page, `${eve.baseUrl}/#/voice-chat`);
      const joined = () => eve.relay.inbound.some((f) => f.type === 'join_session' && f.sessionId === id);
      if (resumes) {
        await expect.poll(joined, { timeout: 15000 }).toBe(true);
        await expect.poll(() => page.evaluate(() => window.client.tabManager.activeTabId)).toBe(id);
        await page.waitForTimeout(1000);
        expect(eve.relay.sessionCreates).toHaveLength(0);
      } else {
        await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
        expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'beta', model: 'chat-b' });
        expect(joined()).toBe(false);
      }
    });
  }
});

test.describe('A8 the launcher star is gone', () => {
  test.use({ world: world() });

  test('template cards have no star, and a stored favoriteTemplate changes nothing on #/voice-chat', async ({ page, eve }) => {
    await expect.poll(() => page.evaluate(() => window.client.state.models.length)).toBe(2);
    await nav(page).getByTitle('Beta Project', { exact: true }).click();
    await page.getByTestId('sidebar-new-session-beta').click();
    const launcher = page.getByTestId('dialog-shell-launcher-dialog');
    await expect(launcher.getByTestId('shell-card-template-t-plain')).toBeVisible();
    await expect(launcher.locator('.shell-launcher__fav-btn')).toHaveCount(0);
    await expect(launcher.getByTitle(/Action Button favorite/)).toHaveCount(0);

    const FAV = { projectId: 'beta', templateId: 't-plain' };
    await page.addInitScript((fav) => localStorage.setItem('eve-settings', JSON.stringify({ palettes: {}, themeMode: 'dark', favoriteTemplate: fav })), FAV);
    await coldLoad(page, `${eve.baseUrl}/#/voice-chat`);
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
    // Kitchen's model, not the starred Plain's.
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'beta', model: 'chat-b' });
    await page.waitForTimeout(500);
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('eve-settings')).favoriteTemplate)).toEqual(FAV);
  });
});

test.describe('A9 touch', () => {
  test.use({ world: world({ alpha: { chat_templates: [QUICK] } }), viewport: { width: 820, height: 1180 }, hasTouch: true });

  test('under a coarse pointer the preset buttons are at least 44x44', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const dialog = await openTemplates(page, 'alpha');
    const form = await editTemplate(dialog, 'Quick');
    for (const mode of ['home', 'work']) {
      const box = await form.getByTestId(`project-template-preset-${mode}`).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(43.99);
      expect(box.height).toBeGreaterThanOrEqual(43.99);
    }
  });
});
