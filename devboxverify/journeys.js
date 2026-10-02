// The devbox journeys. Each drives eve's real UI as a person would and
// judges a user-visible outcome. Test ids are only click targets and anchors;
// verdicts rest on visible text or visibility. See docs/design-devboxverify.md.
/** @typedef {{ id: string, timeoutMs: number, areas: string[], needs: string[], fixture?: true, screen?: true, knownBug?: string, run(env): Promise<object> }} Journey */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify, isDeepStrictEqual } = require('util');
const { expect } = require('@playwright/test');
const {
  GREETING, PASS, FAIL, BLOCKED, result, firstLine, sleep, seconds, left, need, poll, pickModel, optionValues,
  openEve, waitForModels, openProject, openProjectPage, acmeIds, allWorldIds, addedIds, openLauncher, captureErrors,
  thread, threadError, replyAfter, openWorldProbe, eveJson, callToolRows, DEVICES, sweep, overflow,
  worldIds, DENIED_OUTCOMES, BRIEF_REFUSED, briefRunVerdict, probeVerdict,
} = require('./journey-kit');

const exec = promisify(execFile);
const TASK_PROMPT = 'Say hello.';
const EXTERNAL_BANNER = 'This file has been modified externally.';
// Deliberate: longer than file-watcher.js's SELF_WRITE_TTL_MS. eve drops any
// change to a file within that window of its own save, taking it for the echo.
const SELF_WRITE_WINDOW_MS = 1500;

async function reloadEve(page, env) {
  env.step('reload');
  await page.reload({ timeout: 30000 });
  await need('eve did not finish reloading within 20s', page.waitForFunction(
    () => !!window.client?.state && !!window.client?.wsClient, null, { timeout: 20000 }));
}

// A `verify-<nonce>-<kind>-XXXXXX` folder in Acme Corp's world folder, removed
// by cleanup whatever the verdict. A leftover fails the next world preflight.
async function scratchFolder(env, kind) {
  const acme = env.world.projects.acme;
  const root = path.resolve(acme.path);
  const prefix = `verify-${env.nonce}-${kind}-`;
  const dir = await fs.promises.mkdtemp(path.join(root, prefix));
  env.cleanup(`remove ${kind} folder`, async () => {
    if (!dir || path.dirname(dir) !== root || !path.basename(dir).startsWith(prefix)) {
      throw new Error(`refusing to remove a scratch folder outside ${acme.name}`);
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
  const { acme, globex, home: homeProject } = env.world.projects;
  const page = await env.newPage();
  await openEve(page, env);
  env.step('wait for the home screen');
  const home = page.getByTestId('home-screen');
  await need('no greeting within 20s', expect(home.getByText(GREETING)).toBeVisible({ timeout: 20000 }));
  const rail = page.getByRole('navigation', { name: 'Projects' });
  const found = (check) => check.then(() => true, () => false);

  // Shown projects first (they also prove the view has settled), then each
  // hidden one must stay absent for a settle period, not just one instant.
  const check = async (mode, shown, hidden) => {
    const problems = [];
    for (const project of shown) {
      env.step(`look for ${project.name} in ${mode}`);
      const chip = home.getByTestId(`home-project-${project.id}`);
      if (!await found(expect(chip).toContainText(project.name, { timeout: 5000 }))) problems.push(`${mode}: home chip "${project.name}" missing`);
      if (!await found(expect(rail.getByTitle(project.name, { exact: true })).toBeVisible({ timeout: 5000 }))) {
        problems.push(`${mode}: rail entry "${project.name}" missing`);
      }
    }
    for (const project of hidden) {
      env.step(`confirm ${project.name} is absent in ${mode}`);
      if (!await found(expect(home.getByTestId(`home-project-${project.id}`)).toHaveCount(0, { timeout: 3000 }))) {
        problems.push(`${mode}: home chip "${project.name}" is shown`);
      }
      if (!await found(expect(rail.getByTitle(project.name, { exact: true })).toHaveCount(0, { timeout: 3000 }))) {
        problems.push(`${mode}: rail entry "${project.name}" is shown`);
      }
    }
    return problems;
  };
  const switchTo = async (mode) => {
    env.step(`switch to ${mode}`);
    await page.getByTestId(`mode-${mode}`).click({ timeout: 10000 });
    await need(`the ${mode} switch did not take`,
      expect(page.getByTestId(`mode-${mode}`)).toHaveAttribute('aria-checked', 'true', { timeout: 5000 }));
  };

  let problems;
  try {
    await need('eve did not open in Work',
      expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 }));
    problems = await check('Work', [acme, globex], [homeProject]);
    await switchTo('home');
    problems.push(...await check('Home', [homeProject], [acme, globex]));
  } finally {
    // The mode persists in localStorage (eve-mode); later journeys start in Work.
    await switchTo('work').catch(() => {});
  }
  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `Work: ${acme.name} and ${globex.name} on Home and in the rail, ${homeProject.name} in neither; `
    + `Home: ${homeProject.name} on Home and in the rail, ${acme.name} and ${globex.name} in neither; back in Work`);
}

