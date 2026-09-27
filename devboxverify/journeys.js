// The seven devbox journeys. Each drives eve's real UI as a person would and
// judges a user-visible outcome. Test ids are only click targets and anchors;
// verdicts rest on visible text or visibility. See docs/design-devboxverify.md.
const { expect } = require('@playwright/test');

const GREETING = /^(Good morning\.|Good afternoon\.|Good evening\.|Working late\.)$/;
const PASS = 'PASS';
const FAIL = 'FAIL';
const BLOCKED = 'BLOCKED';

const result = (id, state, detail) => ({ id, state, detail });
const firstLine = (err) => String(err?.message || err).split('\n')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (since) => Math.round((Date.now() - since) / 1000);
// Deliberate floor of 1 ms: Playwright reads a timeout of 0 as "no timeout".
const left = (deadline) => Math.max(1, deadline - Date.now());

// A failed wait throws with the step it belongs to, since expect's own first
// line ("expect(locator).toBeVisible() failed") names nothing.
async function need(what, promise) {
  try {
    return await promise;
  } catch (err) {
    throw new Error(`${what} (${firstLine(err)})`);
  }
}

async function poll(fn, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// D9: an exact match wins over a suffix match, because a box can offer the
// same model through several routes ("pi/…/Chat", "…/Chat") and only some of
// them are the chat kind Acme Corp may launch.
function pickModel(values, want) {
  return values.find((v) => v === want)
    || values.find((v) => v.endsWith(`/${want}`))
    || null;
}

async function optionValues(select) {
  return select.locator('option').evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
}

// App readiness is setup, not a verdict: initApp() builds client.state and
// the socket only once the auth status resolves.
async function openEve(page, env, suffix = '', deadline = null) {
  env.step('open eve');
  await page.goto(env.url.replace(/\/?$/, '/') + suffix, { timeout: 30000 });
  await need('eve did not finish loading within 20s', page.waitForFunction(
    () => !!window.client?.state && !!window.client?.wsClient, null, { timeout: deadline ? left(deadline) : 20000 }));
}

// The launcher's model form reads the list once, when it opens.
async function waitForModels(page, env) {
  env.step('wait for the model list');
  await need('no models loaded within 20s', page.waitForFunction(
    () => (window.client?.state?.models?.length || 0) > 0, null, { timeout: 20000 }));
}

async function openProject(page, env, project) {
  env.step(`open ${project.name}`);
  const rail = page.getByRole('navigation', { name: 'Projects' });
  await need(`${project.name} is not in the rail`,
    rail.getByTitle(project.name, { exact: true }).click({ timeout: 15000 }));
  await need(`${project.name} panel did not open`,
    expect(page.locator('#panelTitle')).toHaveText(project.name, { timeout: 10000 }));
}

async function worldIds(env, projects, kind) {
  const snap = await env.api.snapshot(projects);
  return snap[kind].filter((i) => i.world).map((i) => i.id);
}

const acmeIds = (env, kind) => worldIds(env, [env.projects.acme], kind);
const allWorldIds = (env, kind) => worldIds(env, [env.projects.acme, env.projects.globex, env.projects.home], kind);

const addedIds = (before, after) => after.filter((id) => !before.includes(id));

async function openLauncher(page, env) {
  env.step('open the session launcher');
  await page.getByTestId(`sidebar-new-session-${env.projects.acme.id}`).click({ timeout: 10000 });
  const dialog = page.getByTestId('dialog-shell-launcher-dialog');
  await need('the launcher did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
  return dialog;
}

// Relay's refusals and session errors arrive as {type:'error'} frames. They
// only classify an outcome and fill the detail; the verdict stays visible.
function captureErrors(page) {
  const errors = [];
  const take = (m) => { if (m && m.type === 'error') errors.push(String(m.message || m.error || '')); };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { return; }
    if (frame.type === '__batch' && Array.isArray(frame.msgs)) frame.msgs.forEach(take);
    else take(frame);
  }));
  return errors;
}

// The thread as a reader sees it, top to bottom.
async function thread(page) {
  return page.getByTestId('messages-container').evaluate((root) =>
    [...root.children].filter((el) => el.offsetParent !== null).map((el) => ({
      who: el.dataset.testid || '',
      text: (el.querySelector('.message-content')?.innerText || '').trim(),
      error: el.classList.contains('error'),
    })), null, { timeout: 10000 });
}

const threadError = (messages) => messages.find((m) => m.who === 'message-system' && m.error)?.text || '';

