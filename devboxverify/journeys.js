// The devbox journeys. Each drives eve's real UI as a person would and
// judges a user-visible outcome. Test ids are only click targets and anchors;
// verdicts rest on visible text or visibility. See docs/design-devboxverify.md.
/** @typedef {{ id: string, timeoutMs: number, areas: string[], fixture?: true, screen?: true, knownBug?: string, run(env): Promise<object> }} Journey */
const { expect } = require('@playwright/test');
const {
  GREETING, PASS, FAIL, BLOCKED, result, sleep, seconds, left, need, poll, pickModel, optionValues,
  openEve, waitForModels, openProject, acmeIds, allWorldIds, addedIds, openLauncher, captureErrors,
  thread, threadError, replyAfter, openWorldProbe,
} = require('./journey-kit');

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

  const probe = await openWorldProbe(page, env);
  if (!probe) return result(id, BLOCKED, 'no "World probe" card for Acme Corp');
  await probe.typeLine("printf '%s_%s\\n' EVE OK");
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
  { id: 'landing-view', timeoutMs: 30000, areas: ['auth', 'home'], run: landingView },
  { id: 'world-projects-listed', timeoutMs: 45000, areas: ['home', 'projects'], run: worldProjectsListed },
  { id: 'chat-reply', timeoutMs: 150000, areas: ['chat'], run: chatReply },
  { id: 'open-existing-thread', timeoutMs: 75000, areas: ['chat', 'home'], run: openExistingThread },
  { id: 'terminal-on-request', timeoutMs: 75000, areas: ['terminal'], run: terminalOnRequest },
  { id: 'task-created-listed', timeoutMs: 120000, areas: ['tasks'], run: taskCreatedListed },
  { id: 'voice-deep-link', timeoutMs: 60000, areas: ['voice'], run: voiceDeepLink },
  ...require('./journeys-auth').journeys,
];

module.exports = { journeys };