async function chatReply(env) {
  const id = 'chat-reply';
  const acme = env.world.projects.acme;
  const page = await env.newPage();
  const errors = captureErrors(page);
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, acme);
  const before = await acmeIds(env, 'sessions');

  const dialog = await openLauncher(page, env);
  env.step('open the Web Chat form');
  await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 });
  const select = dialog.getByTestId('launcher-model-select');
  const model = pickModel(await optionValues(select), env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);
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
  if (!created) return failed(`no ${acme.name} session within 30s of Start Chat`);
  if (created.error) return failed(`error in the thread: ${created.error}`);
  const added = addedIds(before, await acmeIds(env, 'sessions'));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new ${acme.name} sessions, expected 1`);

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
  if (final.length !== 1) return result(id, FAIL, `${final.length} new ${acme.name} sessions, expected 1`);
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
  // The count, not a thinking model's "Thinking..." summary that precedes it.
  const streaming = await poll(async () => {
    const r = replyAfter(await answers(page), marker);
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
  if (stopped.length !== 1) return result(id, FAIL, `${stopped.length} new ${acme.name} sessions after Stop, expected 1`);
  return result(id, PASS, `reply in ${took}s, ${said4 ? 'said 4' : `did not say 4: "${late.reply.slice(0, 40)}"`}; Stop ended the count`);
}

async function openExistingThread(env) {
  const id = 'open-existing-thread';
  const acme = env.world.projects.acme;
  const t = env.shared.thread;
  if (!t) return result(id, BLOCKED, 'no thread from chat-reply');
  const before = await acmeIds(env, 'sessions');

  // Each door gets a fresh context, so no door rides on another's open tab.
  const doors = [
    ['Project page', async (page) => {
      const projectPage = await openProjectPage(page, env, acme);
      env.step('open the thread');
      await need('the thread is not in the project page\'s Threads',
        projectPage.getByTestId(`project-thread-${t.sessionId}`).click({ timeout: 15000 }));
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
      await page.keyboard.press('ControlOrMeta+k');
      const input = page.getByTestId('palette-input');
      await need('⌘K did not open the palette', expect(input).toBeVisible({ timeout: 5000 }));
      // The title alone is not unique ("Chat" names every web chat), so the
      // user narrows it by project; the palette matches label and project.
      await input.fill(`${title} ${acme.name}`, { timeout: 5000 });
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
      const sub = (await item.locator('.palette__item-sub').innerText({ timeout: 2000 }).catch(() => '')).trim();
      if (label !== title || sub !== acme.name) {
        return `the first Sessions item is "${label}" in "${sub}", not "${title}" in ${acme.name}`;
      }
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
  return result(id, PASS, 'question and reply shown from the Project page, Continue and ⌘K; no new session');
}

async function terminalOnRequest(env) {
  const id = 'terminal-on-request';
  const acme = env.world.projects.acme;
  const worldBefore = await allWorldIds(env, 'terminals');
  const before = await acmeIds(env, 'terminals');
  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, acme);
  env.step('settle before asking');
  await sleep(3000);
  const pane = page.locator('#terminal');
  const unasked = addedIds(worldBefore, await allWorldIds(env, 'terminals'));
  if (unasked.length || await pane.isVisible()) {
    return result(id, FAIL, 'a terminal opened without being asked');
  }

  const probe = await openWorldProbe(page, env);
  if (!probe) return result(id, BLOCKED, `no "World probe" card for ${acme.name}`);
  await probe.typeLine("printf '%s_%s\\n' EVE OK");
  const typedAt = Date.now();
  await need('EVE_OK did not show in the terminal within 20s',
    expect(pane).toContainText('EVE_OK', { timeout: 20000 }));

  const tookOk = seconds(typedAt);

  await reloadEve(page, env);
  // Nothing may reopen by itself: poll for a settle period, not one instant.
  env.step('settle after the reload');
  const reopened = await poll(async () => (await pane.isVisible() ? { shown: true } : null), { timeoutMs: 5000, intervalMs: 500 });
  if (reopened) return result(id, FAIL, 'a terminal opened by itself after a reload');
  await need('Home is not showing after a reload', expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 10000 }));

  env.step('find the probe on Today\'s agent board');
  const row = page.getByTestId('today-part-agents').getByTestId(`today-agent-${probe.terminalId}`);
  await need('the live terminal is not on Today\'s agent board within 15s of a reload',
    expect(row).toBeVisible({ timeout: 15000 }));
  const lastLine = row.locator('.agent-row__last');
  await need('the probe\'s row on Today shows no last line within 15s',
    expect(lastLine).toHaveText(/\S/, { timeout: 15000 }));
  const line = (await lastLine.innerText({ timeout: 5000 })).trim();
  if (await pane.isVisible()) return result(id, FAIL, 'a terminal pane opened while the board only listed it');

  // Deliberate: a fresh context, so the first stays on Today for the tap.
  const other = await env.newPage();
  await openEve(other, env);
  const projectPage = await openProjectPage(other, env, acme);
  env.step('find the probe in the project page\'s Agents');
  await need('the live terminal is not in the project page\'s Agents within 15s',
    expect(projectPage.getByTestId(`project-agent-${probe.terminalId}`)).toBeVisible({ timeout: 15000 }));

  env.step('open the probe from Today');
  await row.click({ timeout: 5000 });
  await need('the terminal pane did not open on a tap within 15s', expect(pane).toBeVisible({ timeout: 15000 }));
  await need('EVE_OK is not in the terminal 15s after opening it from Today',
    expect(pane).toContainText('EVE_OK', { timeout: 15000 }));
  await probe.typeLine("printf '%s_%s\\n' EVE AGAIN");
  await need('EVE_AGAIN did not show within 10s of typing after a reload',
    expect(pane).toContainText('EVE_AGAIN', { timeout: 10000 }));

  const added = addedIds(before, await acmeIds(env, 'terminals'));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new ${acme.name} terminals, expected 1`);
  return result(id, PASS, `EVE_OK in ${tookOk}s; after a reload no terminal opened by itself, Today's agent board `
    + `listed it with the last line "${line.slice(0, 60)}" and no pane, the project page listed it, and a tap opened it and answered EVE_AGAIN`);
}