function replyAfter(messages, marker) {
  const at = messages.findIndex((m) => m.who === 'message-user' && m.text.includes(marker));
  if (at < 0) return { asked: false, reply: '', error: '' };
  const later = messages.slice(at + 1);
  const reply = later.filter((m) => m.who === 'message-assistant' && m.text).map((m) => m.text).join('\n').trim();
  return { asked: true, reply, error: threadError(later) };
}

async function landingView(env) {
  const id = 'landing-view';
  const page = await env.newPage();
  const deadline = Date.now() + 20000;
  await openEve(page, env, '', deadline);
  env.step('wait for the greeting');
  const home = page.getByTestId('home-screen');
  const greeting = home.getByText(GREETING);
  await need('no greeting within 20s of opening eve', expect(greeting).toBeVisible({ timeout: left(deadline) }));
  // A project's terminal template with id "chat" also gets testid home-tile-chat,
  // so each tile is found by its description as well.
  for (const [testid, name, desc] of [['home-tile-chat', 'Chat', 'Talk to a model'], ['home-tile-voice', 'Voice', 'Hands-free']]) {
    env.step(`look for the ${name} tile`);
    const tile = home.getByTestId(testid).filter({ hasText: desc });
    await need(`no "${name}" Start tile`, expect(tile).toContainText(name, { timeout: 5000 }));
    await need(`"${name}" tile not visible`, expect(tile).toBeVisible({ timeout: 5000 }));
  }
  if (await page.locator('#authScreen').isVisible()) return result(id, FAIL, 'the passkey screen is showing');
  return result(id, PASS, `"${await greeting.innerText({ timeout: 5000 })}" with Chat and Voice tiles`);
}

async function worldProjectsListed(env) {
  const id = 'world-projects-listed';
  const page = await env.newPage();
  await openEve(page, env);
  env.step('wait for the home screen');
  const home = page.getByTestId('home-screen');
  await need('no greeting within 20s', expect(home.getByText(GREETING)).toBeVisible({ timeout: 20000 }));
  const rail = page.getByRole('navigation', { name: 'Projects' });
  const missing = [];
  for (const project of [env.projects.acme, env.projects.globex, env.projects.home]) {
    env.step(`look for ${project.name}`);
    const chip = home.getByTestId(`home-project-${project.id}`);
    const chipShown = await expect(chip).toContainText(project.name, { timeout: 5000 }).then(() => true, () => false);
    const railShown = await expect(rail.getByTitle(project.name, { exact: true })).toBeVisible({ timeout: 5000 })
      .then(() => true, () => false);
    if (!chipShown) missing.push(`home chip "${project.name}"`);
    if (!railShown) missing.push(`rail entry "${project.name}"`);
  }
  if (missing.length) return result(id, FAIL, `missing ${missing.join(', ')}`);
  return result(id, PASS, 'Acme Corp, Globex and Home on Home and in the rail');
}

async function chatReply(env) {
  const id = 'chat-reply';
  const page = await env.newPage();
  const errors = captureErrors(page);
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, env.projects.acme);
  const before = await acmeIds(env, 'sessions');

  const dialog = await openLauncher(page, env);
  env.step('open the Web Chat form');
  await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 });
  const select = dialog.getByTestId('launcher-model-select');
  const model = pickModel(await optionValues(select), env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for Acme Corp`);
  await select.selectOption(model, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  // Called only once a visible failure is in hand: a refusal frame turns it
  // BLOCKED, anything else leaves it FAIL.
  const failed = (detail) => {
    const refusal = errors.find((e) => /template "chat"/.test(e));
    return refusal ? result(id, BLOCKED, `launch refused: ${refusal}`) : result(id, FAIL, detail);
  };

  env.step('wait for the session');
  const created = await poll(async () => {
    if (addedIds(before, await acmeIds(env, 'sessions')).length > 0) return {};
    const error = threadError(await thread(page));
    return error ? { error } : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!created) return failed('no Acme Corp session within 30s of Start Chat');
  if (created.error) return failed(`error in the thread: ${created.error}`);
  const added = addedIds(before, await acmeIds(env, 'sessions'));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new Acme Corp sessions, expected 1`);

  const question = `What is 2 + 2? Reply with the number only. (verify ${env.nonce})`;
  const input = page.getByTestId('chat-input');
  env.step('wait for the composer');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  await input.fill(question, { timeout: 5000 });
  env.step('send the question');
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  const sentAt = Date.now();
  await need('the question is not shown as the user message', expect(
    page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: env.nonce }),
  ).toBeVisible({ timeout: 10000 }));

  env.step('wait for the reply');
  const stop = page.getByTestId('chat-stop');
  const settled = await poll(async () => {
    const r = replyAfter(await thread(page), env.nonce);
    if (r.error) return r;
    if (r.reply && !(await stop.isVisible())) return r;
    return null;
  }, { timeoutMs: 150000, intervalMs: 1000 });
  if (!settled) return failed('no finished assistant reply within 150s');
  if (settled.error) return failed(`error in the thread: ${settled.error}`);
  const took = seconds(sentAt);
  await sleep(500);
  const late = replyAfter(await thread(page), env.nonce);
  if (late.error) return failed(`error in the thread: ${late.error}`);

  const final = addedIds(before, await acmeIds(env, 'sessions'));
  if (final.length !== 1) return result(id, FAIL, `${final.length} new Acme Corp sessions, expected 1`);
  env.shared.thread = { sessionId: final[0], question };
  const said4 = /(^|[^\d])4([^\d]|$)|\bfour\b/i.test(late.reply);
  return result(id, PASS, `reply in ${took}s, ${said4 ? 'said 4' : `did not say 4: "${late.reply.slice(0, 40)}"`}`);
}

