// The devbox journeys. Each drives eve's real UI as a person would and
// judges a user-visible outcome. Test ids are only click targets and anchors;
// verdicts rest on visible text or visibility. See docs/design-devboxverify.md.
/** @typedef {{ id: string, timeoutMs: number, areas: string[], fixture?: true, screen?: true, knownBug?: string, run(env): Promise<object> }} Journey */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { expect } = require('@playwright/test');
const {
  GREETING, PASS, FAIL, BLOCKED, result, firstLine, sleep, seconds, left, need, poll, pickModel, optionValues,
  openEve, waitForModels, openProject, acmeIds, allWorldIds, addedIds, openLauncher, captureErrors,
  thread, threadError, replyAfter, openWorldProbe,
} = require('./journey-kit');

const exec = promisify(execFile);
const TASK_PROMPT = 'Say hello.';
const EXTERNAL_BANNER = 'This file has been modified externally.';

async function reloadEve(page, env) {
  env.step('reload');
  await page.reload({ timeout: 30000 });
  await need('eve did not finish reloading within 20s', page.waitForFunction(
    () => !!window.client?.state && !!window.client?.wsClient, null, { timeout: 20000 }));
}

// A `verify-<nonce>-<kind>-XXXXXX` folder in Acme Corp's world folder, removed
// by cleanup whatever the verdict. A leftover fails the next world preflight.
async function scratchFolder(env, kind) {
  const root = env.projects.acme.path;
  const prefix = `verify-${env.nonce}-${kind}-`;
  const dir = await fs.promises.mkdtemp(path.join(root, prefix));
  env.cleanup(`remove ${kind} folder`, async () => {
    if (!dir || path.dirname(dir) !== root || !path.basename(dir).startsWith(prefix)) {
      throw new Error('refusing to remove a scratch folder outside Acme Corp');
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// Deliberate: both chords. Monaco binds end-of-file to Cmd+Down on macOS and
// Ctrl+End elsewhere, and each is harmless where it is not bound.
async function endOfFile(page, text) {
  await text.click({ timeout: 5000 });
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('ControlOrMeta+End');
}

// Plumbing only, so no hook of any kind runs, with a neutral identity and a
// scrubbed environment: an inherited GIT_DIR would point at another repo.
async function commitOneFile(dir, name) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
    GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid',
  });
  const git = async (...args) => (await exec('git', ['-C', dir, ...args], { env, timeout: 10000 })).stdout.trim();
  await git('init', '-q', '-b', 'main');
  const blob = await git('hash-object', '-w', '--', name);
  await git('update-index', '--add', '--cacheinfo', `100644,${blob},${name}`);
  const tree = await git('write-tree');
  const commit = await git('commit-tree', '--no-gpg-sign', '-m', 'verify', tree);
  await git('update-ref', 'HEAD', commit);
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
  }, { timeoutMs: 90000, intervalMs: 1000 });
  if (!settled) return failed('no finished assistant reply within 90s');
  if (settled.error) return failed(`error in the thread: ${settled.error}`);
  const took = seconds(sentAt);
  await sleep(500);
  const late = replyAfter(await thread(page), env.nonce);
  if (late.error) return failed(`error in the thread: ${late.error}`);

  const final = addedIds(before, await acmeIds(env, 'sessions'));
  if (final.length !== 1) return result(id, FAIL, `${final.length} new Acme Corp sessions, expected 1`);
  env.shared.thread = { sessionId: final[0], question };
  const said4 = /(^|[^\d])4([^\d]|$)|\bfour\b/i.test(late.reply);

  const marker = `stop ${env.nonce}`;
  env.step('ask for a long count');
  await need('the composer did not come back after the reply', expect(input).toBeEnabled({ timeout: 10000 }));
  await input.fill(`Count from 1 to 400, one number per line. (${marker})`, { timeout: 5000 });
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  await need('the count request is not shown as the user message', expect(
    page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: marker }),
  ).toBeVisible({ timeout: 10000 }));

  env.step('wait for the count to stream');
  const streaming = await poll(async () => {
    const r = replyAfter(await thread(page), marker);
    if (r.error) return r;
    if (!r.reply) return null;
    return { ...r, finished: !(await stop.isVisible()) };
  }, { timeoutMs: 30000, intervalMs: 250 });
  if (!streaming) return failed('no count text within 30s of asking');
  if (streaming.error) return failed(`error in the thread: ${streaming.error}`);
  if (streaming.finished) return result(id, BLOCKED, 'the count finished before Stop could be clicked');

  env.step('click Stop');
  if (!await stop.click({ timeout: 2000 }).then(() => true, () => false)) {
    if (!(await stop.isVisible())) return result(id, BLOCKED, 'the count finished before Stop could be clicked');
    return result(id, FAIL, 'Stop is showing but could not be clicked');
  }
  await need('Stop still showing 5s after it was clicked', expect(stop).toBeHidden({ timeout: 5000 }));
  const atStop = replyAfter(await thread(page), marker).reply.length;
  env.step('watch the reply after Stop');
  await sleep(3000);
  const after = replyAfter(await thread(page), marker);
  if (after.error) return failed(`error in the thread after Stop: ${after.error}`);
  if (after.reply.length !== atStop) return result(id, FAIL, `the reply grew from ${atStop} to ${after.reply.length} characters in the 3s after Stop`);
  if (await stop.isVisible()) return result(id, FAIL, 'Stop came back after it was clicked');
  await need('the composer is not usable after Stop', expect(input).toBeEnabled({ timeout: 5000 }));
  const stopped = addedIds(before, await acmeIds(env, 'sessions'));
  if (stopped.length !== 1) return result(id, FAIL, `${stopped.length} new Acme Corp sessions after Stop, expected 1`);
  return result(id, PASS, `reply in ${took}s, ${said4 ? 'said 4' : `did not say 4: "${late.reply.slice(0, 40)}"`}; Stop ended the count`);
}