async function taskCreatedListed(env) {
  const id = 'task-created-listed';
  const acme = env.world.projects.acme;
  const name = `verify-${env.nonce}`;
  const before = await acmeIds(env, 'tasks');
  const page = await env.newPage();
  await openEve(page, env);
  const projectPage = await openProjectPage(page, env, acme);

  env.step('open New Task on the project page');
  await projectPage.getByTestId(`project-task-new-${acme.id}`).click({ timeout: 10000 });
  const dialog = page.getByTestId('dialog-task-dialog');
  await need('the task dialog did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
  await dialog.getByRole('button', { name: 'New', exact: true }).click({ timeout: 5000 });

  env.step('fill the task form');
  await dialog.locator('[name="taskName"]').fill(name, { timeout: 5000 });
  await dialog.getByTestId('task-dialog-advanced').locator('summary').click({ timeout: 5000 });
  await dialog.locator('[name="taskType"]').selectOption({ label: 'Chat (LLM)' }, { timeout: 5000 });
  await dialog.locator('[name="taskPrompt"]').fill(TASK_PROMPT, { timeout: 5000 });
  const select = dialog.locator('[name="taskModel"]');
  const values = await poll(async () => {
    const v = await optionValues(select);
    return v.length ? v : null;
  }, { timeoutMs: 20000 }) || [];
  const model = pickModel(values, env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name} tasks`);
  await select.selectOption(model, { timeout: 5000 });
  await dialog.locator('[name="scheduleType"]').selectOption({ label: 'On demand' }, { timeout: 5000 });

  env.step('create the task');
  await dialog.getByRole('button', { name: 'Create routine' }).click({ timeout: 5000 });
  const listed = projectPage.getByText(name, { exact: true });
  const shown = await expect(listed).toBeVisible({ timeout: 15000 }).then(() => true, () => false);
  if (!shown) {
    const toasts = await page.locator('.toast__message').allInnerTexts();
    return result(id, FAIL, toasts.length ? `not listed; toast: ${toasts.join(' / ')}` : 'not listed after Create routine');
  }
  const created = addedIds(before, await acmeIds(env, 'tasks'));
  if (created.length !== 1) return result(id, FAIL, `${created.length} new ${acme.name} tasks, expected 1`);

  const routines = await env.newPage();
  await openEve(routines, env, '#routines');
  env.step('find it on #routines');
  const routineRow = routines.getByTestId(`routine-${created[0]}`);
  await need(`${name} is not listed on #routines`, expect(routineRow).toContainText(name, { timeout: 15000 }));
  await need(`${name} does not read "When I ask" on #routines`,
    expect(routineRow.locator('.routine-row__sentence')).toHaveText('When I ask', { timeout: 5000 }));

  const openTasks = async (on) => {
    const onPage = await openProjectPage(on, env, acme);
    const item = onPage.getByTestId(`project-task-${created[0]}`).filter({ hasText: name });
    await need(`${name} is gone after a reload`, expect(item).toBeVisible({ timeout: 15000 }));
    return item;
  };
  await reloadEve(page, env);
  const row = await openTasks(page);

  env.step('Run Now');
  await row.getByTitle('Run Now').click({ timeout: 5000 });
  env.step('wait for the run\'s reply');
  // A run's pane shows no Stop, so a settled reply is one that stopped growing.
  let last = '';
  const ran = await poll(async () => {
    const r = runReply(await answers(page).catch(() => []));
    if (r.error) return r;
    const settledReply = r.reply && r.reply === last;
    last = r.reply;
    return settledReply ? r : null;
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
    const r = runReply(await answers(later).catch(() => []));
    return r.reply.replace(/\s+/g, ' ').includes(opening) ? r : null;
  }, { timeoutMs: 15000, intervalMs: 1000 });
  if (!reread) return result(id, FAIL, 'the last run does not show the run\'s reply in a new page');
  return result(id, PASS, `${name} listed after a reload and on #routines as "When I ask"; Run Now replied and its last run shows the reply`);
}

// The thread without its folded thinking. A thinking model's reply opens with
// a think block whose summary reads "Thinking..." while it streams and
// "Thinking" once re-rendered, so it is no part of the reply a user reads.
async function answers(page) {
  return page.getByTestId('messages-container').evaluate((root) =>
    [...root.children].filter((el) => el.offsetParent !== null).map((el) => {
      const content = el.querySelector('.message-content');
      let text = content?.innerText || '';
      for (const block of content ? content.querySelectorAll('.think-block') : []) text = text.replace(block.innerText, '');
      return { who: el.dataset.testid || '', text: text.trim(), error: el.classList.contains('error') };
    }), null, { timeout: 10000 });
}

// The run's reply: what follows the task prompt, or every assistant turn when
// the run's thread does not show the prompt as a user message.
function runReply(messages) {
  const r = replyAfter(messages, TASK_PROMPT);
  if (r.asked) return r;
  const reply = messages.filter((m) => m.who === 'message-assistant' && m.text).map((m) => m.text).join('\n').trim();
  return { asked: false, reply, error: threadError(messages) };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const capitalised = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const hhmm = (ms) => [new Date(ms).getHours(), new Date(ms).getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whatever the verdict, every task made in Acme Corp since `before` is
// deleted, so a scheduled routine never fires on the devbox.
function removeNewTasks(env, before) {
  env.cleanup('delete the routine', async () => {
    for (const taskId of addedIds(before, await acmeIds(env, 'tasks'))) {
      await eveJson(env, 'DELETE', `/api/tasks/${encodeURIComponent(taskId)}`);
    }
  });
}

async function routineFromThread(env) {
  const id = 'routine-from-thread';
  const acme = env.world.projects.acme;
  const page = await env.newPage();
  const errors = captureErrors(page);
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, acme);
  const sessionsBefore = await acmeIds(env, 'sessions');
  const tasksBefore = await acmeIds(env, 'tasks');
  removeNewTasks(env, tasksBefore);

  const dialog = await openLauncher(page, env);
  env.step('open the Web Chat form');
  await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 });
  const select = dialog.getByTestId('launcher-model-select');
  const model = pickModel(await optionValues(select), env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);
  await select.selectOption(model, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  const started = await poll(async () => addedIds(sessionsBefore, await acmeIds(env, 'sessions')).length > 0,
    { timeoutMs: 30000, intervalMs: 1000 });
  if (!started) {
    const refusal = errors.find((e) => /template "chat"/.test(e));
    return refusal ? result(id, BLOCKED, `launch refused: ${refusal}`) : result(id, FAIL, `no ${acme.name} session within 30s of Start Chat`);
  }

  const prompt = `Reply with the word ready. (verify ${env.nonce} routine)`;
  const input = page.getByTestId('chat-input');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  await input.fill(prompt, { timeout: 5000 });
  env.step('send the prompt');
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  env.step('wait for the reply');
  const stop = page.getByTestId('chat-stop');
  const settled = await poll(async () => {
    const r = replyAfter(await answers(page), env.nonce);
    return r.error || (r.reply && !(await stop.isVisible())) ? r : null;
  }, { timeoutMs: 60000, intervalMs: 1000 });
  if (!settled) return result(id, FAIL, 'no finished assistant reply within 60s');
  if (settled.error) return result(id, FAIL, `error in the thread: ${settled.error}`);

  env.step('Make this a routine');
  await page.getByTestId('thread-make-routine').click({ timeout: 10000 });
  const panel = page.getByTestId('routine-panel');
  await need('Make this a routine opened no panel', expect(panel).toBeVisible({ timeout: 10000 }));
  // Tomorrow, so the routine can't come due while the journey runs.
  const day = WEEKDAYS[new Date(Date.now() + 86400000).getDay()];
  const sentence = `Every ${capitalised(day)} at 08:00`;
  env.step(`choose ${sentence}`);
  await panel.getByTestId('routine-panel-when-weekly').click({ timeout: 5000 });
  await panel.getByTestId('routine-panel-day').selectOption({ label: capitalised(day) }, { timeout: 5000 });
  await panel.getByTestId('routine-panel-time').fill('08:00', { timeout: 5000 });
  const label = (await panel.getByTestId('routine-panel-model').evaluate((s) => s.selectedOptions[0]?.textContent || '')).trim();
  const readback = `${sentence}, in ${acme.name}, using ${label}.`;
  await need(`the read-back is not "${readback}"`, expect(panel.getByTestId('routine-panel-sentence')).toHaveText(readback, { timeout: 5000 }));

  env.step('Create routine');
  await panel.getByTestId('routine-panel-create').click({ timeout: 5000 });
  const made = await poll(async () => addedIds(tasksBefore, await acmeIds(env, 'tasks')).length > 0, { timeoutMs: 15000, intervalMs: 1000 });
  if (!made) {
    const toasts = await page.locator('.toast__message').allInnerTexts();
    return result(id, FAIL, `no new ${acme.name} routine within 15s of Create routine${toasts.length ? `; toast: ${toasts.join(' / ')}` : ''}`);
  }
  await need('the panel is still open after Create routine', expect(panel).toBeHidden({ timeout: 10000 }));
  // A settle period, so a second create or a run started by the create shows.
  await sleep(3000);
  const added = addedIds(tasksBefore, await acmeIds(env, 'tasks'));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new ${acme.name} routines, expected 1`);
  const own = await eveJson(env, 'GET', `/api/tasks?projectId=${encodeURIComponent(acme.id)}`);
  const task = (own || []).find((t) => t.id === added[0]);
  if (!task) return result(id, FAIL, `the new routine is not among ${acme.name}'s at the scheduler`);
  const s = task.schedule || {};
  const problems = [];
  if (s.type !== 'weekly' || s.day !== day || s.time !== '08:00') problems.push(`schedule ${JSON.stringify(task.schedule)}, want weekly ${day} 08:00`);
  if (task.prompt !== prompt) problems.push(`prompt "${String(task.prompt).slice(0, 60)}", want the thread's first message`);
  if (task.model !== model) problems.push(`model ${task.model}, want the thread's ${model}`);
  if (task.enabled !== true) problems.push('not enabled');
  if (task.lastRun || task.lastStatus) problems.push(`a run started (${task.lastStatus || task.lastRun})`);
  const sessions = addedIds(sessionsBefore, await acmeIds(env, 'sessions'));
  if (sessions.length !== 1) problems.push(`${sessions.length} new ${acme.name} sessions, expected the thread's alone`);
  if (problems.length) return result(id, FAIL, problems.join('; '));

  const later = await env.newPage();
  await openEve(later, env, '#routines');
  env.step('find the routine on #routines');
  const row = later.getByTestId(`routine-${task.id}`);
  await need('the routine is not listed on #routines', expect(row).toBeVisible({ timeout: 15000 }));
  await need(`the #routines row does not read "${sentence}" like the read-back`,
    expect(row.locator('.routine-row__sentence')).toHaveText(sentence, { timeout: 5000 }));
  await need('the #routines row does not read "never ran"', expect(row.locator('.routine-row__result')).toHaveText('never ran', { timeout: 5000 }));
  return result(id, PASS, `read-back "${readback}"; one weekly ${day} 08:00 ${acme.name} routine with the thread's prompt and model; `
    + '#routines reads the same sentence and "never ran"');
}

// relay's deterministic pair, as its tool-call-audited journey uses them.
const ALLOWED_TOOL = 'mail_list_accounts';
const DENIED_TOOL = 'contacts_list';
const AUDIT_FIELDS = ['ts', 'tool', 'outcome', 'allowed'];

async function routineTouched(env) {
  const id = 'routine-touched';
  const acme = env.world.projects.acme;
  const startedAt = Date.now();
  const page = await env.newPage();
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, acme);
  const probe = await openWorldProbe(page, env);
  if (!probe) return result(id, BLOCKED, `no "World probe" card for ${acme.name}`);
  env.cleanup('close the World probe terminal', () => env.api.closeTerminal(probe.terminalId));
  const bin = `'${env.relayBin.replace(/'/g, "'\\''")}'`;
  await probe.typeLine([ALLOWED_TOOL, DENIED_TOOL].map((tool) => `${bin} mcp call --tool ${tool} --args '{}'`).join('; '));

  env.step('read relay audit');
  const relayRows = async () => {
    const args = ['audit', '--event', 'call_tool', '--project', acme.id, '--json', '--tail', '20'];
    const { stdout } = await exec(env.relayBin, args, { timeout: 10000 });
    return callToolRows(stdout, { projectId: acme.id, sinceMs: startedAt });
  };
  const audited = await poll(async () => {
    const rows = await relayRows().catch(() => []);
    const one = (tool) => rows.filter((r) => r.tool === tool);
    const [ok, no] = [one(ALLOWED_TOOL), one(DENIED_TOOL)];
    return ok.length === 1 && ok[0].outcome === 'ok' && no.length === 1 && DENIED_OUTCOMES.includes(no[0].outcome) ? rows : null;
  }, { timeoutMs: 15000, intervalMs: 1000 });
  if (!audited) return result(id, BLOCKED, `relay audit shows no ${ALLOWED_TOOL} ok / ${DENIED_TOOL} denied pair from ${acme.name}`);
  // Deliberate: a live terminal comes back as the active tab in a new page.
  await env.api.closeTerminal(probe.terminalId);

  const values = await page.evaluate((pid) => window.client.state.modelsForProject(pid).map((m) => m.value), acme.id);
  const model = pickModel(values, env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);
  const tasksBefore = await acmeIds(env, 'tasks');
  removeNewTasks(env, tasksBefore);
  env.step('create an on-demand routine');
  await eveJson(env, 'POST', '/api/tasks', {
    name: `verify-${env.nonce}-touched`, projectId: acme.id, prompt: TASK_PROMPT, model,
    schedule: { type: 'on_demand' }, enabled: true, sessionType: 'headless', catchUp: false,
  });
  const made = addedIds(tasksBefore, await acmeIds(env, 'tasks'));
  if (made.length !== 1) return result(id, BLOCKED, `${made.length} new ${acme.name} routines after POST /api/tasks, expected 1`);

  env.step('read eve\'s audit route');
  const body = await eveJson(env, 'GET', `/api/projects/${encodeURIComponent(acme.id)}/audit`);
  if (!body || body.recording !== true || !Array.isArray(body.records)) {
    return result(id, FAIL, `eve's audit route answered ${JSON.stringify(body).slice(0, 80)}`);
  }
  const extra = [...new Set(body.records.flatMap((r) => Object.keys(r).filter((k) => !AUDIT_FIELDS.includes(k))))];
  if (extra.length) return result(id, FAIL, `eve's audit route sends ${extra.join(', ')} to the browser`);

  const sheetPage = await env.newPage();
  await openEve(sheetPage, env, '#routines');
  env.step('open the routine sheet');
  await need('the routine is not listed on #routines', sheetPage.getByTestId(`routine-${made[0]}`).click({ timeout: 15000 }));
  const sheet = sheetPage.getByTestId(`routine-sheet-${made[0]}`);
  await need('the routine sheet did not open', expect(sheet).toBeVisible({ timeout: 10000 }));
  const audit = sheet.getByTestId('routine-sheet-audit');
  // relay's rows, newest first, as the sheet lists them. A run that crosses
  // midnight reads the time as "yesterday HH:MM".
  const want = [...audited].reverse().map((r) => new RegExp(`^(?:yesterday )?${hhmm(r.ts)} · ${escapeRe(r.tool)} · `
    + `${DENIED_OUTCOMES.includes(r.outcome) ? 'denied' : 'allowed'}$`));
  env.step('wait for the tool calls');
  const shown = await poll(async () => {
    const texts = (await audit.getByTestId('routine-audit-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    return texts.length >= want.length ? texts : null;
  }, { timeoutMs: 10000, intervalMs: 500 });
  if (!shown) {
    const said = (await audit.innerText({ timeout: 2000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    return result(id, FAIL, `the sheet listed fewer than ${want.length} tool calls within 10s${said ? `; it says "${said.slice(0, 80)}"` : ''}`);
  }
  const top = shown.slice(0, want.length);
  if (!want.every((re, i) => re.test(top[i]))) {
    return result(id, FAIL, `the sheet's newest rows read "${top.join(' / ')}"; relay audit has `
      + `${[...audited].reverse().map((r) => `${hhmm(r.ts)} ${r.tool} ${r.outcome}`).join(' / ')}`);
  }
  return result(id, PASS, `relay audit: ${ALLOWED_TOOL} ok, ${DENIED_TOOL} denied; the sheet lists them newest first as `
    + `"${top.join(' / ')}"; eve's route sends only ${AUDIT_FIELDS.join(', ')}`);
}

async function voiceDeepLink(env) {
  const id = 'voice-deep-link';
  const acme = env.world.projects.acme;
  const first = await env.newPage();
  await openEve(first, env);
  await waitForModels(first, env);
  await openProject(first, env, acme);
  const dialog = await openLauncher(first, env);

  env.step('find the World voice template');
  const card = dialog.getByRole('button', { name: /World voice/ });
  await need('terminal templates never loaded',
    expect(dialog.getByText('Loading terminal templates…')).toHaveCount(0, { timeout: 15000 }));
  if (await card.count() === 0) return result(id, BLOCKED, `no "World voice" chat template in ${acme.name} (setup V1)`);

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
  if (final.length !== 1) return result(id, FAIL, `${final.length} new ${acme.name} sessions, expected 1`);
  return result(id, PASS, `voice view in ${took}s, one session`);
}

async function changesDiff(env) {
  const id = 'changes-diff';
  const acme = env.world.projects.acme;
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
  await openProject(page, env, acme);
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

// Acme's published files this journey declares. Each shows in the Files tab
// as the first segment of its path: the file itself, or the folder holding it.
const FILE_EDIT_SHOWN = ['todo.txt', 'budget/q4-budget-draft.csv'];

async function fileEditSave(env) {
  const id = 'file-edit-save';
  const acme = env.world.projects.acme;
  const shown = FILE_EDIT_SHOWN.map((rel) => path.relative(acme.folder, env.world.file('acme', rel)).split(path.sep)[0]);
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
  await openProject(page, env, acme);
  env.step('open the Files tab');
  await page.getByTestId('panel-tab-files').click({ timeout: 10000 });
  for (const entry of shown) {
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
  await page.keyboard.press('ControlOrMeta+s');
  const onDisk = await poll(async () => (await fs.promises.readFile(file, 'utf8')).includes(saved), { timeoutMs: 5000, intervalMs: 250 });
  if (!onDisk) return result(id, FAIL, 'the saved line is not on disk 5s after ⌘S');
  await sleep(SELF_WRITE_WINDOW_MS);

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

async function askAboutFile(env) {
  const id = 'ask-about-file';
  const acme = env.world.projects.acme;
  env.step('set up a file with a code word');
  const dir = await scratchFolder(env, 'ask');
  const folder = `/${path.basename(dir)}`;
  const fileName = `${path.basename(dir)}/codeword.txt`;
  const codeWord = `kumquat-${crypto.randomBytes(3).toString('hex')}`;
  await fs.promises.writeFile(path.join(dir, 'codeword.txt'), `The code word is ${codeWord}.\n`);

  const page = await env.newPage();
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, acme);
  // Deliberate: Ask has no model menu and takes the model last used there
  // (eve-ask-model), so the run's model is put there as a returning user's is.
  const values = await page.evaluate((pid) => window.client.state.modelsForProject(pid).map((m) => m.value), acme.id);
  const model = pickModel(values, env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);
  await page.evaluate((m) => localStorage.setItem('eve-ask-model', m), model);

  env.step('open the file');
  await page.getByTestId('panel-tab-files').click({ timeout: 10000 });
  await page.getByTestId(`file-tree-item-${folder}`).click({ timeout: 15000 });
  const item = page.getByTestId(`file-tree-item-${folder}/codeword.txt`);
  await item.click({ timeout: 10000 });
  await need('the file did not open within 15s', expect(page.locator('#monacoEditor .view-lines')).toContainText(codeWord, { timeout: 15000 }));
  const home = page.getByTestId('home-screen');
  await need('Today is still showing with the file open', expect(home).toBeHidden({ timeout: 5000 }));

  env.step('Ask about this');
  await item.click({ button: 'right', timeout: 5000 });
  await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Ask about this', exact: true }).click({ timeout: 5000 });
  await need('Ask about this did not show Today within 10s', expect(home).toBeVisible({ timeout: 10000 }));
  await need('the Ask chip does not name the file', expect(page.getByTestId('today-ask-attachment')).toContainText(fileName, { timeout: 10000 }));
  await need('Ask does not have focus', expect(page.getByTestId('today-ask-input')).toBeFocused({ timeout: 5000 }));

  const before = await acmeIds(env, 'sessions');
  const marker = `ask ${env.nonce}`;
  env.step('ask for the code word');
  await page.keyboard.type(`What is the code word in the attached file? Reply with the code word only. (${marker})`);
  await page.keyboard.press('Enter');
  const created = await poll(async () => {
    const added = addedIds(before, await acmeIds(env, 'sessions'));
    return added.length ? added : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!created) {
    const said = (await page.getByTestId('today-ask-status').innerText({ timeout: 2000 }).catch(() => '')).trim();
    return result(id, FAIL, `no ${acme.name} session within 30s of Return${said ? `; Ask says "${said}"` : ''}`);
  }
  const bubble = page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: marker });
  await need('the question is not shown as the user message', expect(bubble).toBeVisible({ timeout: 15000 }));
  await need('the user message does not list the attached file', expect(bubble).toContainText(fileName, { timeout: 5000 }));

  env.step('wait for the reply');
  const stop = page.getByTestId('chat-stop');
  const settled = await poll(async () => {
    const r = replyAfter(await answers(page), marker);
    if (r.error) return r;
    if (r.reply && !(await stop.isVisible())) return r;
    return null;
  }, { timeoutMs: 45000, intervalMs: 1000 });
  if (!settled) return result(id, FAIL, 'no finished assistant reply within 45s');
  if (settled.error) return result(id, FAIL, `error in the thread: ${settled.error}`);
  const final = addedIds(before, await acmeIds(env, 'sessions'));
  if (final.length !== 1) return result(id, FAIL, `${final.length} new ${acme.name} sessions, expected 1`);
  const named = settled.reply.includes(codeWord);
  return result(id, PASS, `Today with Ask focused and the file's chip; one ${acme.name} thread whose question lists the file; `
    + `${named ? 'the reply named the code word' : `the reply did not name the code word: "${settled.reply.slice(0, 40)}"`}`);
}

// A sweep or overflow finding as a FAIL detail: where, and the first three.
const offenders = (what, where, list) => `${what} on ${where}: ${list.slice(0, 3).join('; ')}${list.length > 3 ? ` (+${list.length - 3})` : ''}`;

async function fitsAndThumbs(page, where) {
  const wide = await overflow(page);
  if (wide.length) return offenders('horizontal overflow', where, wide);
  const small = await sweep(page);
  return small.length ? offenders('targets under 44x44', where, small) : null;
}

async function todayIpadPortrait(env) {
  const id = 'today-ipad-portrait';
  const acme = env.world.projects.acme;
  const page = await env.newPage({ device: DEVICES.ipadPortrait });
  await openEve(page, env);
  env.step('wait for the greeting');
  const home = page.getByTestId('home-screen');
  await need('no greeting within 20s', expect(home.getByText(GREETING)).toBeVisible({ timeout: 20000 }));

  env.step(`check ${acme.name} is off screen`);
  const railItem = page.getByRole('navigation', { name: 'Projects' }).getByTitle(acme.name, { exact: true });
  await need(`${acme.name} is not in the rail`, expect(railItem).toHaveCount(1, { timeout: 15000 }));
  await need(`${acme.name}'s rail item is on screen at load`, expect(railItem).not.toBeInViewport({ timeout: 5000 }));

  env.step('measure the column');
  const main = await page.locator('main.main').boundingBox();
  const column = await home.boundingBox();
  if (!main || main.width < 833) return result(id, FAIL, `the main area is ${main ? Math.round(main.width) : 0}px wide, not the full 834px`);
  if (!column || column.width > 720) return result(id, FAIL, `Today is ${column ? Math.round(column.width) : 0}px wide, over 720px`);
  const offCentre = Math.abs((column.x + column.width / 2) - (main.x + main.width / 2));
  if (offCentre > 2) return result(id, FAIL, `Today sits ${Math.round(offCentre)}px off centre`);

  env.step('read the wordmark');
  const wordmark = page.locator('[data-wordmark-slot="today"]').getByTestId('mode-switch');
  await need('no wordmark at the top of Today', expect(wordmark).toBeVisible({ timeout: 5000 }));
  const word = (await wordmark.innerText({ timeout: 5000 })).replace(/\s+/g, '');
  if (word !== 'Home|Work') return result(id, FAIL, `the wordmark reads "${word}", not "Home|Work"`);

  env.step('sweep Today');
  const onToday = await fitsAndThumbs(page, 'Today');
  if (onToday) return result(id, FAIL, onToday);

  env.step('open the menu');
  await page.getByTestId('welcome-sidebar-open').click({ timeout: 5000 });
  await need(`the menu did not bring ${acme.name} on screen`, expect(railItem).toBeInViewport({ timeout: 5000 }));
  env.step('sweep the slide-over');
  const small = await sweep(page);
  if (small.length) return result(id, FAIL, offenders('targets under 44x44', 'the slide-over', small));

  env.step('tap the scrim');
  await page.getByTestId('sidebar-scrim').click({ timeout: 5000 });
  await need('the scrim did not close the slide-over', expect(railItem).not.toBeInViewport({ timeout: 5000 }));
  return result(id, PASS, `full-width main, ${Math.round(column.width)}px centred Today, wordmark in Today, no overflow or small targets; the menu and scrim open and close the slide-over`);
}

async function todayPhone(env) {
  const id = 'today-phone';
  const acme = env.world.projects.acme;
  const page = await env.newPage({ device: DEVICES.phone });
  const errors = captureErrors(page);
  await openEve(page, env);
  await waitForModels(page, env);
  env.step('wait for the greeting');
  const greeting = page.getByTestId('home-screen').getByText(GREETING);
  await need('no greeting within 20s', expect(greeting).toBeVisible({ timeout: 20000 }));
  await need('the Ask box has focus on the phone, which raises the keyboard over Today', expect(page.getByTestId('today-ask-input')).not.toBeFocused({ timeout: 2000 }));
  const bar = page.getByRole('navigation', { name: 'Navigation' });
  for (const name of ['Today', 'Threads', 'Projects']) {
    await need(`no ${name} in the bottom bar`, expect(bar.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 5000 }));
  }
  await need('the tab bar is showing on the phone', expect(page.getByTestId('tab-bar')).toBeHidden({ timeout: 5000 }));
  env.step('sweep Today');
  const onToday = await fitsAndThumbs(page, 'Today');
  if (onToday) return result(id, FAIL, onToday);

  const before = await acmeIds(env, 'sessions');
  env.step('open Projects');
  await page.getByTestId('nav-projects').click({ timeout: 5000 });
  await openProject(page, env, acme);
  const dialog = await openLauncher(page, env);
  env.step('open the Web Chat form');
  await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 });
  const select = dialog.getByTestId('launcher-model-select');
  const model = pickModel(await optionValues(select), env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);
  await select.selectOption(model, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  const created = await poll(async () => {
    const added = addedIds(before, await acmeIds(env, 'sessions'));
    return added.length ? added : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!created) {
    const refusal = errors.find((e) => /template "chat"/.test(e));
    return refusal ? result(id, BLOCKED, `launch refused: ${refusal}`) : result(id, FAIL, `no ${acme.name} session within 30s of Start Chat`);
  }
  if (created.length !== 1) return result(id, FAIL, `${created.length} new ${acme.name} sessions, expected 1`);
  const hash = `#session/${created[0]}`;

  const inThread = async (how) => {
    env.step(`check the thread (${how})`);
    await need(`no thread shown after ${how}`, expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 }));
    await need(`the address is not ${hash} after ${how}`, expect.poll(() => new URL(page.url()).hash, { timeout: 5000 }).toBe(hash));
  };
  await inThread('Start Chat');
  await need('the bottom bar still shows in the thread', expect(bar).toBeHidden({ timeout: 5000 }));
  await need('the tab bar is showing in the thread', expect(page.getByTestId('tab-bar')).toBeHidden({ timeout: 5000 }));
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await need('no Back in the thread', expect(back).toBeVisible({ timeout: 5000 }));
  env.step('sweep the thread');
  const onThread = await fitsAndThumbs(page, 'the thread');
  if (onThread) return result(id, FAIL, onThread);

  env.step('Back');
  await back.click({ timeout: 5000 });
  await need('Back did not show Today', expect(greeting).toBeVisible({ timeout: 10000 }));
  await need('the address keeps a hash after Back', expect.poll(() => new URL(page.url()).hash, { timeout: 5000 }).toBe(''));

  env.step('open the thread from Continue');
  await need('the thread is not in Continue on Today',
    page.getByTestId('home-screen').getByTestId(`home-session-${created[0]}`).click({ timeout: 15000 }));
  await inThread('Continue');
  env.step('browser Back');
  await page.goBack({ timeout: 10000 });
  await need('browser Back did not show Today', expect(greeting).toBeVisible({ timeout: 10000 }));
  return result(id, PASS, 'bottom bar on Today, no tab bar; no overflow or small targets on Today or the thread; Back and browser Back return to Today');
}

// — Settings and the project dialog (SX) ---------------------------------------

const RELAY_ROW = 'Models, tools, hosts and permissions live in Relay on your Mac.';
const SHEET_GROUPS = ['Display', 'Voice', 'Modes', 'Files'];
// relay's three admin fields: their wire keys, and eve's GET names for them.
const ADMIN_KEYS = ['allowed_models', 'allowed_mcp_ids', 'permission_policy'];
const ADMIN_FIELDS = ['allowedModels', 'allowedMcpIds', 'permissionPolicy'];

async function switchMode(page, env, mode) {
  env.step(`switch to ${mode}`);
  await page.getByTestId(`mode-${mode}`).click({ timeout: 10000 });
  await need(`the ${mode} switch did not take`,
    expect(page.getByTestId(`mode-${mode}`)).toHaveAttribute('aria-checked', 'true', { timeout: 5000 }));
}

async function openSettings(page, env) {
  env.step('open Settings');
  await page.getByTestId('sidebar-settings').click({ timeout: 10000 });
  const sheet = page.getByTestId('dialog-settings-dialog');
  await need('Settings did not open', expect(sheet).toBeVisible({ timeout: 10000 }));
  return sheet;
}

// Edit Project from the open project's panel menu; returns the dialog.
async function openEditProject(page, env, project) {
  env.step(`edit ${project.name}`);
  await page.getByTestId(`sidebar-project-more-${project.id}`).click({ timeout: 10000 });
  await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Edit Project', exact: true }).click({ timeout: 5000 });
  const dialog = page.getByTestId('dialog-project-dialog');
  await need('Edit Project did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
  return dialog;
}

const projectWrite = (method, pathname) => (res) =>
  res.request().method() === method && new URL(res.url()).pathname === pathname;

async function settingsSheet(env) {
  const id = 'settings-sheet';
  const projects = await eveJson(env, 'GET', '/api/projects');
  const workDefault = projects.find((p) => (p.defaultFor || []).includes('work'));
  const workRow = workDefault ? `Work starts in ${workDefault.name}` : 'Work: no default. Ask lets you pick.';
  const page = await env.newPage();
  // A dark system, so Auto reads dark and Light is a visible change.
  await page.emulateMedia({ colorScheme: 'dark' });
  await openEve(page, env);
  let sheet = await openSettings(page, env);

  env.step('read the sheet');
  await need('the sheet is not titled "Settings"',
    expect(sheet.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 5000 }));
  const tabs = await sheet.locator('.dialog__tab').count();
  if (tabs) return result(id, FAIL, `Settings has ${tabs} tabs`);
  // Text content, not innerText: the headings are small caps by CSS, which innerText returns shouted.
  const groups = (await sheet.getByRole('heading').allTextContents()).map((t) => t.trim()).filter((t) => SHEET_GROUPS.includes(t));
  if (groups.join() !== SHEET_GROUPS.join()) return result(id, FAIL, `groups read ${groups.join(', ') || 'none'}, not ${SHEET_GROUPS.join(', ')}`);
  const relay = sheet.getByTestId('settings-relay');
  await need('the Relay row is missing or reads otherwise', expect(relay).toHaveText(RELAY_ROW, { timeout: 5000 }));
  if (await relay.getByRole('button').count()) return result(id, FAIL, 'the Relay row has a button');
  const filesY = (await sheet.getByRole('heading', { name: 'Files', exact: true }).boundingBox())?.y ?? Infinity;
  const relayY = (await relay.boundingBox())?.y ?? -Infinity;
  if (relayY <= filesY) return result(id, FAIL, 'the Relay row is not after Files');

  const pressed = async (mode) => (await sheet.getByTestId(`settings-appearance-${mode}`).getAttribute('aria-pressed', { timeout: 5000 })) === 'true';
  const prior = (await Promise.all(['auto', 'light', 'dark'].map(async (m) => (await pressed(m) ? m : null)))).find(Boolean);
  if (!prior) return result(id, FAIL, 'no Appearance button is pressed');
  try {
    env.step('set Light');
    await sheet.getByTestId('settings-appearance-light').click({ timeout: 5000 });
    await need('Light did not take', expect(page.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 5000 }));
    await reloadEve(page, env);
    await need('Light did not survive a reload', expect(page.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 5000 }));
    sheet = await openSettings(page, env);
    await need('Light is not pressed after a reload',
      expect(sheet.getByTestId('settings-appearance-light')).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 }));
  } finally {
    env.step(`restore ${prior}`);
    await sheet.getByTestId(`settings-appearance-${prior}`).click({ timeout: 5000 }).catch(() => {});
  }

  env.step('read the Work row');
  await need(`the Work row does not read "${workRow}"`,
    expect(sheet.getByTestId('settings-default-work')).toHaveText(workRow, { timeout: 5000 }));
  env.step('Done');
  await sheet.getByTestId('settings-done').click({ timeout: 5000 });
  await need('Done did not close the sheet', expect(sheet).toBeHidden({ timeout: 5000 }));
  return result(id, PASS, `one sheet, no tabs: ${SHEET_GROUPS.join(', ')}, then the Relay line; Light survived a reload; "${workRow}"; Done closed it`);
}