async function openExistingThread(env) {
  const id = 'open-existing-thread';
  const t = env.shared.thread;
  if (!t) return result(id, BLOCKED, 'no thread from chat-reply');
  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, env.projects.acme);
  const before = await acmeIds(env, 'sessions');

  env.step('open the Sessions tab');
  await page.getByTestId('panel-tab-sessions').click({ timeout: 10000 });
  env.step('open the thread');
  await need('the thread is not in the Sessions list',
    page.getByTestId(`sidebar-session-${t.sessionId}`).click({ timeout: 15000 }));

  env.step('wait for the history');
  const seen = await poll(async () => {
    const r = replyAfter(await thread(page), t.question);
    return r.asked && r.reply ? r : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!seen) {
    const r = replyAfter(await thread(page), t.question);
    return result(id, FAIL, r.asked ? 'the question shows but no reply after it' : 'the question is not in the pane');
  }
  const added = addedIds(before, await acmeIds(env, 'sessions'));
  if (added.length) return result(id, FAIL, `opening the thread created ${added.length} session(s)`);
  return result(id, PASS, 'question and reply shown, no new session');
}

async function terminalOnRequest(env) {
  const id = 'terminal-on-request';
  const worldBefore = await allWorldIds(env, 'terminals');
  const before = await acmeIds(env, 'terminals');
  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, env.projects.acme);
  env.step('settle before asking');
  await sleep(3000);
  const pane = page.locator('#terminal');
  const unasked = addedIds(worldBefore, await allWorldIds(env, 'terminals'));
  if (unasked.length || await pane.isVisible()) {
    return result(id, FAIL, 'a terminal opened without being asked');
  }

  const dialog = await openLauncher(page, env);
  env.step('look for the World probe card');
  const card = dialog.getByRole('button', { name: /World probe/ });
  const loading = dialog.getByText('Loading terminal templates…');
  await need('terminal templates never loaded', expect(loading).toHaveCount(0, { timeout: 15000 }));
  if (await card.count() === 0) return result(id, BLOCKED, 'no "World probe" card for Acme Corp');
  await card.first().click({ timeout: 5000 });

  env.step('wait for the terminal');
  const mine = await poll(async () => {
    const added = addedIds(before, await acmeIds(env, 'terminals'));
    return added.length ? added : null;
  }, { timeoutMs: 20000, intervalMs: 1000 });
  if (!mine) return result(id, FAIL, 'no Acme Corp terminal within 20s of World probe');
  await need('no terminal pane shown', expect(pane).toBeVisible({ timeout: 15000 }));

  env.step('type the probe');
  const screen = pane.locator('.xterm-screen').filter({ visible: true }).last();
  await screen.click({ timeout: 5000 });
  await page.keyboard.type("printf '%s_%s\\n' EVE OK");
  await page.keyboard.press('Enter');
  const typedAt = Date.now();
  await need('EVE_OK did not show in the terminal within 20s',
    expect(pane).toContainText('EVE_OK', { timeout: 20000 }));

  const added = addedIds(before, await acmeIds(env, 'terminals'));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new Acme Corp terminals, expected 1`);
  return result(id, PASS, `EVE_OK in ${seconds(typedAt)}s, one terminal`);
}

async function taskCreatedListed(env) {
  const id = 'task-created-listed';
  const name = `verify-${env.nonce}`;
  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, env.projects.acme);

  env.step('open the Tasks tab');
  await page.getByTestId('panel-tab-tasks').click({ timeout: 10000 });
  await page.getByTestId(`sidebar-task-new-${env.projects.acme.id}`).click({ timeout: 10000 });
  const dialog = page.getByTestId('dialog-task-dialog');
  await need('the task dialog did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
  await dialog.getByRole('button', { name: 'New', exact: true }).click({ timeout: 5000 });

  env.step('fill the task form');
  await dialog.locator('[name="taskName"]').fill(name, { timeout: 5000 });
  await dialog.locator('[name="taskType"]').selectOption({ label: 'Chat (LLM)' }, { timeout: 5000 });
  await dialog.locator('[name="taskPrompt"]').fill('Say hello.', { timeout: 5000 });
  const select = dialog.locator('[name="taskModel"]');
  const values = await poll(async () => {
    const v = await optionValues(select);
    return v.length ? v : null;
  }, { timeoutMs: 20000 }) || [];
  const model = pickModel(values, env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for Acme Corp tasks`);
  await select.selectOption(model, { timeout: 5000 });
  await dialog.locator('[name="scheduleType"]').selectOption({ label: 'On demand' }, { timeout: 5000 });

  env.step('create the task');
  await dialog.getByRole('button', { name: 'Create Task' }).click({ timeout: 5000 });
  const listed = page.locator('#panelContent').getByText(name, { exact: true });
  const shown = await expect(listed).toBeVisible({ timeout: 15000 }).then(() => true, () => false);
  if (!shown) {
    const toasts = await page.locator('.toast__message').allInnerTexts();
    return result(id, FAIL, toasts.length ? `not listed; toast: ${toasts.join(' / ')}` : 'not listed after Create Task');
  }

  env.step('reload and look again');
  await page.reload({ timeout: 30000 });
  await need('eve did not finish reloading within 20s', page.waitForFunction(
    () => !!window.client?.state && !!window.client?.wsClient, null, { timeout: 20000 }));
  await openProject(page, env, env.projects.acme);
  await page.getByTestId('panel-tab-tasks').click({ timeout: 10000 });
  await need(`${name} is gone after a reload`, expect(listed).toBeVisible({ timeout: 15000 }));
  return result(id, PASS, `${name} listed, still there after a reload`);
}