async function openExistingThread(env) {
  const id = 'open-existing-thread';
  const t = env.shared.thread;
  if (!t) return result(id, BLOCKED, 'no thread from chat-reply');
  const before = await acmeIds(env, 'sessions');

  // Each door gets a fresh context, so no door rides on another's open tab.
  const doors = [
    ['Sessions tab', async (page) => {
      await openProject(page, env, env.projects.acme);
      env.step('open the Sessions tab');
      await page.getByTestId('panel-tab-sessions').click({ timeout: 10000 });
      env.step('open the thread');
      await need('the thread is not in the Sessions list',
        page.getByTestId(`sidebar-session-${t.sessionId}`).click({ timeout: 15000 }));
      return null;
    }],
    ['Home Continue row', async (page) => {
      env.step('open the thread from Continue');
      await need('the thread is not in Continue on Home',
        page.getByTestId('home-screen').getByTestId(`home-session-${t.sessionId}`).click({ timeout: 15000 }));
      return null;
    }],
    ['⌘K', async (page) => {
      env.step('read the thread\'s title on Home');
      const row = page.getByTestId('home-screen').getByTestId(`home-session-${t.sessionId}`);
      const title = (await need('the thread is not in Continue on Home',
        row.locator('.home__row-title').innerText({ timeout: 15000 }))).trim();
      env.step('open the palette');
      await page.keyboard.press('ControlOrMeta+K');
      const input = page.getByTestId('palette-input');
      await need('⌘K did not open the palette', expect(input).toBeVisible({ timeout: 5000 }));
      await input.fill(title, { timeout: 5000 });
      env.step('pick the first session');
      const list = page.getByTestId('palette-list');
      const at = await poll(async () => {
        const i = await list.evaluate((el) => {
          let group = null;
          let n = -1;
          for (const child of el.children) {
            if (child.classList.contains('palette__section')) {
              group = child.textContent;
            } else if (child.dataset.testid === 'palette-item') {
              n += 1;
              if (group === 'Sessions') return n;
            }
          }
          return -1;
        });
        return i >= 0 ? { i } : null;
      }, { timeoutMs: 5000 });
      if (!at) return `no Sessions item for "${title}"`;
      for (let k = 0; k < at.i; k++) await page.keyboard.press('ArrowDown');
      const item = list.getByTestId('palette-item').nth(at.i);
      await need('the first session is not selected', expect(item).toHaveAttribute('aria-selected', 'true', { timeout: 2000 }));
      const label = (await item.locator('.palette__item-label').innerText({ timeout: 2000 })).trim();
      if (label !== title) return `the first Sessions item is "${label}", not "${title}"`;
      await page.keyboard.press('Enter');
      return null;
    }],
  ];

  for (const [door, open] of doors) {
    const page = await env.newPage();
    await openEve(page, env);
    let problem;
    try {
      problem = await open(page);
    } catch (err) {
      problem = firstLine(err);
    }
    if (problem) return result(id, FAIL, `${door}: ${problem}`);

    env.step(`wait for the history (${door})`);
    const seen = await poll(async () => {
      const r = replyAfter(await thread(page), t.question);
      return r.asked && r.reply ? r : null;
    }, { timeoutMs: 20000, intervalMs: 1000 });
    if (!seen) {
      const r = replyAfter(await thread(page), t.question);
      return result(id, FAIL, `${door}: ${r.asked ? 'the question shows but no reply after it' : 'the question is not in the pane'}`);
    }
    const added = addedIds(before, await acmeIds(env, 'sessions'));
    if (added.length) return result(id, FAIL, `${door}: opening the thread created ${added.length} session(s)`);
  }
  return result(id, PASS, 'question and reply shown from the Sessions tab, Continue and ⌘K; no new session');
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

  const tookOk = seconds(typedAt);

  await reloadEve(page, env);
  env.step('wait for the terminal to come back');
  await need('the terminal pane did not come back within 15s of a reload', expect(pane).toBeVisible({ timeout: 15000 }));
  await need('EVE_OK is not in the terminal 15s after a reload', expect(pane).toContainText('EVE_OK', { timeout: 15000 }));
  await probe.typeLine("printf '%s_%s\\n' EVE AGAIN");
  await need('EVE_AGAIN did not show within 10s of typing after a reload',
    expect(pane).toContainText('EVE_AGAIN', { timeout: 10000 }));

  const added = addedIds(before, await acmeIds(env, 'terminals'));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new Acme Corp terminals, expected 1`);
  return result(id, PASS, `EVE_OK in ${tookOk}s; after a reload the same terminal answered EVE_AGAIN`);
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
  await dialog.locator('[name="taskPrompt"]').fill(TASK_PROMPT, { timeout: 5000 });
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

  const openTasks = async (on) => {
    await openProject(on, env, env.projects.acme);
    await on.getByTestId('panel-tab-tasks').click({ timeout: 10000 });
    const item = on.locator('#panelContent [data-testid^="sidebar-task-"]')
      .filter({ has: on.locator('.project-tree__task-name').getByText(name, { exact: true }) });
    await need(`${name} is gone after a reload`, expect(item).toBeVisible({ timeout: 15000 }));
    return item;
  };
  await reloadEve(page, env);
  const row = await openTasks(page);

  env.step('Run Now');
  await row.getByTitle('Run Now').click({ timeout: 5000 });
  env.step('wait for the run\'s reply');
  const stop = page.getByTestId('chat-stop');
  const ran = await poll(async () => {
    const r = runReply(await thread(page).catch(() => []));
    if (r.error) return r;
    return r.reply && !(await stop.isVisible()) ? r : null;
  }, { timeoutMs: 60000, intervalMs: 1000 });
  if (!ran) return result(id, FAIL, 'no reply from the run within 60s of Run Now');
  if (ran.error) return result(id, FAIL, `error in the run: ${ran.error}`);

  // Deliberate: a fresh context, not a reload. A reload restores the run's
  // open tab, which would show the reply without the row ever being clicked.
  const later = await env.newPage();
  await openEve(later, env);
  const again = await openTasks(later);
  env.step('open the last run');
  await again.locator('.project-tree__task-name').click({ timeout: 5000 });
  // Only the start is compared: a reply re-rendered from history can wrap or
  // trim differently from the one that streamed in.
  const opening = ran.reply.replace(/\s+/g, ' ').slice(0, 30);
  const reread = await poll(async () => {
    const r = runReply(await thread(later).catch(() => []));
    return r.reply.replace(/\s+/g, ' ').includes(opening) ? r : null;
  }, { timeoutMs: 15000, intervalMs: 1000 });
  if (!reread) return result(id, FAIL, 'the last run does not show the run\'s reply in a new page');
  return result(id, PASS, `${name} listed after a reload; Run Now replied and its last run shows the reply`);
}

// The run's reply: what follows the task prompt, or every assistant turn when
// the run's thread does not show the prompt as a user message.
function runReply(messages) {
  const r = replyAfter(messages, TASK_PROMPT);
  if (r.asked) return r;
  const reply = messages.filter((m) => m.who === 'message-assistant' && m.text).map((m) => m.text).join('\n').trim();
  return { asked: false, reply, error: threadError(messages) };
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

async function changesDiff(env) {
  const id = 'changes-diff';
  env.step('set up a repo with one modified file');
  const dir = await scratchFolder(env, 'git');
  const repo = path.basename(dir);
  const file = path.join(dir, 'notes.md');
  await fs.promises.writeFile(file, 'status: draft\n');
  await commitOneFile(dir, 'notes.md');
  const shipped = `status: shipped ${env.nonce}`;
  await fs.promises.writeFile(file, `${shipped}\n`);

  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, env.projects.acme);
  env.step('open the Changes tab');
  await page.getByTestId('panel-tab-changes').click({ timeout: 10000 });
  const panel = page.getByTestId('changes-panel');
  await need(`the Changes tab does not list ${repo} within 15s`,
    expect(panel.getByTestId(`changes-repo-/${repo}`)).toContainText(repo, { timeout: 15000 }));
  const row = panel.getByTestId(`changes-file-/${repo}:notes.md`);
  await need('notes.md is not listed under the repo', expect(row).toContainText('notes.md', { timeout: 15000 }));
  await need('notes.md is not marked modified', expect(row.locator('.changes-panel__status')).toHaveText('M', { timeout: 5000 }));

  env.step('open the diff');
  await row.click({ timeout: 5000 });
  const pane = page.getByTestId('diff-pane');
  await need('no diff pane within 10s of clicking notes.md', expect(pane).toBeVisible({ timeout: 10000 }));
  await need('the diff pane does not name notes.md', expect(pane.getByTestId('diff-name')).toHaveText('notes.md', { timeout: 10000 }));
  const editor = pane.getByTestId('diff-editor');
  await need('the diff does not show the committed line', expect(editor).toContainText('status: draft', { timeout: 10000 }));
  await need('the diff does not show the changed line', expect(editor).toContainText(shipped, { timeout: 10000 }));
  return result(id, PASS, 'Changes listed the modified notes.md; its diff shows both lines');
}

async function fileEditSave(env) {
  const id = 'file-edit-save';
  env.step('set up a notes file');
  const dir = await scratchFolder(env, 'files');
  const folder = `/${path.basename(dir)}`;
  const file = path.join(dir, 'notes.md');
  await fs.promises.writeFile(file, '# Notes\nfirst line\n');
  // The harness writes as another program would; a line always starts on a
  // fresh one, whatever the editor left at the end.
  const appendLine = async (line) => {
    const now = await fs.promises.readFile(file, 'utf8');
    await fs.promises.appendFile(file, `${now.endsWith('\n') ? '' : '\n'}${line}\n`);
  };

  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, env.projects.acme);
  env.step('open the Files tab');
  await page.getByTestId('panel-tab-files').click({ timeout: 10000 });
  for (const entry of ['todo.txt', 'budget']) {
    await need(`the Files tab does not show ${entry}`,
      expect(page.getByTestId(`file-tree-item-/${entry}`)).toContainText(entry, { timeout: 15000 }));
  }
  env.step('open notes.md');
  await page.getByTestId(`file-tree-item-${folder}`).click({ timeout: 10000 });
  await page.getByTestId(`file-tree-item-${folder}/notes.md`).click({ timeout: 10000 });
  const text = page.locator('#monacoEditor .view-lines');
  await need('notes.md did not open with "first line" within 15s', expect(text).toContainText('first line', { timeout: 15000 }));

  env.step('edit and save');
  const saved = `saved ${env.nonce}`;
  await endOfFile(page, text);
  await page.keyboard.type(saved);
  await page.keyboard.press('ControlOrMeta+S');
  const onDisk = await poll(async () => (await fs.promises.readFile(file, 'utf8')).includes(saved), { timeoutMs: 5000, intervalMs: 250 });
  if (!onDisk) return result(id, FAIL, 'the saved line is not on disk 5s after ⌘S');

  env.step('change the file outside the editor');
  const banner = page.getByText(EXTERNAL_BANNER);
  const outside1 = `outside-1 ${env.nonce}`;
  await appendLine(outside1);
  await need('the saved editor did not pick up an outside change within 10s', expect(text).toContainText(outside1, { timeout: 10000 }));
  if (await banner.isVisible()) return result(id, FAIL, 'a saved editor showed the modified-externally banner');

  env.step('change it again under an unsaved edit');
  await endOfFile(page, text);
  await page.keyboard.type(' draft');
  const outside2 = `outside-2 ${env.nonce}`;
  await appendLine(outside2);
  await need('no modified-externally banner within 10s of an outside change under an unsaved edit',
    expect(banner).toBeVisible({ timeout: 10000 }));
  env.step('reload from disk');
  await page.locator('.external-change-bar').getByRole('button', { name: 'Reload' }).click({ timeout: 5000 });
  await need('Reload did not bring in the outside change', expect(text).toContainText(outside2, { timeout: 10000 }));
  await need('the banner is still showing after Reload', expect(banner).toBeHidden({ timeout: 5000 }));
  return result(id, PASS, 'saved to disk; a clean editor took an outside change; a dirty one asked and reloaded');
}

const journeys = [
  { id: 'landing-view', timeoutMs: 30000, areas: ['auth', 'home'], run: landingView },
  { id: 'world-projects-listed', timeoutMs: 45000, areas: ['home', 'projects'], run: worldProjectsListed },
  { id: 'chat-reply', timeoutMs: 150000, areas: ['chat'], run: chatReply },
  { id: 'open-existing-thread', timeoutMs: 75000, areas: ['chat', 'home'], run: openExistingThread },
  { id: 'terminal-on-request', timeoutMs: 75000, areas: ['terminal'], run: terminalOnRequest },
  { id: 'task-created-listed', timeoutMs: 120000, areas: ['tasks'], run: taskCreatedListed },
  { id: 'voice-deep-link', timeoutMs: 60000, areas: ['voice'], run: voiceDeepLink },
  { id: 'changes-diff', timeoutMs: 60000, areas: ['git'], run: changesDiff },
  { id: 'file-edit-save', timeoutMs: 75000, areas: ['files'], run: fileEditSave },
  ...require('./journeys-auth').journeys,
];

module.exports = { journeys };