async function projectAdminInRelay(env) {
  const id = 'project-admin-in-relay';
  const acme = env.world.projects.acme;
  const before = await eveJson(env, 'GET', `/api/projects/${acme.id}`);
  const page = await env.newPage();
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, acme);
  const dialog = await openEditProject(page, env, acme);

  env.step('read the General tab');
  const labels = await page.evaluate(() => window.client.state.models.map((m) => [m.value, m.label]));
  const allowed = before.allowedModels || [];
  const shown = !allowed.length || allowed.includes('*') ? 'All models'
    : allowed.map((v) => labels.find(([value]) => value === v)?.[1] || v).join(', ');
  await need(`the allowed models do not read "${shown}"`,
    expect(dialog.getByTestId('project-allowed-models')).toHaveText(shown, { timeout: 5000 }));
  await need('no pointer to Relay under the models',
    expect(dialog.getByTestId('project-relay-pointer')).toHaveText('Set in Relay Settings on your Mac.', { timeout: 5000 }));
  const problems = [];
  if (await dialog.locator('input[type=checkbox]').count()) problems.push('General has a checkbox');
  if (await dialog.locator('.dialog__tab', { hasText: 'Permissions' }).count()) problems.push('a Permissions tab');
  if (await dialog.getByTestId('project-where-add-host').count()) problems.push('a Host… button');
  if (problems.length) return result(id, FAIL, problems.join('; '));

  env.step('Save');
  const saved = page.waitForResponse(projectWrite('PUT', `/api/projects/${acme.id}`), { timeout: 15000 });
  await dialog.getByTestId('project-save').click({ timeout: 5000 });
  const res = await need('Save sent no PUT', saved);
  if (!res.ok()) return result(id, FAIL, `Save answered ${res.status()}`);
  const sent = ADMIN_KEYS.filter((k) => k in (res.request().postDataJSON() || {}));
  await need('Edit Project did not close after Save', expect(dialog).toBeHidden({ timeout: 10000 }));
  if (sent.length) return result(id, FAIL, `Save sent ${sent.join(', ')}`);

  const after = await eveJson(env, 'GET', `/api/projects/${acme.id}`);
  const changed = ADMIN_FIELDS.filter((f) => !isDeepStrictEqual(after[f], before[f]));
  if (changed.length) return result(id, FAIL, `relay's ${changed.join(', ')} changed on Save`);
  return result(id, PASS, `models read "${shown}", read-only, with the Relay pointer; no checkbox, Permissions tab or Host…; `
    + `Save sent none of ${ADMIN_KEYS.join(', ')} and relay kept all three`);
}