async function voiceDeepLink(env) {
  const id = 'voice-deep-link';
  const first = await env.newPage();
  await openEve(first, env);
  await waitForModels(first, env);
  await openProject(first, env, env.projects.acme);
  const dialog = await openLauncher(first, env);

  env.step('find the World voice template');
  const card = dialog.getByRole('button', { name: /World voice/ });
  await need('terminal templates never loaded',
    expect(dialog.getByText('Loading terminal templates…')).toHaveCount(0, { timeout: 15000 }));
  if (await card.count() === 0) return result(id, BLOCKED, 'no "World voice" chat template in Acme Corp (setup V1)');

  env.step('star World voice');
  await card.first().getByTitle('Set as Action Button favorite').click({ timeout: 5000 });
  await need('the star did not take', expect(card.first().getByTitle('Remove as favorite')).toBeVisible({ timeout: 5000 }));
  const before = await acmeIds(env, 'sessions');
  const context = first.context();
  await first.close();

  env.step('open the voice deep link');
  const page = await context.newPage();
  const openedAt = Date.now();
  await openEve(page, env, '#/voice-chat');
  await need('the voice chat view did not show within 30s', expect(
    page.getByRole('button', { name: 'End session' })).toBeVisible({ timeout: 30000 }));
  await need('the text composer is still showing', expect(page.getByTestId('chat-input')).toBeHidden({ timeout: 5000 }));
  const took = seconds(openedAt);

  env.step('count the voice session');
  await poll(async () => addedIds(before, await acmeIds(env, 'sessions')).length > 0,
    { timeoutMs: 10000, intervalMs: 1000 });
  await sleep(1000);
  const final = addedIds(before, await acmeIds(env, 'sessions'));
  if (final.length !== 1) return result(id, FAIL, `${final.length} new Acme Corp sessions, expected 1`);
  return result(id, PASS, `voice view in ${took}s, one session`);
}

const journeys = [
  { id: 'landing-view', timeoutMs: 60000, run: landingView },
  { id: 'world-projects-listed', timeoutMs: 60000, run: worldProjectsListed },
  { id: 'chat-reply', timeoutMs: 180000, run: chatReply },
  { id: 'open-existing-thread', timeoutMs: 60000, run: openExistingThread },
  { id: 'terminal-on-request', timeoutMs: 90000, run: terminalOnRequest },
  { id: 'task-created-listed', timeoutMs: 90000, run: taskCreatedListed },
  { id: 'voice-deep-link', timeoutMs: 90000, run: voiceDeepLink },
];

module.exports = { journeys };