class BlockedError extends Error {}

async function projectModeNew(env) {
  const id = 'project-mode-new';
  const name = `verify-${env.nonce}`;
  const root = await fs.promises.realpath(os.tmpdir());
  const prefix = `verify-${env.nonce}-mode-`;
  const dir = await fs.promises.mkdtemp(path.join(root, prefix));
  // Idempotent, so the cleanup below finds nothing once the journey removed it.
  const removeProject = async () => {
    for (const p of (await eveJson(env, 'GET', '/api/projects')).filter((x) => x.name === name)) {
      await eveJson(env, 'DELETE', `/api/projects/${encodeURIComponent(p.id)}`);
    }
    if ((await eveJson(env, 'GET', '/api/projects')).some((x) => x.name === name)) throw new Error('still listed after DELETE');
  };
  // Runs after a timeout too, then removes the folder the project points at.
  env.cleanup('delete the verify project', removeProject);
  env.cleanup('remove mode folder', async () => {
    if (path.dirname(dir) !== root || !path.basename(dir).startsWith(prefix)) throw new Error('refusing to remove a folder outside the temp dir');
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const page = await env.newPage();
  await openEve(page, env);
  const rail = page.getByRole('navigation', { name: 'Projects' });
  const chip = rail.getByTitle(name, { exact: true });
  let outcome;
  try {
    await need('eve did not open in Work',
      expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 }));
    env.step('New Project');
    await page.getByTestId('sidebar-new-project').click({ timeout: 10000 });
    let dialog = page.getByTestId('dialog-project-dialog');
    await need('New Project did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
    await dialog.getByTestId('project-name').fill(name, { timeout: 5000 });
    await dialog.getByTestId('project-path').fill(dir, { timeout: 5000 });
    await need('New Project has no Home mode', dialog.getByTestId('project-mode-home').click({ timeout: 5000 }));
    // Relay gates every project create behind a presence dialog, so the POST
    // answers only once the helper has answered it. It must be ready before Create.
    const presence = env.screen.answerPresence({ expect: 'create the project' });
    if (!(await presence.ready)) throw new BlockedError(`presence dialog ${(await presence.result).state}`);
    const created = page.waitForResponse(projectWrite('POST', '/api/projects'), { timeout: 30000 });
    created.catch(() => {});
    await dialog.getByTestId('project-save').click({ timeout: 5000 });
    let res;
    try {
      res = await created;
    } catch (err) {
      const { state } = await presence.result;
      if (state !== 'answered') throw new BlockedError(`presence dialog ${state}`);
      throw new Error(`Create sent no POST (${firstLine(err)})`);
    }
    if (!res.ok()) throw new Error(`Create answered ${res.status()}`);
    const project = { id: (await res.json()).id, name };
    await need('New Project did not close', expect(dialog).toBeHidden({ timeout: 10000 }));
    const stored = await eveJson(env, 'GET', `/api/projects/${encodeURIComponent(project.id)}`);
    if (stored.mode !== 'home') throw new Error(`relay reports mode ${stored.mode}, not home`);

    await switchMode(page, env, 'home');
    await need(`${name} is not in the Home rail`, expect(chip).toBeVisible({ timeout: 10000 }));
    await switchMode(page, env, 'work');
    env.step(`confirm ${name} is absent in Work`);
    await sleep(1500);
    if (await chip.count()) throw new Error(`${name} is in the Work rail`);

    await switchMode(page, env, 'home');
    await openProject(page, env, project);
    dialog = await openEditProject(page, env, project);
    await need('Edit Project does not start at Home',
      expect(dialog.getByTestId('project-mode-home')).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 }));
    await dialog.getByTestId('project-mode-both').click({ timeout: 5000 });
    const updated = page.waitForResponse(projectWrite('PUT', `/api/projects/${project.id}`), { timeout: 15000 });
    await dialog.getByTestId('project-save').click({ timeout: 5000 });
    const put = await need('Save sent no PUT', updated);
    if (!put.ok()) throw new Error(`Save answered ${put.status()}`);
    await need('Edit Project did not close', expect(dialog).toBeHidden({ timeout: 10000 }));
    await switchMode(page, env, 'work');
    await need(`${name} is not in the Work rail after Both, with no reload`, expect(chip).toBeVisible({ timeout: 10000 }));
    outcome = result(id, PASS, `created in Home (relay: home), absent in Work, shown in Home; Both shows it in Work with no reload`);
  } catch (err) {
    outcome = err instanceof BlockedError ? result(id, BLOCKED, err.message) : result(id, FAIL, firstLine(err));
  }
  const leftover = await removeProject().then(() => '', (err) => `; left project ${name} behind (${firstLine(err)})`);
  await switchMode(page, env, 'work').catch(() => {});
  return leftover ? result(id, FAIL, outcome.detail + leftover) : outcome;
}

// — Morning brief (S3a) ---------------------------------------------------------

const BRIEF_RUN_MS = 300000;
const PROBE_WAIT_MS = 15000;
const RUN_ENDED = ['success', 'error', 'timeout'];
const BRIEF_SECTIONS = ['events', 'reminders', 'reply', 'weather', 'notes'];
const shellWord = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function relayCallRows(env, project, sinceMs, untilMs = Infinity) {
  const args = ['audit', '--event', 'call_tool', '--project', project.id, '--json', '--tail', '500'];
  const { stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 16 << 20 });
  return callToolRows(stdout, { projectId: project.id, sinceMs }).filter((r) => r.ts <= untilMs);
}

// The brief's run, then relay's gate with the injection's own targets, then
// Today in Home. The security half (S3a-A1) is judged before Today is opened,
// so its result is in every detail.
async function briefInjectionRefused(env) {
  const id = 'brief-injection-refused';
  const home = env.world.projects.home;
  const inj = env.world.briefInjection;
  if (!inj) return result(id, BLOCKED, 'fixture: the world publishes no usable brief_injection');
  let Brief;
  try { Brief = require('../public/today/brief.js'); } catch (err) { return result(id, FAIL, `public/today/brief.js: ${firstLine(err)}`); }

  const page = await env.newPage();
  await openEve(page, env);
  await waitForModels(page, env);
  const models = await page.evaluate((pid) => window.client.state.modelsForProject(pid)
    .map((m) => ({ value: m.value, provider: m.provider })), home.id);
  const model = pickModel(models.map((m) => m.value), env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered in ${home.name}`);
  if (!Brief.localModels(models).some((m) => m.value === model)) {
    return result(id, BLOCKED, `model ${model} is provider ${models.find((m) => m.value === model).provider || 'none'}, not chat`);
  }

  const before = await worldIds(env, [home], 'tasks');
  env.cleanup('delete the brief', async () => {
    for (const taskId of addedIds(before, await worldIds(env, [home], 'tasks'))) {
      await eveJson(env, 'DELETE', `/api/tasks/${encodeURIComponent(taskId)}`);
    }
  });
  env.step('create the brief');
  // Set up's body, on demand so it can never fire on the devbox.
  await eveJson(env, 'POST', '/api/tasks', { ...Brief.taskBody(home.id, model), schedule: { type: 'on_demand' } });
  const made = addedIds(before, await worldIds(env, [home], 'tasks'));
  if (made.length !== 1) return result(id, BLOCKED, `${made.length} new ${home.name} tasks after POST /api/tasks, expected 1`);
  const taskPath = `/api/tasks/${encodeURIComponent(made[0])}`;

  env.step('run the brief');
  const runFrom = Date.now() - 1000;
  await eveJson(env, 'POST', `${taskPath}/run`);
  const ended = await poll(async () => {
    const history = await eveJson(env, 'GET', `${taskPath}/history`).catch(() => null);
    const last = Array.isArray(history) ? history[0] : null;
    return last && RUN_ENDED.includes(last.status) ? last : null;
  }, { timeoutMs: BRIEF_RUN_MS, intervalMs: 2000 });
  const runTo = Date.now() + 1000;

  env.step('read relay audit for the run');
  const run = briefRunVerdict(await relayCallRows(env, home, runFrom, runTo));
  if (run.security) return result(id, FAIL, run.detail);
  if (!ended) return result(id, FAIL, `the brief run did not end within ${BRIEF_RUN_MS / 1000}s`);
  if (ended.status !== 'success') return result(id, FAIL, `the run ended ${ended.status}: ${firstLine(ended.error || 'no reason')}`);
  if (run.state !== PASS) return result(id, FAIL, run.detail);

  await switchMode(page, env, 'home');
  await openProject(page, env, home);
  const probe = await openWorldProbe(page, env, home);
  if (!probe) return result(id, BLOCKED, `no "World probe" card for ${home.name}`);
  env.cleanup('close the World probe terminal', () => env.api.closeTerminal(probe.terminalId));
  const probeFrom = Date.now() - 1000;
  const bin = shellWord(env.relayBin);
  const call = (tool, args) => `${bin} mcp call --tool ${tool} --args ${shellWord(JSON.stringify(args))}`;
  await probe.typeLine([
    call('mail_send', { to: inj.sendTo, subject: `verify ${env.nonce}`, body: `verify ${env.nonce}` }),
    call('web_fetch', { url: inj.fetchUrl }),
  ].join('; '));
  env.step('read relay audit for the probe');
  let gate = null;
  await poll(async () => {
    gate = probeVerdict(await relayCallRows(env, home, probeFrom).catch(() => []), BRIEF_REFUSED);
    return gate.state !== BLOCKED;
  }, { timeoutMs: PROBE_WAIT_MS, intervalMs: 1000 });
  await env.api.closeTerminal(probe.terminalId);
  await switchMode(page, env, 'work').catch(() => {});
  const held = `${run.detail}; ${gate.detail}`;
  if (gate.state !== PASS) return result(id, gate.state, held);

  // S3a-A4, Today half: on main there is no brief part, so this is red there.
  const today = await env.newPage();
  try {
    await openEve(today, env);
    await switchMode(today, env, 'home');
    env.step('read the brief on Today');
    const part = today.getByTestId('today-part-brief');
    const when = part.getByTestId('today-brief-when');
    const unreadable = part.getByTestId('today-brief-unreadable');
    const shown = await expect(when.or(unreadable)).toBeVisible({ timeout: 20000 }).then(() => true, () => false);
    if (!shown) return result(id, FAIL, `Today in ${home.name} shows no brief and no unreadable line; ${held}`);
    const sections = [];
    for (const s of BRIEF_SECTIONS) if (await part.getByTestId(`today-brief-${s}`).isVisible()) sections.push(s);
    const isUnreadable = await unreadable.isVisible();
    if (!isUnreadable && !sections.length) return result(id, FAIL, `the brief on Today shows no section; ${held}`);
    const markup = await part.locator('a, img, iframe, script').count();
    if (markup) return result(id, FAIL, `the brief part holds ${markup} a, img, iframe or script elements; ${held}`);
    if ((await part.innerText({ timeout: 5000 })).includes('```')) return result(id, FAIL, `the brief part shows a code fence; ${held}`);
    const listed = sections.includes('reply')
      && (await part.getByTestId('today-brief-reply').innerText({ timeout: 5000 })).includes(inj.subject);
    return result(id, PASS, `${held}; Today: ${isUnreadable ? 'the unreadable line' : `sections ${sections.join(', ')}`}, `
      + `no markup; the injection mail ${listed ? 'is' : 'is not'} under Needs a reply`);
  } finally {
    await switchMode(today, env, 'work').catch(() => {});
  }
}

const auth = require('./journeys-auth').journeys;

// The table order is the run order. agent-enrol-refused runs before anything
// that could open relay's one enrolment window; add-browser-in-window runs
// last (a screen journey) and consumes the window it opens.
const journeys = [
  auth.passkeyFirstEnrol,
  auth.passkeySignIn,
  auth.agentEnrolRefused,
  { id: 'landing-view', timeoutMs: 30000, areas: ['auth', 'home'], needs: [], run: landingView },
  {
    id: 'world-projects-listed', timeoutMs: 45000, areas: ['home', 'projects'],
    needs: ['project:acme', 'project:globex', 'project:home'], run: worldProjectsListed,
  },
  { id: 'chat-reply', timeoutMs: 150000, areas: ['chat'], needs: ['project:acme'], run: chatReply },
  { id: 'open-existing-thread', timeoutMs: 75000, areas: ['chat', 'home'], needs: ['project:acme'], run: openExistingThread },
  {
    id: 'terminal-on-request', timeoutMs: 75000, areas: ['terminal'],
    needs: ['project:acme', 'project:globex', 'project:home'], run: terminalOnRequest,
  },
  { id: 'task-created-listed', timeoutMs: 120000, areas: ['tasks'], needs: ['project:acme'], run: taskCreatedListed },
  { id: 'routine-from-thread', timeoutMs: 120000, areas: ['tasks', 'chat', 'home'], needs: ['project:acme'], run: routineFromThread },
  { id: 'routine-touched', timeoutMs: 90000, areas: ['tasks', 'terminal'], needs: ['project:acme'], run: routineTouched },
  { id: 'voice-deep-link', timeoutMs: 60000, areas: ['voice'], needs: ['project:acme'], run: voiceDeepLink },
  { id: 'changes-diff', timeoutMs: 60000, areas: ['git'], needs: ['project:acme'], run: changesDiff },
  {
    id: 'file-edit-save', timeoutMs: 75000, areas: ['files'],
    needs: ['project:acme', ...FILE_EDIT_SHOWN.map((rel) => `file:acme/${rel}`)], run: fileEditSave,
  },
  auth.agentSignInRefused,
  // After agent-sign-in-refused so a slow night spends its budget on these,
  // not on it. add-browser-in-window is a screen journey, so orderJourneys
  // runs it after them whatever the table order.
  { id: 'today-ipad-portrait', timeoutMs: 45000, areas: ['home', 'shell'], needs: ['project:acme'], run: todayIpadPortrait },
  { id: 'today-phone', timeoutMs: 75000, areas: ['home', 'shell', 'chat'], needs: ['project:acme'], run: todayPhone },
  { id: 'ask-about-file', timeoutMs: 90000, areas: ['home', 'chat', 'files'], needs: ['project:acme'], run: askAboutFile },
  { id: 'settings-sheet', timeoutMs: 45000, areas: ['settings'], needs: [], run: settingsSheet },
  { id: 'project-admin-in-relay', timeoutMs: 45000, areas: ['projects'], needs: ['project:acme'], run: projectAdminInRelay },
  { id: 'brief-injection-refused', timeoutMs: 360000, areas: ['home', 'tasks'], needs: ['project:home'], run: briefInjectionRefused },
  { id: 'project-mode-new', timeoutMs: 90000, areas: ['projects', 'home'], needs: [], screen: true, run: projectModeNew },
  auth.addBrowserInWindow,
];

module.exports = { journeys };
