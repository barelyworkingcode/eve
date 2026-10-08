// The devbox journeys. Each drives eve's real UI as a person would and
// judges a user-visible outcome. Test ids are only click targets and anchors;
// verdicts rest on visible text or visibility. See docs/design-devboxverify.md.
/** @typedef {{ id: string, timeoutMs: number, areas: string[], needs: string[], fixture?: true, screen?: true, knownBug?: string, run(env): Promise<object> }} Journey */
const { execFile } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify, isDeepStrictEqual } = require('util');
const WebSocket = require('ws');
const { expect } = require('@playwright/test');
const {
  GREETING, PASS, FAIL, BLOCKED, result, firstLine, sleep, now, seconds, left, need, poll, pickModel, optionValues,
  openEve, waitForModels, openProject, openProjectPage, acmeIds, allWorldIds, addedIds, openLauncher, captureErrors,
  thread, threadError, replyAfter, openWorldProbe, eveJson, callToolRows, DEVICES, sweep, overflow,
  worldIds, DENIED_OUTCOMES, BRIEF_REFUSED, briefRunVerdict, probeVerdict, openEditProject, openTemplate, pressPreset,
  stubSources, sourcesRowProblem, firstDifference, isUnder, MIN_TARGET, servePage, pasteText, deleteSession,
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

// A `verify-<nonce>-<kind>-XXXXXX` folder in a project's folder (Acme Corp by
// default), removed by cleanup whatever the verdict. A leftover in Acme Corp
// fails the next world preflight.
async function scratchFolder(env, kind, project = env.world.projects.acme) {
  const root = path.resolve(project.path);
  const prefix = `verify-${env.nonce}-${kind}-`;
  const dir = await fs.promises.mkdtemp(path.join(root, prefix));
  env.cleanup(`remove ${kind} folder`, async () => {
    if (!dir || path.dirname(dir) !== root || !path.basename(dir).startsWith(prefix)) {
      throw new Error(`refusing to remove a scratch folder outside ${project.name}`);
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
  const deadline = now() + 20000;
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
  const sentAt = now();
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
  const typedAt = now();
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

const VOICE_VIEW_MS = 30000;

// The voice chat view, judged as a person sees it: "End session" and no text composer.
async function voiceView(page) {
  await need(`the voice chat view did not show within ${VOICE_VIEW_MS / 1000}s`, expect(
    page.getByRole('button', { name: 'End session' })).toBeVisible({ timeout: VOICE_VIEW_MS }));
  await need('the text composer is still showing', expect(page.getByTestId('chat-input')).toBeHidden({ timeout: 5000 }));
}

// Setup V1 and V2 as eve's API reads them: a BLOCKED detail, or ''.
async function voiceSetupMissing(env, project) {
  const stored = (await eveJson(env, 'GET', '/api/projects')).find((p) => p.id === project.id);
  const missing = [];
  if (!(stored?.chatTemplates || []).some((t) => t.name === 'World voice' && t.mode === 'voice')) {
    missing.push(`no "World voice" voice template in ${project.name} (setup V1)`);
  }
  return missing.join('; ');
}

// Setup V2 missing is a FAIL, never BLOCKED: a not-run path here would be a gate change.
async function workDefaultMissing(env, project) {
  const stored = (await eveJson(env, 'GET', '/api/projects')).find((p) => p.id === project.id);
  return (stored?.defaultFor || []).includes('work') ? ''
    : `${project.name} is not Work's default project; set it in Relay → Projects → Default projects: Work = ${project.name} (setup V2)`;
}

async function voiceDeepLink(env) {
  const id = 'voice-deep-link';
  const acme = env.world.projects.acme;
  const missing = await voiceSetupMissing(env, acme);
  if (missing) return result(id, BLOCKED, missing);
  const noDefault = await workDefaultMissing(env, acme);
  if (noDefault) return result(id, FAIL, noDefault);

  const first = await env.newPage();
  await openEve(first, env);
  await waitForModels(first, env);
  await switchMode(first, env, 'work');
  await openProject(first, env, acme);
  const dialog = await openLauncher(first, env);
  env.step('look for a star on World voice');
  await need('terminal templates never loaded',
    expect(dialog.getByText('Loading terminal templates…')).toHaveCount(0, { timeout: 15000 }));
  await need('the launcher shows no World voice card',
    expect(dialog.getByRole('button', { name: /World voice/ }).first()).toBeVisible({ timeout: 5000 }));
  const stars = await dialog.getByTitle(/Action Button favorite/).count();
  if (stars) return result(id, FAIL, `the launcher still offers ${stars} "Action Button favorite" star${stars > 1 ? 's' : ''}`);

  // The journey's one lasting write: World voice stays Work's voice preset.
  await openEve(first, env);
  const { dialog: edit, form, added } = await openTemplate(first, env, acme, 'World voice');
  if (added) return result(id, FAIL, 'Edit Project does not list World voice');
  const wasSet = await pressPreset(form, 'work');
  await saveTemplates(first, env, edit, acme);
  const before = await acmeIds(env, 'sessions');
  const context = first.context();
  await first.close();

  env.step('open the voice deep link');
  let page = await context.newPage();
  const openedAt = now();
  await openEve(page, env, '#/voice-chat');
  await voiceView(page);
  const took = seconds(openedAt);
  env.step('count the voice session');
  await poll(async () => addedIds(before, await acmeIds(env, 'sessions')).length > 0, { timeoutMs: 10000, intervalMs: 1000 });
  await sleep(1000);
  const launched = addedIds(before, await acmeIds(env, 'sessions'));
  if (launched.length !== 1) return result(id, FAIL, `${launched.length} new ${acme.name} sessions after the first press, expected 1`);
  await page.close();

  env.step('press again');
  page = await context.newPage();
  await openEve(page, env, '#/voice-chat');
  await voiceView(page);
  const hash = `#session/${launched[0]}`;
  await need(`the second press did not show the first press's thread (${hash})`,
    expect.poll(() => new URL(page.url()).hash, { timeout: 10000 }).toBe(hash));
  await sleep(2000);
  const after = addedIds(before, await acmeIds(env, 'sessions'));
  if (after.length !== 1) return result(id, FAIL, `the second press within 30 minutes made ${after.length - 1} new ${acme.name} session(s)`);
  return result(id, PASS, `no star; World voice ${wasSet ? 'was already' : 'is now'} Work's voice preset; `
    + `voice view in ${took}s with one session; a second press resumed it`);
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

const projectWrite = (method, pathname) => (res) =>
  res.request().method() === method && new URL(res.url()).pathname === pathname;

// Save Template on the open form, then Save; throws unless relay took the PUT.
async function saveTemplates(page, env, dialog, project) {
  env.step('Save Template, then Save');
  await dialog.getByRole('button', { name: 'Save Template', exact: true }).click({ timeout: 5000 });
  const saved = page.waitForResponse(projectWrite('PUT', `/api/projects/${project.id}`), { timeout: 15000 });
  saved.catch(() => {});
  await dialog.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 5000 });
  const res = await need('Save sent no PUT', saved);
  if (!res.ok()) throw new Error(`Save answered ${res.status()}`);
  await need('Edit Project did not close after Save', expect(dialog).toBeHidden({ timeout: 10000 }));
}

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

// — Mode presets (S3b-1) ------------------------------------------------------------

const templatesNamed = async (env, project, name) =>
  ((await eveJson(env, 'GET', `/api/projects/${project.id}`)).chatTemplates || []).filter((t) => t.name === name);

// Every frame of `type` (create_session unless named) the page sends, from before it opens eve.
function createFrames(page, type = 'create_session') {
  const frames = [];
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
    if (typeof payload !== 'string') return;
    try {
      const frame = JSON.parse(payload);
      if (frame && frame.type === type) frames.push(frame);
    } catch { /* not JSON */ }
  }));
  return frames;
}

// Edit Project → Templates → Delete every row called `name`, then Save.
async function deleteTemplates(page, env, project, name) {
  await openEve(page, env);
  await openProject(page, env, project);
  const dialog = await openEditProject(page, env, project);
  await dialog.locator('.dialog__tab[data-tab="templates"]').click({ timeout: 5000 });
  await need('the Templates tab did not open',
    expect(dialog.getByRole('button', { name: '+ Add Template' })).toBeVisible({ timeout: 5000 }));
  env.step(`delete template ${name}`);
  const rows = dialog.locator('.project-dialog__template-item').filter({ has: page.getByText(name, { exact: true }) });
  while (await rows.count()) await rows.first().getByTitle('Delete').click({ timeout: 5000 });
  const saved = page.waitForResponse(projectWrite('PUT', `/api/projects/${project.id}`), { timeout: 15000 });
  saved.catch(() => {});
  await dialog.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 5000 });
  await saved;
}

async function modePresets(env) {
  const id = 'mode-presets';
  const acme = env.world.projects.acme;
  const name = `verify-${env.nonce} ask`;
  const prompt = `verify-${env.nonce}`;
  const noDefault = await workDefaultMissing(env, acme);
  if (noDefault) return result(id, FAIL, noDefault);

  // Pressing Work Ask clears it from any other Acme template (withPreset), so note
  // the holder now and give it back in cleanup.
  const before0 = await eveJson(env, 'GET', `/api/projects/${acme.id}`);
  const priorId = before0.chatTemplates.find((t) => t.mode !== 'voice' && (t.presetFor || []).includes('work'))?.id;

  // Timeouts close the page first, so this one goes through eve's API, as the dialog's PUT would.
  env.cleanup('remove the verify Ask template and restore Work Ask', async () => {
    const project = await eveJson(env, 'GET', `/api/projects/${acme.id}`);
    const keep = project.chatTemplates.filter((t) => t.name !== name);
    const restore = priorId && keep.some((t) => t.id === priorId
      && !project.chatTemplates.some((o) => o.id !== priorId && o.mode !== 'voice' && (o.presetFor || []).includes('work'))
      && !(t.presetFor || []).includes('work'));
    if (keep.length === project.chatTemplates.length && !restore) return;
    await eveJson(env, 'PUT', `/api/projects/${acme.id}`, {
      name: project.name, path: project.path, host_id: project.hostId || '',
      chat_templates: keep.map((t) => {
        const modes = t.id === priorId && restore ? [...new Set([...(t.presetFor || []), 'work'])] : t.presetFor;
        return {
          id: t.id, name: t.name, model: t.model, mode: t.mode, voice: t.voice, system_prompt: t.systemPrompt,
          ...(modes && modes.length ? { preset_for: modes } : {}),
        };
      }),
    });
  });

  const page = await env.newPage();
  const steps = async () => {
    await openEve(page, env);
    await waitForModels(page, env);
    await switchMode(page, env, 'work');
    const values = await page.evaluate((pid) => window.client.state.modelsForProject(pid).map((m) => m.value), acme.id);
    const model = pickModel(values, env.model);
    if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);

    const { dialog, form } = await openTemplate(page, env, acme, name);
    env.step('fill the template');
    await form.locator('select').first().selectOption(model, { timeout: 5000 });
    await form.getByRole('radio', { name: 'Text', exact: true }).check({ timeout: 5000 });
    await form.locator('textarea').first().fill(prompt, { timeout: 5000 });
    await pressPreset(form, 'work');
    await saveTemplates(page, env, dialog, acme);

    env.step('read the template back');
    const mine = await templatesNamed(env, acme, name);
    if (mine.length !== 1) return result(id, FAIL, `eve lists ${mine.length} templates called "${name}"`);
    if (!isDeepStrictEqual(mine[0].presetFor, ['work'])) {
      return result(id, FAIL, `eve reads presetFor ${JSON.stringify(mine[0].presetFor)}, not ["work"]`);
    }

    const sheet = await openSettings(page, env);
    env.step('read the Work presets row');
    await need(`the Work presets row does not start "Ask: ${name}"`, expect(sheet.getByTestId('settings-presets-work'))
      .toHaveText(new RegExp(`^Ask: ${escapeRe(name)} · Voice: `), { timeout: 10000 }));
    await sheet.getByTestId('settings-done').click({ timeout: 5000 });

    env.step('Ask on Today');
    const ask = await page.context().newPage();
    const frames = createFrames(ask);
    await openEve(ask, env);
    await waitForModels(ask, env);
    const input = ask.getByTestId('today-ask-input');
    await need('Ask is not on Today', expect(input).toBeVisible({ timeout: 10000 }));
    const before = await acmeIds(env, 'sessions');
    await input.fill(`verify-${env.nonce} hello`, { timeout: 5000 });
    await input.press('Enter', { timeout: 5000 });
    const created = await poll(async () => addedIds(before, await acmeIds(env, 'sessions')).length > 0,
      { timeoutMs: 30000, intervalMs: 1000 });
    if (!created) {
      const said = (await ask.getByTestId('today-ask-status').innerText({ timeout: 2000 }).catch(() => '')).trim();
      return result(id, FAIL, `no ${acme.name} session within 30s of Return${said ? `; Ask says "${said}"` : ''}`);
    }
    await sleep(1000);
    const final = addedIds(before, await acmeIds(env, 'sessions'));
    if (final.length !== 1) return result(id, FAIL, `${final.length} new ${acme.name} sessions, expected 1`);
    if (frames.length !== 1) return result(id, FAIL, `Ask sent ${frames.length} create_session frames, expected 1`);
    const { model: sentModel, systemPrompt } = frames[0];
    if (sentModel !== model || systemPrompt !== prompt) {
      return result(id, FAIL, `create_session carried model ${sentModel} and systemPrompt ${JSON.stringify(systemPrompt)}, `
        + `not the preset's ${model} and "${prompt}"`);
    }
    return result(id, PASS, `marked Work's Ask preset in Edit Project; eve reads presetFor ["work"]; Settings names it; `
      + `Ask made one ${acme.name} thread with its model and system prompt`);
  };
  const outcome = await steps().catch((err) => result(id, FAIL, firstLine(err)));

  env.step('remove the template');
  let left = await templatesNamed(env, acme, name);
  if (left.length) {
    await deleteTemplates(await page.context().newPage(), env, acme, name).catch(() => {});
    left = await templatesNamed(env, acme, name);
  }
  if (left.length) {
    const failed = outcome.state === FAIL ? `${outcome.detail}; ` : '';
    return result(id, FAIL, `${failed}template "${name}" is still listed after Delete and Save`);
  }
  return outcome;
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

// eve#117: a terminal routine with an output file is a card on Today. Setup and
// wire checks go through eve's API; verdicts on the card rest on the page.
const CARD_RUN_MS = 45000;
const CARD_SHOW_MS = 20000;

async function cardRunEnded(env, taskPath, runs) {
  return poll(async () => {
    const history = await eveJson(env, 'GET', `${taskPath}/history`).catch(() => null);
    return Array.isArray(history) && history.length >= runs && RUN_ENDED.includes(history[0].status) ? history[0] : null;
  }, { timeoutMs: CARD_RUN_MS, intervalMs: 1000 });
}

async function todayCustomPart(env) {
  const id = 'today-custom-part';
  const acme = env.world.projects.acme;
  const folder = path.resolve(acme.path);
  const file = `verify-${env.nonce}-card.json`;
  const target = path.join(folder, file);
  const before = await acmeIds(env, 'tasks');
  removeNewTasks(env, before);
  env.cleanup('remove the card output file', async () => {
    if (path.dirname(target) !== folder || path.basename(target) !== file) throw new Error(`refusing to remove a file outside ${acme.name}`);
    await fs.promises.rm(target, { force: true });
  });
  const body = (script) => ({
    name: `verify-${env.nonce}-card`, projectId: acme.id, schedule: { type: 'on_demand' }, enabled: true, catchUp: false,
    sessionType: 'pty', templateId: 'world-probe', extraArgs: ['-c', script], outputFile: file,
  });
  const write = (text) => `printf '%s' ${shellWord(text)} > ${shellWord(file)}`;
  const noise = `verify-${env.nonce}-noise`;
  const bold = `<b>verify ${env.nonce}</b> docs`;
  const listJson = JSON.stringify({
    renderer: 'list',
    items: [{ title: bold, url: 'https://example.com/verify' }, { title: 'Not a link', url: 'javascript:alert(1)' }],
  });

  env.step('create the card routine');
  await eveJson(env, 'POST', '/api/tasks', body(`echo ${noise}-out; echo ${noise}-err >&2; ${write(listJson)}`));
  const made = addedIds(before, await acmeIds(env, 'tasks'));
  if (made.length !== 1) return result(id, BLOCKED, `${made.length} new ${acme.name} routines after POST /api/tasks, expected 1`);
  const taskPath = `/api/tasks/${encodeURIComponent(made[0])}`;
  if ((await eveJson(env, 'GET', taskPath))?.outputFile !== file) {
    return result(id, BLOCKED, 'installed relayScheduler predates outputFile (relayScheduler#10)');
  }

  const page = await env.newPage();
  try {
    await openEve(page, env);
    await switchMode(page, env, 'work');
    env.step('find the card on Today');
    const card = page.getByTestId(`today-part-custom-${made[0]}`);
    if (!await expect(card).toBeVisible({ timeout: CARD_SHOW_MS }).then(() => true, () => false)) {
      return result(id, FAIL, 'no card for the routine on Today');
    }
    if (!await expect(card.getByTestId('today-custom-never')).toContainText('No output yet.', { timeout: 5000 }).then(() => true, () => false)) {
      return result(id, FAIL, `the never-run card does not say "No output yet."; it says "${firstLine(await card.innerText())}"`);
    }
    await sleep(5000);
    const early = await eveJson(env, 'GET', `${taskPath}/history`);
    if (!Array.isArray(early) || early.length) return result(id, FAIL, `opening Today ran the routine: history holds ${JSON.stringify(early).slice(0, 80)}`);

    env.step('Refresh');
    await card.getByTestId('today-custom-refresh').click({ timeout: 5000 });
    const first = await cardRunEnded(env, taskPath, 1);
    if (!first) return result(id, FAIL, `the Refresh run did not end within ${CARD_RUN_MS / 1000}s`);
    if (first.status !== 'success') {
      return result(id, /template/i.test(first.error || '') ? BLOCKED : FAIL, `the Refresh run ended ${first.status}: ${firstLine(first.error || 'no reason')}`);
    }
    if (first.output !== listJson) return result(id, FAIL, `history output is ${JSON.stringify(first.output || null).slice(0, 80)}, not the JSON the script wrote`);
    const tail = String(first.response || '');
    if (!tail.includes(`${noise}-out`) || !tail.includes(`${noise}-err`)) return result(id, FAIL, 'the run\'s response does not hold the script\'s stdout and stderr');
    const items = card.getByTestId('today-custom-item');
    if (!await expect(items).toHaveCount(2, { timeout: CARD_SHOW_MS }).then(() => true, () => false)) {
      return result(id, FAIL, `the card shows ${await items.count()} items after the run, expected 2, with no reload`);
    }
    if (!(await card.innerText()).includes(bold)) return result(id, FAIL, 'the <b> title is not shown as literal text');
    const markup = await card.locator('b, img, iframe, script').count();
    if (markup) return result(id, FAIL, `security: the card holds ${markup} b, img, iframe or script elements built from output`);
    if (await card.locator('a[href^="javascript:" i]').count()) return result(id, FAIL, 'security: the card holds a javascript: link');
    const links = await card.locator('a').evaluateAll((as) => as.map((a) => a.href));
    if (links.length !== 1 || links[0] !== 'https://example.com/verify') return result(id, FAIL, `the card's links are ${JSON.stringify(links)}, expected only the https: item`);
    if (!await card.getByTestId('today-custom-when').isVisible()) return result(id, FAIL, 'the card shows no "Ran <time>"');

    await switchMode(page, env, 'home');
    if (!await expect(card).toHaveCount(0, { timeout: 5000 }).then(() => true, () => false)) return result(id, FAIL, `the ${acme.name} card shows in Home`);
    await switchMode(page, env, 'work');
    await need('the card did not come back in Work', expect(items).toHaveCount(2, { timeout: CARD_SHOW_MS }));

    env.step('fail it with exit 3, run from the API');
    await eveJson(env, 'PUT', taskPath, body('exit 3'));
    await eveJson(env, 'POST', `${taskPath}/run`);
    if (!await cardRunEnded(env, taskPath, 2)) return result(id, FAIL, `the exit-3 run did not end within ${CARD_RUN_MS / 1000}s`);
    const failed = card.getByTestId('today-custom-failed');
    if (!await expect(failed).toContainText('exited 3', { timeout: CARD_SHOW_MS }).then(() => true, () => false)) {
      return result(id, FAIL, `after a failed run started elsewhere the card does not read "exited 3"; it says "${firstLine(await card.innerText())}"`);
    }
    const stale = await card.evaluate((el) => el.dataset.stale === 'true' || !!el.querySelector('[data-stale="true"]'));
    if (!stale || await items.count() !== 2) return result(id, FAIL, `the failed card ${stale ? '' : 'is not marked stale and '}shows ${await items.count()} of the 2 earlier items`);

    env.step('write not json, then Retry');
    await eveJson(env, 'PUT', taskPath, body(write('not json')));
    await card.getByTestId('today-custom-retry').click({ timeout: 5000 });
    if (!await cardRunEnded(env, taskPath, 3)) return result(id, FAIL, `the Retry run did not end within ${CARD_RUN_MS / 1000}s`);
    if (!await expect(card.getByTestId('today-custom-not-understood')).toBeVisible({ timeout: CARD_SHOW_MS }).then(() => true, () => false)) {
      return result(id, FAIL, `invalid JSON does not show "Output not understood"; the card says "${firstLine(await card.innerText())}"`);
    }
    if (!(await card.getByTestId('today-custom-raw').textContent({ timeout: 5000 })).includes('not json')) return result(id, FAIL, 'the raw text is not behind the disclosure');
    const ask = await page.getByTestId('today-part-ask').getAttribute('data-state', { timeout: 5000 });
    if (ask !== 'ready') return result(id, FAIL, `Ask is ${ask} next to the not-understood card`);

    env.step('write 70,000 bytes');
    const big = 'a=xxxxxxxxxx; b=$a$a$a$a$a$a$a$a$a$a; c=$b$b$b$b$b$b$b$b$b$b; d=$c$c$c$c$c$c$c$c$c$c; '
      + `printf '%s' $d$d$d$d$d$d$d > ${shellWord(file)}`;
    await eveJson(env, 'PUT', taskPath, body(big));
    await eveJson(env, 'POST', `${taskPath}/run`);
    if (!await cardRunEnded(env, taskPath, 4)) return result(id, FAIL, `the oversize run did not end within ${CARD_RUN_MS / 1000}s`);
    if (!await expect(failed).toContainText('output file is over the 64 KB cap', { timeout: CARD_SHOW_MS }).then(() => true, () => false)) {
      return result(id, FAIL, `an oversize output does not read "output file is over the 64 KB cap"; the card says "${firstLine(await card.innerText())}"`);
    }
    return result(id, PASS, 'a never-run card with no run on load; Refresh showed 2 items (literal <b>, one https: link, no javascript: link) '
      + 'with output exactly the written JSON and the noise in response; none in Home; exit 3 from the API read "exited 3" over stale items; '
      + 'not json read "Output not understood" with Ask ready; 70,000 bytes read the 64 KB cap');
  } finally {
    await switchMode(page, env, 'work').catch(() => {});
  }
}

const REFUSAL_WAIT_MS = 120000;
const RERUN_MS = 30000;
// A refusal as relay recorded it: macMCP's scope check, or relay's own gate.
const refusedRow = (r) => r.scopeViolation === true || DENIED_OUTCOMES.includes(r.outcome);
const rowsSaid = (rows) => [...new Set(rows.map((r) => `${r.tool} ${r.scopeViolation ? 'scope_violation' : r.outcome}`))].join(', ');
const sessionRow = async (env, sessionId) => (await eveJson(env, 'GET', '/api/sessions')).find((s) => s.id === sessionId);

// S3b-A11..A13 end to end: a Home thread asks for Work's mailbox, relay's audit
// shows the refusal, and "Ask in Work" reruns the question in Work's project.
async function askInOtherMode(env) {
  const id = 'ask-in-other-mode';
  const { acme, home } = env.world.projects;
  // Setup V2 missing is a FAIL, as in mode-presets and voice-deep-link.
  const stored = await eveJson(env, 'GET', '/api/projects');
  const unset = [['Work', 'work', acme], ['Home', 'home', home]]
    .filter(([, mode, p]) => !(stored.find((s) => s.id === p.id)?.defaultFor || []).includes(mode))
    .map(([label, , p]) => `${label} = ${p.name}`);
  if (unset.length) return result(id, FAIL, `not set in Relay → Projects → Default projects: ${unset.join(', ')} (setup V2)`);

  const page = await env.newPage();
  try {
    await openEve(page, env);
    await waitForModels(page, env);
    const models = await page.evaluate((pid) => window.client.state.modelsForProject(pid)
      .map((m) => ({ value: m.value, provider: m.provider })), home.id);
    const model = pickModel(models.map((m) => m.value), env.model);
    if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered in ${home.name}`);
    const provider = models.find((m) => m.value === model).provider;
    if (provider !== 'chat') return result(id, BLOCKED, `model ${model} is provider ${provider || 'none'}, not chat`);
    await page.evaluate((m) => localStorage.setItem('eve-ask-model', m), model);
    await switchMode(page, env, 'home');

    const homeIds = () => worldIds(env, [home], 'sessions');
    const homeBefore = await homeIds();
    const text = `verify-${env.nonce}: call mail_get_emails with account "${acme.name}", mailbox "INBOX" and limit 1, then tell me the subject.`;
    env.step('ask in Home');
    const input = page.getByTestId('today-ask-input');
    await need('Ask is not on Today', expect(input).toBeVisible({ timeout: 10000 }));
    const askedAt = Date.now() - 1000;
    await input.fill(text, { timeout: 5000 });
    await input.press('Enter', { timeout: 5000 });
    const made = await poll(async () => {
      const added = addedIds(homeBefore, await homeIds());
      return added.length ? added : null;
    }, { timeoutMs: 30000, intervalMs: 1000 });
    if (!made) return result(id, FAIL, `no ${home.name} session within 30s of Return`);
    if (made.length !== 1) return result(id, FAIL, `${made.length} new ${home.name} sessions, expected 1`);
    const homeSession = made[0];

    env.step('wait for a refused call in relay audit');
    let rows = [];
    const refusal = await poll(async () => {
      rows = await relayCallRows(env, home, askedAt).catch(() => rows);
      return rows.find(refusedRow) || null;
    }, { timeoutMs: REFUSAL_WAIT_MS, intervalMs: 2000 });
    if (!refusal) {
      return result(id, BLOCKED, `the model made no out-of-scope call within ${REFUSAL_WAIT_MS / 1000}s; `
        + `${home.name} tools called: ${rowsSaid(rows) || 'none'}`);
    }
    const refused = `relay refused ${rowsSaid([refusal])} in ${home.name}`;

    env.step('look for Ask in Work');
    const button = page.getByTestId('thread-ask-elsewhere');
    const offered = await expect(button).toBeVisible({ timeout: 10000 })
      .then(() => expect(button).toHaveText('Ask in Work', { timeout: 1000 })).then(() => true, () => false);
    if (!offered) return result(id, FAIL, `${refused}, but the thread shows no "Ask in Work" within 10s`);

    // The Home turn must be over, or its own reply would move messageCount.
    await need('the Home thread was still running after 30s',
      expect(page.getByTestId('chat-stop')).toBeHidden({ timeout: 30000 }));
    await sleep(1000);
    const homeRow = await sessionRow(env, homeSession);
    const acmeBefore = await acmeIds(env, 'sessions');
    env.step('Ask in Work');
    const clickedAt = Date.now() - 1000;
    const deadline = now() + RERUN_MS;
    await button.click({ timeout: 5000 });
    const created = await poll(async () => {
      const added = addedIds(acmeBefore, await acmeIds(env, 'sessions'));
      return added.length ? added : null;
    }, { timeoutMs: RERUN_MS, intervalMs: 1000 });
    if (!created) return result(id, FAIL, `${refused}; no ${acme.name} session within ${RERUN_MS / 1000}s of the click`);
    await sleep(1000);
    const rerun = addedIds(acmeBefore, await acmeIds(env, 'sessions'));
    if (rerun.length !== 1) return result(id, FAIL, `${refused}; ${rerun.length} new ${acme.name} sessions after the click, expected 1`);
    const isWork = await expect(page.getByTestId('mode-work')).toHaveAttribute('aria-checked', 'true', { timeout: left(deadline) })
      .then(() => true, () => false);
    if (!isWork) return result(id, FAIL, `${refused}; the mode is not Work after the click`);
    const hash = `#session/${rerun[0]}`;
    const opened = await expect.poll(() => new URL(page.url()).hash, { timeout: left(deadline) }).toBe(hash).then(() => true, () => false);
    if (!opened) return result(id, FAIL, `${refused}; the ${acme.name} thread did not open (${hash})`);
    let first = '';
    const same = await poll(async () => {
      first = (await thread(page).catch(() => [])).find((m) => m.who === 'message-user')?.text || '';
      return first === text;
    }, { timeoutMs: left(deadline), intervalMs: 500 });
    if (!same) return result(id, FAIL, `${refused}; the ${acme.name} thread's first user message is "${first.slice(0, 60)}", not the question`);

    env.step('read the Home thread back');
    const homeAfter = await sessionRow(env, homeSession);
    if (!homeAfter || homeAfter.projectId !== home.id || homeAfter.messageCount !== homeRow?.messageCount) {
      return result(id, FAIL, `${refused}; the ${home.name} thread changed after the click: `
        + `project ${homeAfter?.projectId || 'gone'}, messageCount ${homeRow?.messageCount} → ${homeAfter?.messageCount}`);
    }
    const acmeRows = await relayCallRows(env, acme, clickedAt).catch(() => []);
    return result(id, PASS, `${refused}; "Ask in Work" made one ${acme.name} thread in Work starting with the question; `
      + `the ${home.name} thread kept its project and ${homeAfter.messageCount} messages; `
      + `${acme.name} thread tools: ${rowsSaid(acmeRows) || 'none yet'}`);
  } finally {
    await switchMode(page, env, 'work').catch(() => {});
  }
}

// — Research with sources (S4) ------------------------------------------------

const RESEARCH = 'Research';
const RESEARCH_REPLY_MS = 120000;
const AUDIT_SETTLE_MS = 10000;

// The row's cards and the chips' numbers, in page order.
async function citationsShown(page) {
  const container = page.getByTestId('messages-container');
  const cards = await container.getByTestId('answer-sources').locator('[data-testid^="answer-source-"]')
    .evaluateAll((els) => els.map((el) => ({ testid: el.dataset.testid, text: el.innerText })));
  const chips = await container.locator('[data-testid^="cite-chip-"]').evaluateAll((els) => els.map((el) => el.dataset.testid));
  return { cards, chips };
}

// S4 end to end on the stub search MCP: relay's audit proves the model
// searched, then every assertion is about eve's rendering of what the tool
// returned. Model lapses are BLOCKED; the reply text is never the evidence.
async function researchCitations(env) {
  const id = 'research-citations';
  const stub = env.world.searchStub;
  if (!stub) return result(id, BLOCKED, 'fixture: the world publishes no usable search_stub');
  let Sources;
  try { Sources = require('../public/core/sources.js'); } catch (err) { return result(id, FAIL, `public/core/sources.js: ${firstLine(err)}`); }
  const expected = stubSources(stub, Sources);
  if (!expected.length) return result(id, BLOCKED, 'fixture: search_stub holds no http(s) result');

  const listed = (await eveJson(env, 'GET', '/api/projects')).filter((p) => p.name === RESEARCH);
  if (listed.length !== 1) return result(id, BLOCKED, `setup R1: ${listed.length} projects named ${RESEARCH}, expected 1`);
  const research = { name: RESEARCH, id: listed[0].id, path: listed[0].path };
  if (!isUnder(research.path, env.world.root)) {
    return result(id, BLOCKED, `setup R1: ${RESEARCH}'s folder is not under the world root (${env.world.root}); this journey sends and sweeps sessions there`);
  }

  const page = await env.newPage();
  const errors = captureErrors(page);
  await openEve(page, env);
  await waitForModels(page, env);
  const models = await page.evaluate((pid) => window.client.state.modelsForProject(pid)
    .map((m) => ({ value: m.value, provider: m.provider })), research.id);
  const model = pickModel(models.map((m) => m.value), env.model);
  if (!model) return result(id, BLOCKED, `setup R1: model "${env.model}" is not offered in ${RESEARCH}`);
  const provider = models.find((m) => m.value === model).provider;
  if (provider !== 'chat') return result(id, BLOCKED, `setup R1: model ${model} is provider ${provider || 'none'}, not chat`);

  // Research is test-world config (setup R1), so every session in it goes.
  env.cleanup(`delete the ${RESEARCH} session`, () => env.api.sweep([research]));
  const ids = () => worldIds(env, [research], 'sessions');
  const before = await ids();
  await openProject(page, env, research);
  const dialog = await openLauncher(page, env, research);
  env.step('open the Web Chat form');
  const card = dialog.getByTestId('shell-card-web-chat');
  if (!await card.click({ timeout: 10000 }).then(() => true, () => false)) {
    return result(id, BLOCKED, `setup R1: ${RESEARCH}'s launcher has no Web Chat card`);
  }
  const select = dialog.getByTestId('launcher-model-select');
  const offered = pickModel(await optionValues(select), env.model);
  if (!offered) return result(id, BLOCKED, `setup R1: the launcher does not offer "${env.model}" in ${RESEARCH}`);
  await select.selectOption(offered, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  const made = await poll(async () => {
    const added = addedIds(before, await ids());
    return added.length ? added : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!made) {
    const refusal = errors.find((e) => /template "chat"/.test(e));
    return refusal ? result(id, BLOCKED, `setup R1: launch refused: ${refusal}`) : result(id, FAIL, `no ${RESEARCH} session within 30s of Start Chat`);
  }
  if (made.length !== 1) return result(id, FAIL, `${made.length} new ${RESEARCH} sessions, expected 1`);
  const sessionId = made[0];

  const marker = `verify-${env.nonce}`;
  const input = page.getByTestId('chat-input');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  await input.fill(`${marker}: call ${stub.tool} once with query "${env.nonce}". `
    + 'Answer in two sentences, each ending with a markdown link to a result URL you used.', { timeout: 5000 });
  env.step('send the research question');
  const sentAt = Date.now() - 1000;
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  env.step('wait for the reply');
  const stop = page.getByTestId('chat-stop');
  const settled = await poll(async () => {
    const r = replyAfter(await thread(page), marker);
    return r.error || (r.reply && !(await stop.isVisible())) ? r : null;
  }, { timeoutMs: RESEARCH_REPLY_MS, intervalMs: 1000 });

  env.step('read relay audit for the search');
  let rows = [];
  const searched = await poll(async () => {
    rows = await relayCallRows(env, research, sentAt).catch(() => rows);
    return rows.find((r) => Sources.isSearchTool(r.tool) && r.outcome === 'ok') || null;
  }, { timeoutMs: AUDIT_SETTLE_MS, intervalMs: 1000 });
  if (!searched) {
    return result(id, BLOCKED, `model: no ok ${stub.tool} row in relay audit since the send; `
      + `${RESEARCH} tools called: ${rowsSaid(rows) || 'none'}${settled?.error ? `; thread error: ${settled.error}` : ''}`);
  }
  if (!settled) return result(id, FAIL, `relay audit has ${rowsSaid([searched])}, but no finished reply within ${RESEARCH_REPLY_MS / 1000}s`);
  if (settled.error) return result(id, FAIL, `relay audit has ${rowsSaid([searched])}, but the thread shows an error: ${settled.error}`);

  env.step('read the sources row');
  const row = page.getByTestId('messages-container').getByTestId('answer-sources');
  if (!await expect(row).toBeVisible({ timeout: 10000 }).then(() => true, () => false)) {
    return result(id, FAIL, `relay audit has ${rowsSaid([searched])}, but no answer-sources row shows within 10s of the reply`);
  }
  const live = await citationsShown(page);
  const rowProblem = sourcesRowProblem(live.cards, expected);
  if (rowProblem) return result(id, FAIL, rowProblem);
  if (!live.chips.length) {
    return result(id, BLOCKED, `model: the answer links no result URL, so there is no chip to open; reply: "${settled.reply.slice(0, 80)}"`);
  }

  const pop = page.getByTestId('cite-popover');
  for (const [i, testid] of live.chips.entries()) {
    const n = Number(testid.slice('cite-chip-'.length));
    const s = expected.find((x) => x.n === n);
    if (!s) return result(id, FAIL, `chip ${i + 1} (${testid}) names no source; sources are 1..${expected.length}`);
    env.step(`open chip ${i + 1} (${n})`);
    await page.getByTestId('messages-container').locator('[data-testid^="cite-chip-"]').nth(i).click({ timeout: 5000 });
    if (!await expect(pop).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) return result(id, FAIL, `chip ${n} opens nothing`);
    const shown = await pop.evaluate((el) => Object.fromEntries(['host', 'n', 'title', 'excerpt']
      .map((k) => [k, (el.querySelector(`.cite-${k}`)?.textContent || '').trim()])));
    const want = { host: s.host, n: String(n), title: s.title, excerpt: s.excerpt };
    const wrong = Object.keys(want).filter((k) => shown[k] !== want[k]);
    if (wrong.length) {
      return result(id, FAIL, `chip ${n}'s popover: ${wrong.map((k) => `${k} differs ${firstDifference(shown[k], want[k])}`).join('; ')}`);
    }
    await page.getByTestId('cite-close').click({ timeout: 5000 });
    await need(`chip ${n}'s popover did not close`, expect(pop).toBeHidden({ timeout: 5000 }));
  }

  // S4-A6: reopened from the project page, then reloaded.
  const again = await env.newPage();
  await openEve(again, env);
  const projectPage = await openProjectPage(again, env, research);
  env.step('reopen the thread');
  await need('the thread is not in the project page\'s Threads',
    projectPage.getByTestId(`project-thread-${sessionId}`).click({ timeout: 15000 }));
  for (const how of ['reopened', 'reloaded']) {
    if (how === 'reloaded') await reloadEve(again, env);
    env.step(`read the row (${how})`);
    const shownRow = again.getByTestId('messages-container').getByTestId('answer-sources');
    if (!await expect(shownRow).toBeVisible({ timeout: 20000 }).then(() => true, () => false)) {
      return result(id, FAIL, `${how}: no answer-sources row within 20s`);
    }
    const seen = await citationsShown(again);
    const problem = sourcesRowProblem(seen.cards, expected);
    if (problem) return result(id, FAIL, `${how}: ${problem}`);
    if (!isDeepStrictEqual(seen.chips, live.chips)) {
      return result(id, FAIL, `${how}: chips ${seen.chips.join(', ') || 'none'}, live ${live.chips.join(', ')}`);
    }
  }
  return result(id, PASS, `relay audit has ${rowsSaid([searched])}; row ${expected.map((s) => `${s.n} ${s.host}`).join(', ')}; `
    + `${live.chips.length} chips opened their source's title and excerpt; the same row and chips reopened and after a reload`);
}

// — Pasted-URL chips (docs/design-research.md) --------------------------------

const ASK_REPLY_MS = 30000;
const isFetchRow = (r) => r.tool === 'web_fetch' || r.tool.endsWith('__web_fetch');

// The user message holding `marker`, as a reader sees it: its URL chips, its
// text without the chip row, and everything it shows.
async function userBubble(page, marker, timeoutMs) {
  const bubble = page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: marker }).first();
  if (!await expect(bubble).toBeVisible({ timeout: timeoutMs }).then(() => true, () => false)) return null;
  return bubble.evaluate((el) => {
    const text = el.querySelector('.message-content')?.cloneNode(true);
    text?.querySelectorAll('.message-files').forEach((row) => row.remove());
    return {
      chips: [...el.querySelectorAll('[data-testid="message-url-chip"]')].map((c) => ({ label: c.textContent.trim(), title: c.title })),
      text: (text?.textContent || '').trim(),
      shown: el.innerText,
    };
  });
}

// One URL chip with the URL as its tooltip (and `label`, when given), the
// typed text, and never the sources block.
function bubbleProblem(seen, { text, url, label }) {
  if (!seen) return 'the question is not shown as a user message';
  if (seen.chips.length !== 1) return `the user message shows ${seen.chips.length} URL chips, expected 1`;
  const [chip] = seen.chips;
  if (chip.title !== url) return `the URL chip's tooltip is "${chip.title}", not ${url}`;
  if (label && chip.label !== label) return `the URL chip reads "${chip.label}", not "${label}"`;
  if (seen.shown.includes('Sources to read')) return 'the user message shows the "Sources to read" block';
  if (seen.text !== text) return `the user message reads "${seen.text.slice(0, 80)}", not the typed text`;
  return null;
}

// Reopened from the project page's Threads in a fresh page, then reloaded:
// `check(page, how)` returns a problem or null each time.
async function reopenAndReload(env, project, sessionId, check) {
  const again = await env.newPage();
  await openEve(again, env);
  const projectPage = await openProjectPage(again, env, project);
  env.step('reopen the thread');
  await need('the thread is not in the project page\'s Threads',
    projectPage.getByTestId(`project-thread-${sessionId}`).click({ timeout: 15000 }));
  for (const how of ['reopened', 'reloaded']) {
    if (how === 'reloaded') await reloadEve(again, env);
    env.step(`read the thread (${how})`);
    const problem = await check(again, how);
    if (problem) return `${how}: ${problem}`;
  }
  return null;
}

// A URL pasted into Today's Ask becomes a chip, travels as `urls`, and the
// thread shows it as a chip: live, reopened and reloaded. The reply is not
// evidence; the reopened chip can only come from the text eve stored.
async function askPastedUrl(env) {
  const id = 'ask-pasted-url';
  const acme = env.world.projects.acme;
  const noDefault = await workDefaultMissing(env, acme);
  if (noDefault) return result(id, FAIL, noDefault);
  const url = `https://docs.example/verify-${env.nonce}/guide`;
  const label = `docs.example/verify-${env.nonce}/guide`;
  const typed = `verify-${env.nonce} what does this page say?`;

  const page = await env.newPage();
  const frames = createFrames(page, 'user_input');
  await openEve(page, env);
  await waitForModels(page, env);
  const values = await page.evaluate((pid) => window.client.state.modelsForProject(pid).map((m) => m.value), acme.id);
  const model = pickModel(values, env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${acme.name}`);
  // Deliberate: Ask takes the model last used there (eve-ask-model), as in ask-about-file.
  await page.evaluate((m) => localStorage.setItem('eve-ask-model', m), model);
  await reloadEve(page, env);
  await switchMode(page, env, 'work');

  const input = page.getByTestId('today-ask-input');
  await need('Ask is not on Today', expect(input).toBeVisible({ timeout: 10000 }));
  env.step('paste the URL into Ask');
  await pasteText(page, input, url);
  const chip = page.getByTestId('today-ask-url-1');
  if (!await expect(chip).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) {
    return result(id, FAIL, `pasting ${url} into Ask made no chip (today-ask-url-1); the box holds "${(await input.inputValue()).slice(0, 80)}"`);
  }
  const chipLabel = (await chip.locator('.ask-chip__label').innerText({ timeout: 2000 }).catch(() => '')).trim();
  if (chipLabel !== label) return result(id, FAIL, `the Ask chip reads "${chipLabel}", not "${label}"`);
  if (await chip.getAttribute('title') !== url) return result(id, FAIL, `the Ask chip's tooltip is not ${url}`);
  const pasted = await input.inputValue();
  if (pasted !== '') return result(id, FAIL, `the paste also put "${pasted.slice(0, 60)}" in the Ask box`);

  const before = await acmeIds(env, 'sessions');
  env.step('ask');
  await page.keyboard.type(typed);
  await page.keyboard.press('Enter');
  const created = await poll(async () => addedIds(before, await acmeIds(env, 'sessions')).length > 0,
    { timeoutMs: ASK_REPLY_MS, intervalMs: 1000 });
  await sleep(1000);
  const made = addedIds(before, await acmeIds(env, 'sessions'));
  for (const sessionId of made) env.cleanup(`delete the ${acme.name} thread`, () => deleteSession(env, sessionId));
  if (!created) {
    const said = (await page.getByTestId('today-ask-status').innerText({ timeout: 2000 }).catch(() => '')).trim();
    return result(id, FAIL, `no ${acme.name} session within ${ASK_REPLY_MS / 1000}s of Return${said ? `; Ask says "${said}"` : ''}`);
  }
  if (made.length !== 1) return result(id, FAIL, `${made.length} new ${acme.name} sessions, expected 1`);

  env.step('read the user message');
  const live = bubbleProblem(await userBubble(page, typed, 15000), { text: typed, url, label });
  await page.getByTestId('chat-stop').click({ timeout: 2000 }).catch(() => {});
  if (live) return result(id, FAIL, live);
  if (frames.length !== 1) return result(id, FAIL, `Ask sent ${frames.length} user_input frames, expected 1`);
  if (!isDeepStrictEqual(frames[0].urls, [url]) || frames[0].text !== typed) {
    return result(id, FAIL, `user_input carried urls ${JSON.stringify(frames[0].urls)} and text "${String(frames[0].text).slice(0, 80)}", `
      + `not [${url}] and the typed text`);
  }

  const problem = await reopenAndReload(env, acme, made[0], async (again) =>
    bubbleProblem(await userBubble(again, typed, 20000), { text: typed, url, label }));
  if (problem) return result(id, FAIL, problem);
  return result(id, PASS, `Ask showed chip "${label}" and an empty box; one ${acme.name} thread; one user_input with the URL in urls; `
    + 'the user message showed the chip and the typed text only, live, reopened and reloaded');
}

// The `Research` project (setup R1), its id, path and a web chat in it with
// the run's model. Returns { research, page, sessionId } or a result to return.
async function researchChat(env, id) {
  const listed = (await eveJson(env, 'GET', '/api/projects')).filter((p) => p.name === RESEARCH);
  if (listed.length !== 1) return { verdict: result(id, BLOCKED, `setup R1: ${listed.length} projects named ${RESEARCH}, expected 1`) };
  const research = { name: RESEARCH, id: listed[0].id, path: listed[0].path };
  if (!isUnder(research.path, env.world.root)) {
    return { verdict: result(id, BLOCKED, `setup R1: ${RESEARCH}'s folder is not under the world root (${env.world.root}); this journey sends and sweeps sessions there`) };
  }
  const page = await env.newPage();
  const errors = captureErrors(page);
  await openEve(page, env);
  await waitForModels(page, env);
  env.cleanup(`delete the ${RESEARCH} session`, () => env.api.sweep([research]));
  const ids = () => worldIds(env, [research], 'sessions');
  const before = await ids();
  await openProject(page, env, research);
  const dialog = await openLauncher(page, env, research);
  env.step('open the Web Chat form');
  if (!await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 }).then(() => true, () => false)) {
    return { verdict: result(id, BLOCKED, `setup R1: ${RESEARCH}'s launcher has no Web Chat card`) };
  }
  const select = dialog.getByTestId('launcher-model-select');
  const offered = pickModel(await optionValues(select), env.model);
  if (!offered) return { verdict: result(id, BLOCKED, `setup R1: the launcher does not offer "${env.model}" in ${RESEARCH}`) };
  await select.selectOption(offered, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  const made = await poll(async () => {
    const added = addedIds(before, await ids());
    return added.length ? added : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!made) {
    const refusal = errors.find((e) => /template "chat"/.test(e));
    return { verdict: refusal ? result(id, BLOCKED, `setup R1: launch refused: ${refusal}`) : result(id, FAIL, `no ${RESEARCH} session within 30s of Start Chat`) };
  }
  if (made.length !== 1) return { verdict: result(id, FAIL, `${made.length} new ${RESEARCH} sessions, expected 1`) };
  return { research, page, sessionId: made[0] };
}

// The popover a source card or chip opens: its title and excerpt.
async function openedSource(page, target) {
  await target.click({ timeout: 5000 });
  const pop = page.getByTestId('cite-popover');
  if (!await expect(pop).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) return null;
  const shown = await pop.evaluate((el) => ({
    title: (el.querySelector('.cite-title')?.textContent || '').trim(),
    excerpt: (el.querySelector('.cite-excerpt')?.textContent || '').trim(),
  }));
  await page.getByTestId('cite-close').click({ timeout: 5000 });
  await need('the source popover did not close', expect(pop).toBeHidden({ timeout: 5000 }));
  return shown;
}

// A URL pasted into a Research chat is read with web_fetch (relay's audit and
// the page's own server both see it), and the page joins the sources row with
// its title and visible text. Model lapses are BLOCKED; the reply is not evidence.
async function chatPastedUrlSource(env) {
  const id = 'chat-pasted-url-source';
  const marker = `verify-${env.nonce}`;
  const title = `${marker} lighthouse`;
  const sentence = `The ${marker} lighthouse is painted green.`;
  const scriptMarker = `${marker}-script`;
  const server = await servePage(`/${marker}.html`, `<!doctype html><html><head><title>${title}</title></head>`
    + `<body><p>${sentence}</p><script>var seen = "${scriptMarker}";</script></body></html>`);
  env.cleanup('close the page server', () => server.close());

  const chat = await researchChat(env, id);
  if (chat.verdict) return chat.verdict;
  const { research, page, sessionId } = chat;
  const input = page.getByTestId('chat-input');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  env.step('paste the page URL');
  await pasteText(page, input, server.url);
  const chip = page.getByTestId('chat-url-1');
  if (!await expect(chip).toBeVisible({ timeout: 5000 }).then(() => true, () => false)) {
    return result(id, FAIL, `pasting ${server.url} into the chat made no chip (chat-url-1); the box holds "${(await input.inputValue()).slice(0, 80)}"`);
  }
  if (await chip.getAttribute('title') !== server.url) return result(id, FAIL, `the chat chip's tooltip is not ${server.url}`);
  const pasted = await input.inputValue();
  if (pasted !== '') return result(id, FAIL, `the paste also put "${pasted.slice(0, 60)}" in the chat box`);

  const typed = `${marker}: What colour is the lighthouse on this page? Answer in one sentence ending with a markdown link to the page.`;
  await page.keyboard.type(typed);
  env.step('send');
  const sentAt = Date.now() - 1000;
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  env.step('wait for the reply');
  const stop = page.getByTestId('chat-stop');
  const settled = await poll(async () => {
    const r = replyAfter(await thread(page), marker);
    return r.error || (r.reply && !(await stop.isVisible())) ? r : null;
  }, { timeoutMs: RESEARCH_REPLY_MS, intervalMs: 1000 });

  env.step('read relay audit for the fetch');
  let rows = [];
  await poll(async () => {
    rows = await relayCallRows(env, research, sentAt).catch(() => rows);
    return rows.some((r) => isFetchRow(r) && (r.outcome === 'ok' || DENIED_OUTCOMES.includes(r.outcome)));
  }, { timeoutMs: AUDIT_SETTLE_MS, intervalMs: 1000 });
  const fetches = rows.filter(isFetchRow);
  const fetched = fetches.find((r) => r.outcome === 'ok');
  const thrown = settled?.error ? `; thread error: ${settled.error}` : '';
  if (!fetches.length) return result(id, BLOCKED, `model: no web_fetch row in relay audit since the send; ${RESEARCH} tools called: ${rowsSaid(rows) || 'none'}${thrown}`);
  if (!fetched && fetches.some((r) => DENIED_OUTCOMES.includes(r.outcome))) {
    return result(id, BLOCKED, `setup R1b: relay refused ${rowsSaid(fetches)} in ${RESEARCH}`);
  }
  if (!fetched) return result(id, FAIL, `relay audit has ${rowsSaid(fetches)}, no ok web_fetch`);
  const read = server.hits.filter((h) => h.method === 'GET' && h.path === `/${marker}.html`);
  if (!read.length) return result(id, FAIL, `relay audit has ${rowsSaid([fetched])}, but the page server logged no GET of /${marker}.html`);
  if (!settled) return result(id, FAIL, `relay audit has ${rowsSaid([fetched])}, but no finished reply within ${RESEARCH_REPLY_MS / 1000}s`);
  if (settled.error) return result(id, FAIL, `relay audit has ${rowsSaid([fetched])}, but the thread shows an error: ${settled.error}`);

  // The page's card, its popover, and the bubble's chip: the same each time it is read.
  const sourceProblem = async (p, how) => {
    const card = p.getByTestId('messages-container').getByTestId('answer-sources').getByTestId('answer-source-1');
    if (!await expect(card).toBeVisible({ timeout: 20000 }).then(() => true, () => false)) return 'no answer-source-1 card within 20s of the reply';
    const problem = sourcesRowProblem([{ testid: 'answer-source-1', text: await card.innerText() }], [{ n: 1, host: '127.0.0.1' }]);
    if (problem) return problem;
    const shown = await openedSource(p, card);
    if (!shown) return 'answer-source-1 opens nothing';
    if (shown.title !== title) return `the source's title is "${shown.title}", not "${title}"`;
    if (!shown.excerpt.includes(sentence)) return `the source's excerpt does not hold the page's sentence: "${shown.excerpt.slice(0, 80)}"`;
    if (shown.excerpt.includes(scriptMarker)) return 'the source\'s excerpt holds the page\'s script';
    const cite = p.getByTestId('messages-container').getByTestId('cite-chip-1');
    if (how === 'live' && await cite.count()) {
      const viaChip = await openedSource(p, cite.first());
      if (!isDeepStrictEqual(viaChip, shown)) return `cite-chip-1 opens ${JSON.stringify(viaChip)}, not the card's source`;
    }
    return bubbleProblem(await userBubble(p, marker, 20000), { text: typed, url: server.url });
  };
  env.step('read the sources row');
  const live = await sourceProblem(page, 'live');
  if (live) return result(id, FAIL, live);
  const chipped = await page.getByTestId('messages-container').getByTestId('cite-chip-1').count() > 0;
  const problem = await reopenAndReload(env, research, sessionId, sourceProblem);
  if (problem) return result(id, FAIL, problem);
  return result(id, PASS, `relay audit has ${rowsSaid([fetched])}; the page server saw ${read.length} GET (${read[0].agent || 'no agent'}); `
    + `answer-source-1 is 127.0.0.1 with the page's title and text, not its script; ${chipped ? 'cite-chip-1 opens the same source' : 'the answer links no chip'}; `
    + 'the same row and bubble chip reopened and after a reload');
}

// — On the go (S6) ------------------------------------------------------------

const NOTIFICATIONS_FILE = 'notifications.jsonl';
const FAILED_RUN_MS = 20000;
const NOTIFY_WAIT_MS = 15000;
const SPEAK_WAIT_MS = 5000;

// The routine_failed lines for one task in eve's notifications file; none
// while the file does not exist. Unreadable lines are skipped.
async function notificationsFor(file, taskId) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = [];
  for (const line of text.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.kind === 'routine_failed' && o.taskId === taskId) lines.push(o);
  }
  return lines;
}

// S6-A1/A2 on the real stack: a routine run that fails, with no browser open,
// leaves exactly one line in the notifications file of eve-verify's data dir.
async function routineFailedNotifies(env) {
  const id = 'routine-failed-notifies';
  const acme = env.world.projects.acme;
  if (!env.dataDir) return result(id, BLOCKED, `no pinned data dir for ${env.service}`);
  const file = path.join(env.dataDir, NOTIFICATIONS_FILE);
  const name = `verify-${env.nonce}-fails`;
  const before = await acmeIds(env, 'tasks');
  removeNewTasks(env, before);

  // Deliberate: a terminal routine on a template that does not exist.
  // relayScheduler's failRun rejects it before any terminal or model exists,
  // so the failure needs no model and never varies.
  let taskId;
  let taskPath;
  try {
    env.step('create a routine that cannot start');
    await eveJson(env, 'POST', '/api/tasks', {
      name, projectId: acme.id, schedule: { type: 'on_demand' }, enabled: true, catchUp: false,
      sessionType: 'pty', templateId: `verify-missing-${env.nonce}`,
    });
    const made = addedIds(before, await acmeIds(env, 'tasks'));
    if (made.length !== 1) return result(id, BLOCKED, `${made.length} new ${acme.name} routines after POST /api/tasks, expected 1`);
    [taskId] = made;
    taskPath = `/api/tasks/${encodeURIComponent(taskId)}`;
    env.step('run it');
    await eveJson(env, 'POST', `${taskPath}/run`);
  } catch (err) {
    return result(id, BLOCKED, `could not set up the failing run: ${firstLine(err)}`);
  }

  env.step('wait for the run to fail');
  let status = '';
  const failed = await poll(async () => {
    status = (await eveJson(env, 'GET', taskPath).catch(() => null))?.lastStatus || status;
    return status === 'error';
  }, { timeoutMs: FAILED_RUN_MS, intervalMs: 1000 });
  if (!failed) return result(id, BLOCKED, `the run did not end in error within ${FAILED_RUN_MS / 1000}s (lastStatus ${status || 'none'})`);

  env.step('read the notifications file');
  const seen = await poll(async () => {
    const lines = await notificationsFor(file, taskId);
    return lines.length ? lines : null;
  }, { timeoutMs: NOTIFY_WAIT_MS, intervalMs: 500 });
  if (!seen) {
    return result(id, FAIL, `the run failed, but ${NOTIFICATIONS_FILE} holds no routine_failed line for it within ${NOTIFY_WAIT_MS / 1000}s`);
  }
  // A settle period, so a second line for the same run shows.
  await sleep(1000);
  const lines = await notificationsFor(file, taskId);
  if (lines.length !== 1) return result(id, FAIL, `${lines.length} routine_failed lines for the run, expected 1`);
  const want = { title: `Routine failed: ${name}`, url: '#routines' };
  const wrong = Object.keys(want).filter((k) => lines[0][k] !== want[k]);
  if (wrong.length) {
    return result(id, FAIL, wrong.map((k) => `${k} ${JSON.stringify(lines[0][k])}, want ${JSON.stringify(want[k])}`).join('; '));
  }
  return result(id, PASS, `the run failed (lastStatus error); one routine_failed line for it in ${NOTIFICATIONS_FILE}, `
    + `titled "${want.title}", url #routines`);
}

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// S6-A7 on a touch iPad: the last reply's Read aloud shows without a hover,
// is a thumb-sized target, and a tap sends the reply to be spoken. Audio is
// not judged.
async function listenOnTouch(env) {
  const id = 'listen';
  const t = env.shared.thread;
  if (!t) return result(id, BLOCKED, 'no thread from chat-reply');
  const page = await env.newPage({ device: DEVICES.ipadPortrait });
  const frames = createFrames(page, 'tts_speak');
  await openEve(page, env);
  env.step('open the thread from Continue');
  await need('the thread is not in Continue on Today',
    page.getByTestId('home-screen').getByTestId(`home-session-${t.sessionId}`).tap({ timeout: 15000 }));
  env.step('wait for the history');
  const opened = await poll(async () => {
    const r = replyAfter(await thread(page), t.question);
    return r.asked && r.reply ? r : null;
  }, { timeoutMs: 20000, intervalMs: 1000 });
  if (!opened) return result(id, FAIL, 'the thread\'s question and reply did not show within 20s of opening it from Continue');
  // A settle period, so the whole history is in before "last" is read.
  await sleep(1000);

  const reply = page.getByTestId('messages-container').getByTestId('message-assistant').last();
  const button = reply.getByRole('button', { name: 'Read aloud' });
  await need('the last reply has no "Read aloud" button', expect(button).toHaveCount(1, { timeout: 10000 }));
  // Deliberate: the pointer is parked off the thread, so no hover can be the reason it shows.
  await page.mouse.move(0, 0);
  env.step('look at Read aloud');
  await need('the last reply\'s "Read aloud" is not on screen', expect(button).toBeInViewport({ timeout: 5000 }));
  const look = () => button.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      opacity: Number(getComputedStyle(el).opacity), width: box.width, height: box.height,
      hovered: el.matches(':hover') || !!el.closest('.message')?.matches(':hover'),
    };
  });
  let seen = await look();
  if (seen.hovered) return result(id, BLOCKED, 'the pointer rests on the reply, so a hover cannot be ruled out');
  // A short wait, so an opacity transition can finish.
  await poll(async () => ((seen = await look()).opacity >= 0.99 ? seen : null), { timeoutMs: 2000, intervalMs: 250 });
  if (seen.opacity < 0.99) return result(id, FAIL, `"Read aloud" on the last reply has opacity ${seen.opacity} with no hover on a touch iPad`);
  if (seen.width < MIN_TARGET || seen.height < MIN_TARGET) {
    return result(id, FAIL, `"Read aloud" is ${Math.round(seen.width)}x${Math.round(seen.height)}, under 44x44`);
  }

  env.step('tap Read aloud');
  const from = frames.length;
  await button.tap({ timeout: 5000 });
  const sent = await poll(async () => frames.length > from, { timeoutMs: SPEAK_WAIT_MS, intervalMs: 200 });
  if (!sent) return result(id, FAIL, `no tts_speak frame left the page within ${SPEAK_WAIT_MS / 1000}s of the tap`);
  // A settle period, so a second frame for the one tap shows.
  await sleep(1000);
  const mine = frames.slice(from);
  if (mine.length !== 1) return result(id, FAIL, `${mine.length} tts_speak frames after one tap, expected 1`);
  const said = letters(mine[0].text);
  if (!said) return result(id, FAIL, 'the tts_speak frame carries no text');
  const shown = letters(await reply.locator('.message-content').innerText({ timeout: 5000 }));
  if (!shown.includes(said.slice(0, 40))) {
    return result(id, FAIL, `the tts_speak text "${String(mine[0].text).slice(0, 40)}" is not from the last reply`);
  }
  return result(id, PASS, `on a touch iPad the last reply's Read aloud shows with no hover at `
    + `${Math.round(seen.width)}x${Math.round(seen.height)}; a tap sent one tts_speak with its text`);
}

// — Agent board states (G6) ----------------------------------------------------

const BOARD_WITHIN_MS = 2000;
const GROUP_WORKING = 'today-agents-group-working';
const GROUP_DONE = 'today-agents-group-done';

// Every session_state frame the page's socket receives, with its arrival time.
// relay sends them to browsers that never joined, so a Today page sees them all.
function sessionStates(page) {
  const seen = [];
  const take = (m) => {
    if (m && m.type === 'session_state') seen.push({ sessionId: m.sessionId, state: m.state, at: Date.now() });
  };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { return; }
    if (frame.type === '__batch' && Array.isArray(frame.msgs)) frame.msgs.forEach(take);
    else take(frame);
  }));
  return seen;
}

// What the board shows for one session: its group, row and dot state, and
// whether the dot (or its ring) is running an animation. Null when no row.
async function boardRow(page, sessionId) {
  return page.getByTestId(`today-agent-${sessionId}`).evaluate((row) => {
    const dot = row.querySelector('.agent-row__dot');
    const animating = (cs) => cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0;
    return {
      group: row.closest('section.agent-board__group')?.dataset.testid || '',
      rowState: row.dataset.state,
      dotState: dot?.dataset.state || '',
      ring: !!dot && animating(getComputedStyle(dot, '::after')),
      pulse: !!dot && animating(getComputedStyle(dot)),
    };
  }, null, { timeout: 500 }).catch(() => null);
}

// Polls from now to `deadline` (at least one look) for a row that `ok` accepts.
async function boardRowBy(page, sessionId, deadline, ok) {
  let last = null;
  const hit = await poll(async () => {
    last = await boardRow(page, sessionId);
    return last && ok(last) ? last : null;
  }, { timeoutMs: Math.max(0, deadline - Date.now()), intervalMs: 100 });
  return { hit, last };
}

const rowSaid = (row) => (row
  ? `in ${row.group || 'no group'}, state ${row.rowState}, ring ${row.ring ? 'on' : 'off'}`
  : 'no row');

async function agentBoardStates(env) {
  const id = 'agent-board-states';
  const acme = env.world.projects.acme;
  const phone = await env.newPage({ device: DEVICES.phone });
  const frames = sessionStates(phone);
  const desktop = await env.newPage();
  const errors = captureErrors(desktop);

  await openEve(phone, env);
  await waitForModels(phone, env);
  env.step('wait for Today on the phone');
  await need('no greeting on the phone within 20s', expect(phone.getByTestId('home-screen').getByText(GREETING)).toBeVisible({ timeout: 20000 }));

  await openEve(desktop, env);
  await waitForModels(desktop, env);
  await openProject(desktop, env, acme);
  const before = await acmeIds(env, 'sessions');
  const dialog = await openLauncher(desktop, env);
  env.step('open the Web Chat form');
  await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 });
  const select = dialog.getByTestId('launcher-model-select');
  const offered = await optionValues(select);
  const model = pickModel(offered, 'haiku') || offered.find((v) => /haiku/i.test(v));
  if (!model) return result(id, BLOCKED, `no Haiku model is offered for ${acme.name}`);
  await select.selectOption(model, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  // Registered before the wait: a session that appears late is still deleted.
  env.cleanup(`delete the ${acme.name} agent session`, async () => {
    for (const sid of addedIds(before, await acmeIds(env, 'sessions'))) await deleteSession(env, sid);
  });

  env.step('wait for the session');
  const created = await poll(async () => {
    const added = addedIds(before, await acmeIds(env, 'sessions'));
    return added.length ? added : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!created) {
    const refusal = errors.find((e) => /template "/.test(e));
    return refusal ? result(id, BLOCKED, `launch refused: ${refusal}`) : result(id, FAIL, `no ${acme.name} session within 30s of Start Chat`);
  }
  if (created.length !== 1) return result(id, FAIL, `${created.length} new ${acme.name} sessions, expected 1`);
  const sid = created[0];

  const input = desktop.getByTestId('chat-input');
  env.step('wait for the composer');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  await input.fill(`Count from 1 to 300, one number per line. (verify ${env.nonce})`, { timeout: 5000 });
  env.step('send the count request');
  const sentAt = Date.now();
  await desktop.getByTestId('chat-submit').click({ timeout: 5000 });
  await need('the count request is not shown as the user message', expect(
    desktop.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: env.nonce }),
  ).toBeVisible({ timeout: 10000 }));

  const problems = [];
  const frameOf = (state, since) => frames.find((f) => f.sessionId === sid && f.state === state && f.at >= since);

  env.step('wait for the running frame');
  const running = await poll(async () => frameOf('running', sentAt), { timeoutMs: 30000, intervalMs: 100 });
  if (!running) return result(id, FAIL, `no running session_state frame for the session within 30s of the question (saw ${[...new Set(frames.filter((f) => f.sessionId === sid).map((f) => f.state))].join(', ') || 'none'})`);
  env.step('look for the running row on the phone');
  const working = await boardRowBy(phone, sid, running.at + BOARD_WITHIN_MS,
    (r) => r.group === GROUP_WORKING && r.rowState === 'running' && r.dotState === 'running' && r.ring);
  if (!working.hit) problems.push(`step 4: ${BOARD_WITHIN_MS / 1000}s after the running frame the row was ${rowSaid(working.last)}`);

  env.step('click Stop');
  const stop = desktop.getByTestId('chat-stop');
  // BLOCKED only on evidence the turn ended (an idle frame after running); otherwise a missing Stop is a FAIL.
  const blocked = () => (problems.length || !frameOf('idle', running.at) ? null
    : result(id, BLOCKED, 'the count finished before Stop could be clicked'));
  const noStop = () => blocked() || result(id, FAIL, [...problems, 'Stop was not showing while the turn was running'].join('; '));
  if (!await stop.isVisible()) return noStop();
  const stoppedAt = Date.now();
  if (!await stop.click({ timeout: 2000 }).then(() => true, () => false)) {
    if (!await stop.isVisible()) return noStop();
    return result(id, FAIL, 'Stop is showing but could not be clicked');
  }

  env.step('wait for the ended frame');
  const ended = await poll(async () => frameOf('ended', stoppedAt), { timeoutMs: 30000, intervalMs: 100 });
  if (!ended) {
    problems.push(`step 6: no ended session_state frame within 30s of Stop (saw ${[...new Set(frames.filter((f) => f.sessionId === sid && f.at >= stoppedAt).map((f) => f.state))].join(', ') || 'none'})`);
  } else {
    env.step('look for the ended row on the phone');
    const done = await boardRowBy(phone, sid, ended.at + BOARD_WITHIN_MS,
      (r) => r.group === GROUP_DONE && r.rowState === 'ended' && !r.ring && !r.pulse);
    if (!done.hit) problems.push(`step 6: ${BOARD_WITHIN_MS / 1000}s after the ended frame the row was ${rowSaid(done.last)}${done.last && (done.last.ring || done.last.pulse) ? ', its dot still animating' : ''}`);
  }

  env.step('compare the badge with Needs you');
  const badge = phone.getByTestId('nav-today-badge');
  const needsRows = phone.locator('[data-testid="today-agents-group-needs"] [data-testid^="today-agent-"]');
  let counted = '';
  const agree = await poll(async () => {
    const n = await needsRows.count();
    const shown = await badge.evaluate((el) => ({ hidden: el.hidden || getComputedStyle(el).display === 'none', n: el.firstElementChild?.textContent || '' }), null, { timeout: 1000 }).catch(() => null);
    if (!shown) return null;
    counted = `${n} rows in Needs you, badge ${shown.hidden ? 'hidden' : shown.n}`;
    return (n === 0 ? shown.hidden : !shown.hidden && shown.n === String(n)) ? { n } : null;
  }, { timeoutMs: 3000, intervalMs: 250 });
  if (!agree) problems.push(`step 7: ${counted || 'no badge on the phone Today button'}`);

  env.step('tap the row');
  const tapped = await phone.getByTestId(`today-agent-${sid}`).tap({ timeout: 5000 }).then(() => true, () => false);
  if (!tapped) problems.push('step 8: the row could not be tapped');
  else {
    const hash = `#session/${sid}`;
    const opened = await expect.poll(() => new URL(phone.url()).hash, { timeout: 5000 }).toBe(hash).then(() => true, () => false);
    const asked = await expect(phone.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: env.nonce }))
      .toBeVisible({ timeout: 15000 }).then(() => true, () => false);
    if (!opened) problems.push(`step 8: the address is ${new URL(phone.url()).hash || 'empty'} after the tap, not ${hash}`);
    else if (!asked) problems.push('step 8: the thread did not show the question after the tap');
  }

  if (problems.length) return result(id, FAIL, `${problems.join('; ')} (model ${model})`);
  return result(id, PASS, `model ${model}: running row in Working with its ring within ${BOARD_WITHIN_MS / 1000}s; after Stop the row in Done with no animation; `
    + `badge matched Needs you (${agree.n}); a tap opened the thread with the question`);
}

// — Agent drop-in (relay#239) --------------------------------------------------

const DROP_IN_INIT_MODEL = 'claude-haiku-5-5';
const DROP_IN_ROW_WITHIN_MS = 2000;
const DROP_IN_TAB_WITHIN_MS = 75000;
const DROP_IN_IDLE_WITHIN_MS = 15000;

// The harness's own eve socket, authenticated as the run's owner. Deliberate: a
// second socket, not the page's, because create_session joins the new session
// on the socket that made it, and only a joined socket gets its llm_event
// frames. Like EveApi._connect it is ready only once a terminal_list answers:
// eve drops anything sent before its upstream relay socket is open.
function openEveSocket(env) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env.url.replace(/\/+$/, '').replace(/^http/, 'ws'));
    const frames = [];
    const send = (msg) => ws.send(JSON.stringify(msg));
    let poller = null;
    let ready = false;
    const fail = (err) => { clearInterval(poller); clearTimeout(timer); ws.terminate(); reject(err); };
    const timer = setTimeout(() => fail(new Error('eve WebSocket never reached relay within 10s')), 10000);
    ws.on('open', () => send({ type: 'auth', token: env.session.token }));
    ws.on('error', (err) => fail(new Error(`eve WebSocket: ${err.message}`)));
    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      for (const msg of frame.type === '__batch' && Array.isArray(frame.msgs) ? frame.msgs : [frame]) {
        if (msg.type === 'auth_failed') return fail(new Error('eve refused WebSocket auth'));
        if (msg.type === 'error' && !ready && !poller) return fail(new Error(`eve: ${msg.message}`));
        if (msg.type === 'auth_success') {
          poller = setInterval(() => send({ type: 'terminal_list' }), 500);
          send({ type: 'terminal_list' });
        } else if (msg.type === 'terminal_list' && !ready) {
          ready = true;
          clearInterval(poller);
          clearTimeout(timer);
          resolve({ send, frames, close: () => ws.close() });
        }
        frames.push({ ...msg, at: Date.now() });
      }
    });
  });
}

// Pids of the claude children of the relay-sessions shim for relay session
// `sid`. relay-sessions launches claude through `relay-sessions exec
// --session-id <sid> ... -- <path>/claude ...` and keeps it as a child, so the
// shim is found by its exact id token and claude by ppid. The executable is
// the text before the first flag, so a sibling that merely carries the id is
// not matched.
function claudePidsFor(psOut, sid) {
  const rows = String(psOut).split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
  const marker = `exec --session-id ${sid}`;
  const shims = new Set(rows.filter((r) => {
    const at = r.command.indexOf(marker);
    return at >= 0 && (r.command.length === at + marker.length || r.command[at + marker.length] === ' ');
  }).map((r) => r.pid));
  return rows.filter((r) => {
    if (!shims.has(r.ppid)) return false;
    const exe = r.command.split(' --')[0].trim();
    return /(^|\/)claude$/.test(exe);
  }).map((r) => r.pid);
}

async function agentDropIn(env) {
  const id = 'agent-drop-in';
  const acme = env.world.projects.acme;
  const name = `verify-${env.nonce}-dropin`;
  const marker = `verify-${env.nonce}-done`;
  const desktop = await env.newPage();
  const states = sessionStates(desktop);
  await openEve(desktop, env);
  await waitForModels(desktop, env);
  env.step('wait for Today');
  await need('no greeting within 20s', expect(desktop.getByTestId('home-screen').getByText(GREETING)).toBeVisible({ timeout: 20000 }));

  const offered = await desktop.evaluate((pid) => (window.client.state.modelsForProject(pid) || []).map((m) => m.value), acme.id);
  // Exact id on purpose: relay takes over only Claude sessions, and only the
  // bare `haiku` id makes one (relay's deriveSessionKind).
  const model = offered.find((v) => v === 'haiku') || null;
  if (!model) return result(id, BLOCKED, `the haiku model id is not offered for ${acme.name}`);

  const sessionsBefore = await acmeIds(env, 'sessions');
  const terminalsBefore = await acmeIds(env, 'terminals');
  let sock = null;
  // Registered before the session exists: whatever appeared is closed and deleted, even on a failure path.
  env.cleanup(`close the drop-in terminal and delete the ${acme.name} agent session`, async () => {
    if (sock) sock.close();
    let failure = null;
    for (const tid of addedIds(terminalsBefore, await acmeIds(env, 'terminals'))) {
      await env.api.closeTerminal(tid).catch((err) => { failure = failure || err; });
    }
    for (const sid of addedIds(sessionsBefore, await acmeIds(env, 'sessions'))) {
      await deleteSession(env, sid).catch((err) => { failure = failure || err; });
    }
    if (failure) throw failure;
  });

  env.step('create the headless agent session');
  sock = await openEveSocket(env);
  sock.send({ type: 'create_session', projectId: acme.id, model, name, settings: { headless: true, agent: true } });
  const made = await poll(async () => sock.frames.find((f) => f.type === 'session_created' || f.type === 'error') || null,
    { timeoutMs: 60000, intervalMs: 200 });
  if (!made) return result(id, FAIL, `no session_created within 60s of create_session (model ${model})`);
  if (made.type === 'error') {
    return /template "/.test(String(made.message))
      ? result(id, BLOCKED, `launch refused: ${made.message}`)
      : result(id, FAIL, `create_session failed: ${made.message}`);
  }
  const sid = made.sessionId;
  sock.send({ type: 'join_session', sessionId: sid });

  const frameOf = (state, since) => states.find((f) => f.sessionId === sid && f.state === state && f.at >= since);
  const seen = (since) => [...new Set(states.filter((f) => f.sessionId === sid && f.at >= since).map((f) => f.state))].join(', ') || 'none';

  env.step('send turn 1');
  const firstAt = Date.now();
  sock.send({ type: 'user_input', sessionId: sid, text: `Reply with exactly: ${marker}` });
  const firstEnd = await poll(async () => frameOf('idle', firstAt) || frameOf('errored', firstAt) || null, { timeoutMs: 90000, intervalMs: 200 });
  if (!firstEnd) return result(id, FAIL, `session ${sid}: turn 1 did not end within 90s (states ${seen(firstAt)})`);
  if (firstEnd.state !== 'idle') return result(id, FAIL, `session ${sid}: turn 1 ended ${firstEnd.state}, not idle`);
  const init = sock.frames.find((f) => f.type === 'llm_event' && f.event?.type === 'system' && f.event?.subtype === 'init');
  if (!init) return result(id, FAIL, `session ${sid}: no system/init event after turn 1`);
  if (init.event.model !== DROP_IN_INIT_MODEL) return result(id, BLOCKED, `session ${sid}: system/init reported model ${init.event.model}, not ${DROP_IN_INIT_MODEL}`);

  env.step('send turn 2');
  const secondAt = Date.now();
  sock.send({ type: 'user_input', sessionId: sid, text: 'Count from 1 to 300, one number per line.' });
  const running = await poll(async () => frameOf('running', secondAt), { timeoutMs: 30000, intervalMs: 50 });
  if (!running) return result(id, FAIL, `session ${sid}: no running frame within 30s of turn 2 (states ${seen(secondAt)})`);

  // Fault injection on the test machine. Deliberate: the kill lands mid-turn, since an idle session whose process exits reads ended, not errored.
  env.step('kill the claude process mid-turn');
  let pids = [];
  await poll(async () => {
    pids = claudePidsFor((await exec('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 << 20, timeout: 10000 })).stdout, sid);
    return pids.length;
  }, { timeoutMs: 3000, intervalMs: 100 });
  if (!pids.length) return result(id, FAIL, `session ${sid}: no claude child of the relay-sessions shim`);
  for (const pid of pids) process.kill(pid, 'SIGKILL');

  env.step('wait for the errored frame');
  const errored = await poll(async () => frameOf('errored', running.at), { timeoutMs: 30000, intervalMs: 50 });
  if (!errored) {
    const finished = frameOf('idle', running.at);
    return result(id, FAIL, `session ${sid}: no errored frame within 30s of the kill${finished ? ' (the turn had already gone idle, so the kill missed it)' : ''} (states ${seen(secondAt)})`);
  }

  env.step('look for Drop in under Needs you');
  const drop = desktop.locator('[data-testid="today-agents-group-needs"]').getByTestId(`today-drop-in-${sid}`);
  await need(`${DROP_IN_ROW_WITHIN_MS / 1000}s after the errored frame no Drop in showed under Needs you for session ${sid}`,
    expect(drop).toBeVisible({ timeout: Math.max(200, errored.at + DROP_IN_ROW_WITHIN_MS - Date.now()) }));
  env.step('click Drop in');
  const clickedAt = Date.now();
  await drop.click({ timeout: 5000 });

  const label = `${name} (drop-in)`;
  env.step('wait for the drop-in terminal tab');
  // A refusal toast ends the wait early and goes into the FAIL detail.
  const toastText = async () => (await desktop.locator('.toast__message').allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean).join(' | ');
  const tabShown = await poll(async () => {
    if (await desktop.locator('.tab.active .tab-label').filter({ hasText: label }).count()) return 'tab';
    return (await toastText()) ? 'toast' : null;
  }, { timeoutMs: DROP_IN_TAB_WITHIN_MS, intervalMs: 250 });
  if (tabShown !== 'tab') {
    const shown = await toastText();
    return result(id, FAIL, `session ${sid}: no active tab "${label}" within ${DROP_IN_TAB_WITHIN_MS / 1000}s of Drop in${shown ? ` (toast: ${shown})` : ''}`);
  }
  const pane = desktop.locator('#terminal');
  let answered = false;
  env.step('wait for the conversation in the terminal');
  const carried = await poll(async () => {
    // xterm wraps rows even mid-word, so the text is compared with whitespace gone.
    // The visible rows plus the whole scrollback buffer, so scrolling cannot hide the marker.
    const visible = await pane.innerText({ timeout: 2000 }).catch(() => '');
    const buffered = await desktop.evaluate(() => {
      const b = window.client?.terminalManager?.activeTerm?.()?.buffer?.active;
      if (!b) return '';
      let out = '';
      for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) || '') + '\n';
      return out;
    }).catch(() => '');
    const flat = `${visible}${buffered}`.replace(/\s+/g, '');
    if (flat.includes(marker)) return true;
    if (!answered && /trust/i.test(flat)) {
      answered = true;
      await pane.locator('.xterm-screen').filter({ visible: true }).last().click({ timeout: 5000 });
      await desktop.keyboard.press('Enter');
    }
    return null;
  }, { timeoutMs: Math.max(1, clickedAt + DROP_IN_TAB_WITHIN_MS - Date.now()), intervalMs: 500 });
  if (!carried) return result(id, FAIL, `session ${sid}: "${marker}" is not in the drop-in terminal within ${DROP_IN_TAB_WITHIN_MS / 1000}s of Drop in${answered ? ' (a trust prompt was answered)' : ''}`);

  const opened = addedIds(terminalsBefore, await acmeIds(env, 'terminals'));
  if (opened.length !== 1) return result(id, FAIL, `session ${sid}: ${opened.length} new ${acme.name} terminals after Drop in, expected 1`);

  env.step('close the tab');
  const closedAt = Date.now();
  await desktop.locator('.tab.active .tab-close').click({ timeout: 5000 });
  const problems = [];
  env.step('wait for idle after the close');
  if (!await poll(async () => frameOf('idle', closedAt), { timeoutMs: DROP_IN_IDLE_WITHIN_MS, intervalMs: 100 })) {
    problems.push(`no idle frame within ${DROP_IN_IDLE_WITHIN_MS / 1000}s of closing the tab (states ${seen(closedAt)})`);
  }
  env.step('wait for the terminal to leave relay\'s list');
  if (!await poll(async () => !(await acmeIds(env, 'terminals')).includes(opened[0]), { timeoutMs: DROP_IN_IDLE_WITHIN_MS, intervalMs: 500 })) {
    problems.push(`terminal ${opened[0]} is still in relay's list ${DROP_IN_IDLE_WITHIN_MS / 1000}s after closing the tab`);
  }
  if (problems.length) return result(id, FAIL, `session ${sid}: ${problems.join('; ')}`);
  return result(id, PASS, `model ${model}: after a mid-turn kill Drop in showed under Needs you within ${DROP_IN_ROW_WITHIN_MS / 1000}s; `
    + `it opened "${label}" with the conversation (${marker}); closing the tab brought back idle and ended the terminal`);
}

// — Chief of Staff (G6) --------------------------------------------------------

// Relay's model value for Claude Haiku (internal/sessions/api/models.go); the
// session's system/init reports it as COS_MODEL_ID.
const COS_MODEL = 'haiku';
const COS_MODEL_ID = 'claude-haiku-5-5';
// The Chief of Staff's own project; its session runs in that folder.
const COS_PROJECT_NAME = 'Verify Chief of Staff';
const COS_POST_WITHIN_MS = 90000;
const COS_SENT_WITHIN_MS = 60000;

// The newest Chief of Staff status the page's socket carried (a snapshot's or a
// cos_status frame's), and every cos_post frame, in arrival order.
function cosFrames(page) {
  // idleAt: how many posts had arrived at each cos_status frame with busy:false.
  const seen = { status: null, posts: [], idleAt: [] };
  const take = (m) => {
    if (!m) return;
    if ((m.type === 'cos_snapshot' || m.type === 'cos_status') && m.status) seen.status = m.status;
    if (m.type === 'cos_status' && m.status && m.status.busy === false) seen.idleAt.push(seen.posts.length);
    if (m.type === 'cos_post' && m.post) seen.posts.push(m.post);
  };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { return; }
    if (frame.type === '__batch' && Array.isArray(frame.msgs)) frame.msgs.forEach(take);
    else take(frame);
  }));
  return seen;
}

// A listed Claude Haiku session in the project, in default permission mode,
// made over a socket of eve's own so it can carry a name. A cleanup registered
// before the wait deletes every session the call added, whatever the verdict.
// Returns the id, or null when none was listed within 30 s.
async function startCosAgent(env, name) {
  const project = env.world.projects.acme;
  const before = await acmeIds(env, 'sessions');
  env.cleanup(`delete the ${project.name} agent session`, async () => {
    for (const sid of addedIds(before, await acmeIds(env, 'sessions'))) await deleteSession(env, sid);
  });
  env.step('start the agent session');
  const conn = await env.api._connect();
  try {
    conn.send({ type: 'create_session', projectId: project.id, model: COS_MODEL, name, settings: { permissionMode: 'default' } });
    const added = await poll(async () => {
      const ids = addedIds(before, await acmeIds(env, 'sessions'));
      return ids.length ? ids : null;
    }, { timeoutMs: 30000, intervalMs: 1000 });
    return added && added.length === 1 ? { id: added[0] } : { count: added ? added.length : 0 };
  } finally {
    conn.close();
  }
}

// Opens the session by its address and sends one message from its composer.
async function sayToAgent(page, env, sessionId, text, marker) {
  await openEve(page, env, `#session/${sessionId}`);
  const input = page.getByTestId('chat-input');
  env.step('wait for the composer');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  await input.fill(text, { timeout: 5000 });
  env.step('send the message');
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  await need('the message is not shown as the user message', expect(
    page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: marker }),
  ).toBeVisible({ timeout: 10000 }));
}

async function openChiefOfStaff(page, env) {
  env.step('open Chief of Staff');
  await page.getByTestId('sidebar-chief-of-staff').click({ timeout: 10000 });
  await need('the Chief of Staff thread did not open', expect(page.getByTestId('cos-page')).toBeVisible({ timeout: 10000 }));
}

async function cosAskingPost(env) {
  const id = 'cos-asking-post';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const page = await env.newPage();
  const seen = cosFrames(page);
  const made = await startCosAgent(env, `verify-${env.nonce} asker`);
  if (!made.id) return result(id, FAIL, `${made.count || 'no'} new sessions within 30s of create_session, expected 1`);
  const sid = made.id;

  // The request goes from a page of its own: a page that has joined the
  // session shows its permission prompt as a modal over the thread.
  const asker = await env.newPage();
  await sayToAgent(asker, env, sid,
    `Run this shell command with your Bash tool, then show me its output: echo verify-${env.nonce}`, env.nonce);
  const askedAt = now();
  // Left open until the end: relay may settle a permission request once no
  // browser holds the session, and the asking state would end before the post.
  env.cleanup('close the asking page', () => asker.close());
  await openEve(page, env);
  await openChiefOfStaff(page, env);

  env.step('wait for the post');
  const card = page.locator(`[data-testid^="cos-card-"][data-session-id="${sid}"][data-state="asking"]`);
  const posted = await poll(async () => (await card.count() > 0 ? await card.first().getAttribute('data-testid') : null),
    { timeoutMs: COS_POST_WITHIN_MS, intervalMs: 500 });
  if (!posted) {
    const states = [...new Set(await page.locator(`[data-testid^="cos-card-"][data-session-id="${sid}"]`).evaluateAll((els) => els.map((e) => e.dataset.state)))];
    return result(id, FAIL, `no post with a card for the session in state asking within ${COS_POST_WITHIN_MS / 1000}s of the request `
      + `(cards for it: ${states.join(', ') || 'none'}; ${page.url().includes('#chief-of-staff') ? 'thread open' : 'thread not open'})`);
  }
  const postId = posted.slice('cos-card-'.length);
  const tookS = seconds(askedAt);
  const problems = [];

  env.step('look at the post');
  const post = page.getByTestId(`cos-post-${postId}`);
  if (await post.getByTestId(`cos-card-${postId}`).count() !== 1) problems.push('the card is not inside its post');
  for (const act of ['answer', 'drop-in', 'open']) {
    if (await page.getByTestId(`cos-${act}-${postId}`).count() !== 1) problems.push(`the card has no ${act} button`);
  }
  if (await page.getByTestId('cos-off').isVisible()) {
    problems.push(`the thread says it is off: "${(await page.getByTestId('cos-off').innerText()).trim()}"`);
  }
  // The model id arrives with the first model turn; allow it a moment.
  await poll(async () => seen.status && seen.status.model, { timeoutMs: 5000, intervalMs: 250 });
  const model = seen.status && seen.status.model;
  if (model !== COS_MODEL_ID) problems.push(`the Chief of Staff model is ${model ? `"${model}"` : 'not reported'}, not ${COS_MODEL_ID}`);

  env.step('click Open');
  await page.getByTestId(`cos-open-${postId}`).click({ timeout: 5000 }).catch(() => problems.push('Open could not be clicked'));
  const hash = `#session/${sid}`;
  const landed = await expect.poll(() => new URL(page.url()).hash, { timeout: 10000 }).toBe(hash).then(() => true, () => false);
  const tabbed = landed && await expect(page.getByTestId(`tab-${sid}`)).toBeVisible({ timeout: 15000 }).then(() => true, () => false);
  const shown = tabbed && await expect(page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: env.nonce }))
    .toBeVisible({ timeout: 15000 }).then(() => true, () => false);
  if (!landed) problems.push(`the address is ${new URL(page.url()).hash || 'empty'} after Open, not ${hash}`);
  else if (!tabbed) problems.push('Open changed the address but no tab opened for the session');
  else if (!shown) problems.push('Open landed on the session but its thread does not show the request');

  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `a post with an asking card for the session within ${tookS}s, with Answer, Drop in and Open; `
    + `the Chief of Staff ran on ${model}; Open landed on the session`);
}

// The audit rows `relay audit` holds for one session_message target.
async function sessionMessageRows(env, sessionId) {
  const args = ['audit', '--event', 'session_message', '--grep', sessionId, '--json', '--tail', '50'];
  const { stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 32 << 20 });
  const rows = [];
  for (const line of stdout.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.event !== 'session_message') continue;
    const a = o.args && typeof o.args === 'object' ? o.args : {};
    if (a.session_id === sessionId) rows.push({ phase: o.phase, outcome: o.outcome, origin: a.origin, id: o.id });
  }
  return rows;
}

// Null when the pair is as a send through the Chief of Staff leaves it.
function sessionMessageProblem(rows) {
  const intents = rows.filter((r) => r.phase === 'intent');
  const dones = rows.filter((r) => r.phase === 'completion');
  if (intents.length !== 1 || dones.length !== 1) return `${intents.length} intent and ${dones.length} completion session_message rows for the session, want 1 and 1`;
  const bad = [...intents, ...dones].find((r) => r.origin !== 'chief-of-staff');
  if (bad) return `a ${bad.phase} row has origin "${bad.origin || ''}", want chief-of-staff`;
  if (!intents[0].id || intents[0].id !== dones[0].id) return 'the intent and completion rows do not share one id';
  if (dones[0].outcome !== 'ok') return `the completion row's outcome is ${dones[0].outcome}, want ok`;
  return null;
}

async function cosTellSendsMarked(env) {
  const id = 'cos-tell-sends-marked';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const name = `verify-${env.nonce} target`;
  const marker = `verify-${env.nonce}-cos`;
  const page = await env.newPage();
  const made = await startCosAgent(env, name);
  if (!made.id) return result(id, FAIL, `${made.count || 'no'} new sessions within 30s of create_session, expected 1`);
  const sid = made.id;

  await sayToAgent(page, env, sid, `Reply with the single word ready. (verify ${env.nonce})`, env.nonce);
  env.step('wait for the agent\'s turn to finish');
  const stop = page.getByTestId('chat-stop');
  const turn = await poll(async () => {
    const r = replyAfter(await thread(page), env.nonce);
    if (r.error) return r;
    return r.reply && !(await stop.isVisible()) ? r : null;
  }, { timeoutMs: 60000, intervalMs: 1000 });
  if (!turn) return result(id, FAIL, 'the agent finished no turn within 60s');
  if (turn.error) return result(id, FAIL, `error in the agent's thread: ${turn.error}`);

  await openChiefOfStaff(page, env);
  // Deliberate: the text to send is the bare marker, so any copy the model
  // makes is the person's own words and provenance sends it at once (#253).
  const tell = `Tell ${name}: ${marker}`;
  const input = page.getByTestId('cos-input');
  await input.fill(tell, { timeout: 5000 });
  env.step('press Return');
  await input.press('Enter');
  const modal = page.locator('.dialog:not(.hidden), [role="dialog"], [aria-modal="true"]');
  let modalSeen = false;
  const sentPost = page.locator('[data-testid^="cos-post-"][data-kind="sent"]').filter({ hasText: name });
  const failedPost = page.locator('[data-testid^="cos-post-"][data-kind="send_failed"]');
  env.step('wait for the Sent post');
  const outcome = await poll(async () => {
    if (await modal.first().isVisible().catch(() => false)) modalSeen = true;
    if (await sentPost.count() > 0) return 'sent';
    if (await failedPost.count() > 0) return 'failed';
    return null;
  }, { timeoutMs: COS_SENT_WITHIN_MS, intervalMs: 250 });
  if (outcome === 'failed') {
    const said = (await failedPost.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    return result(id, FAIL, `the thread posted a failed send instead of a Sent post: "${said}"`);
  }
  if (!outcome) return result(id, FAIL, `no Sent post naming "${name}" within ${COS_SENT_WITHIN_MS / 1000}s of Return`);
  const problems = [];
  if (modalSeen) problems.push('a dialog showed between Return and the Sent post');
  if (await sentPost.first().getByTestId('cos-sent-chip').count() !== 1) problems.push('the Sent post has no "Sent by Chief of Staff" chip');

  env.step('read relay audit');
  let rows = [];
  const audited = await poll(async () => {
    rows = await sessionMessageRows(env, sid).catch(() => []);
    return rows.some((r) => r.phase === 'completion') ? rows : null;
  }, { timeoutMs: 10000, intervalMs: 500 });
  const auditProblem = sessionMessageProblem(audited || rows);
  if (auditProblem) problems.push(`relay audit: ${auditProblem}`);

  env.step('open the agent\'s thread');
  const other = await env.newPage();
  await openEve(other, env, `#session/${sid}`);
  const chip = other.getByTestId('message-origin-chip');
  const chipped = await expect(chip.first()).toBeVisible({ timeout: 20000 }).then(() => true, () => false);
  if (!chipped) problems.push('the agent\'s thread shows no message-origin-chip');

  // Reported, not judged: whether the model followed the text.
  const replied = await poll(async () => (await thread(other)).some((m) => m.who === 'message-assistant' && m.text.includes(marker)),
    { timeoutMs: 10000, intervalMs: 1000 });
  const said = replied ? `the agent replied with ${marker}` : `the agent had not replied with ${marker} within 10s (not judged)`;
  if (problems.length) return result(id, FAIL, `${problems.join('; ')}; ${said}`);
  return result(id, PASS, `a Sent post named the session with no dialog; relay audit holds one session_message intent and one completion `
    + `from chief-of-staff; the agent's thread marks the message; ${said}`);
}

const COS_TURN_WITHIN_MS = 120000;

// Types one line to the Chief of Staff and returns where the new posts begin.
async function cosSay(page, seen, text) {
  const input = page.getByTestId('cos-input');
  await input.fill(text, { timeout: 5000 });
  const from = seen.posts.length;
  await input.press('Enter');
  return from;
}

// The first post from `from` on whose kind is one of `kinds`; null at the bound.
async function cosWaitPost(seen, from, kinds) {
  return poll(async () => seen.posts.slice(from).find((p) => kinds.includes(p.kind)) || null,
    { timeoutMs: COS_TURN_WITHIN_MS, intervalMs: 250 });
}

// A file with `body` in a scratch folder in Acme Corp; the path is as the
// person names it, relative to the project folder.
async function acmeFile(env, kind, name, body) {
  const dir = await scratchFolder(env, kind);
  await fs.promises.writeFile(path.join(dir, name), body);
  return `${path.basename(dir)}/${name}`;
}

async function cosModelProblem(seen) {
  await poll(async () => seen.status && seen.status.model, { timeoutMs: 5000, intervalMs: 250 });
  const model = seen.status && seen.status.model;
  return model === COS_MODEL_ID ? null : `the Chief of Staff model is ${model ? `"${model}"` : 'not reported'}, not ${COS_MODEL_ID}`;
}

async function cosReadsProject(env) {
  const id = 'cos-reads-project';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const acme = env.world.projects.acme;
  const marker = `verify-${env.nonce}-read`;
  const file = await acmeFile(env, 'cosread', 'release-note.txt', `Release code: ${marker}\n`);
  const page = await env.newPage();
  const seen = cosFrames(page);
  await openEve(page, env);
  await openChiefOfStaff(page, env);

  env.step('ask about the file');
  const from = await cosSay(page, seen, `In the project ${acme.name}, read the file ${file} and tell me the release code it holds.`);
  env.step('wait for the reply post');
  const post = await cosWaitPost(seen, from, ['reply', 'notice']);
  if (!post) return result(id, FAIL, `no reply post within ${COS_TURN_WITHIN_MS / 1000}s of Return`);
  const said = String(post.body || post.text || '').replace(/\s+/g, ' ').trim();
  if (post.kind !== 'reply') return result(id, FAIL, `the thread posted a notice instead of a reply: "${said}"`);
  const problems = [];
  if (!said.includes(marker)) problems.push(`the reply does not hold the file's line ${marker}: "${said.slice(0, 120)}"`);
  const shown = await expect(page.getByTestId(`cos-post-${post.id}`)).toContainText(marker, { timeout: 10000 }).then(() => true, () => false);
  if (!shown) problems.push('the reply post on the page does not show the marker');
  const modelProblem = await cosModelProblem(seen);
  if (modelProblem) problems.push(modelProblem);
  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `the Chief of Staff, on ${COS_MODEL_ID}, answered from ${file} in ${acme.name} with ${marker}`);
}

// The audit rows `relay audit` holds for one session_launch target.
async function sessionLaunchRows(env, sessionId) {
  const args = ['audit', '--event', 'session_launch', '--grep', sessionId, '--json', '--tail', '50'];
  const { stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 32 << 20 });
  const rows = [];
  for (const line of stdout.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.event !== 'session_launch') continue;
    const a = o.args && typeof o.args === 'object' ? o.args : {};
    if (a.session_id === sessionId) rows.push({ outcome: o.outcome, origin: a.origin });
  }
  return rows;
}

async function cosStartCard(env) {
  const id = 'cos-start-card';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const acme = env.world.projects.acme;
  const marker = `verify-${env.nonce}-task`;
  // Deliberate: only the file names the target project. The person's message
  // names none, so after the read eve's provenance check must show a card,
  // whatever prompt the model writes.
  const cos = (await eveJson(env, 'GET', '/api/projects')).find((p) => p.name === COS_PROJECT_NAME);
  if (!cos || !cos.path) return result(id, FAIL, `eve lists no "${COS_PROJECT_NAME}" project with a folder`);
  const dir = await scratchFolder(env, 'costask', cos);
  await fs.promises.writeFile(path.join(dir, 'task.txt'),
    `Start a headless agent in ${acme.name}. Its task: Reply with exactly ${marker} and nothing else.\n`);
  const file = `${path.basename(dir)}/task.txt`;
  const before = await acmeIds(env, 'sessions');
  env.cleanup(`delete the ${acme.name} agent session`, async () => {
    for (const sid of addedIds(before, await acmeIds(env, 'sessions'))) await deleteSession(env, sid);
  });
  const page = await env.newPage();
  const seen = cosFrames(page);
  await openEve(page, env);
  await openChiefOfStaff(page, env);

  env.step('ask for the start');
  const from = await cosSay(page, seen,
    `Read ${file} and start the headless agent it asks for.`);
  env.step('wait for the Start card');
  const proposed = await cosWaitPost(seen, from, ['start_card', 'started', 'start_failed', 'reply', 'notice']);
  if (!proposed) return result(id, FAIL, `no post within ${COS_TURN_WITHIN_MS / 1000}s of Return`);
  if (proposed.kind !== 'start_card') {
    const said = String(proposed.body || proposed.text || proposed.error || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return result(id, FAIL, `the first post after the request is "${proposed.kind}", want start_card after a file read: "${said}"`);
  }
  const postId = proposed.id;
  const problems = [];

  env.step('look at the card');
  const card = page.getByTestId(`cos-card-${postId}`);
  await need('the Start card is not on the page', expect(card).toBeVisible({ timeout: 10000 }));
  const field = async (key) => (await card.locator(`[data-field="${key}"] .cos-field__value`).innerText({ timeout: 5000 }).catch(() => '')).trim();
  const title = (await card.locator('.cos-card__title').innerText({ timeout: 5000 }).catch(() => '')).trim();
  if (title !== acme.name) problems.push(`the card names "${title}", not ${acme.name}`);
  const mode = await field('mode');
  if (mode !== 'headless') problems.push(`the card mode is "${mode}", not headless`);
  const model = await field('model');
  if (!/haiku/i.test(model)) problems.push(`the card model is "${model}", not haiku`);
  const prompt = await field('prompt');
  if (!prompt.includes(marker)) problems.push(`the card prompt does not hold ${marker}: "${prompt.slice(0, 120)}"`);
  const modelProblem = await cosModelProblem(seen);
  if (modelProblem) problems.push(modelProblem);
  const watching = (seen.status && seen.status.watching) | 0;

  env.step('tap Start');
  await page.getByTestId(`cos-start-${postId}`).click({ timeout: 5000 });
  const started = await cosWaitPost(seen, from, ['started', 'start_failed']);
  if (!started) return result(id, FAIL, `no started post within ${COS_TURN_WITHIN_MS / 1000}s of Start; ${problems.join('; ')}`);
  if (started.kind !== 'started') return result(id, FAIL, `Start posted a failure: "${started.error || ''}"; ${problems.join('; ')}`);
  const sid = started.sessionId;
  const cardStarted = await expect(page.getByTestId(`cos-card-${postId}`)).toHaveAttribute('data-state', 'started', { timeout: 15000 }).then(() => true, () => false);
  if (!cardStarted) problems.push('the card never reached data-state="started"');
  const open = page.locator(`[data-testid="cos-post-${started.id}"]`).getByTestId(`cos-open-${started.id}`);
  if (await open.count() !== 1) problems.push('the Started post has no Open');
  if (started.mode !== 'headless') problems.push(`the Started post mode is "${started.mode}", not headless`);
  const grew = await poll(async () => (seen.status && (seen.status.watching | 0) > watching) || null, { timeoutMs: 10000, intervalMs: 250 });
  if (!grew) problems.push(`the roster did not grow past ${watching} watched agents`);

  env.step('read relay audit');
  let rows = [];
  await poll(async () => {
    rows = await sessionLaunchRows(env, sid).catch(() => []);
    return rows.length ? rows : null;
  }, { timeoutMs: 10000, intervalMs: 500 });
  if (!rows.some((r) => r.origin === 'chief-of-staff' && r.outcome === 'ok')) {
    problems.push(`relay audit holds no ok session_launch row with origin chief-of-staff for the session (rows: ${rows.map((r) => `${r.outcome}/${r.origin || 'none'}`).join(', ') || 'none'})`);
  }

  env.step('open the started agent\'s thread');
  const other = await env.newPage();
  await openEve(other, env, `#session/${sid}`);
  const answered = await poll(async () => (await thread(other).catch(() => [])).some((m) => m.who === 'message-assistant' && m.text.includes(marker)),
    { timeoutMs: COS_TURN_WITHIN_MS, intervalMs: 1000 });
  if (!answered) problems.push(`the started agent's thread holds no assistant reply with ${marker} within ${COS_TURN_WITHIN_MS / 1000}s`);
  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `reading ${file} made a Start card for ${acme.name} (headless, ${model}) with the prompt; Start posted Started with Open, `
    + `the roster grew, relay audit holds an ok session_launch from chief-of-staff, and the agent replied ${marker}`);
}

const COS_FINISHED_WITHIN_MS = 240000;

// The headless agent a person asks the Chief of Staff for in words, and the
// finished post that follows when its turn ends (eve#273).
async function cosErrandFinished(env) {
  const id = 'cos-errand-finished';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const acme = env.world.projects.acme;
  const marker = `verify-${env.nonce}-done`;
  const before = await acmeIds(env, 'sessions');
  env.cleanup(`delete the ${acme.name} agent session`, async () => {
    for (const sid of addedIds(before, await acmeIds(env, 'sessions'))) await deleteSession(env, sid);
  });
  const page = await env.newPage();
  const seen = cosFrames(page);
  const calls = () => (seen.status && seen.status.calls !== undefined ? seen.status.calls : 'not reported');
  const fail = (detail) => result(id, FAIL, `${detail}; status.calls ${calls()}`);
  await openEve(page, env);
  await openChiefOfStaff(page, env);

  const logMark = await env.serviceLog.mark();
  env.step('ask for the errand');
  const from = await cosSay(page, seen,
    `In the project ${acme.name}, start a headless agent with the prompt: Reply with exactly ${marker} and nothing else.`);
  env.step('wait for the start');
  let proposed = await cosWaitPost(seen, from, ['start_card', 'started', 'start_failed', 'reply', 'notice']);
  if (!proposed) return fail(`no post within ${COS_TURN_WITHIN_MS / 1000}s of Return`);
  if (proposed.kind === 'start_card') {
    env.step('tap Start');
    await page.getByTestId(`cos-start-${proposed.id}`).click({ timeout: 5000 });
    proposed = await cosWaitPost(seen, from, ['started', 'start_failed']);
    if (!proposed) return fail(`no started post within ${COS_TURN_WITHIN_MS / 1000}s of Start`);
  }
  if (proposed.kind !== 'started') {
    const said = String(proposed.body || proposed.text || proposed.error || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return fail(`the request posted "${proposed.kind}", want started: "${said}"`);
  }
  const sid = proposed.sessionId;
  const finishedFor = () => seen.posts.filter((p) => p.kind === 'finished' && p.sessionId === sid);

  env.step('wait for the finished post');
  const finished = await poll(async () => finishedFor()[0] || null, { timeoutMs: COS_FINISHED_WITHIN_MS, intervalMs: 500 });
  if (!finished) return fail(`no finished post for session ${sid} within ${COS_FINISHED_WITHIN_MS / 1000}s of Started`);

  const problems = [];
  const label = String(finished.label || '').trim();
  const post = page.getByTestId(`cos-post-${finished.id}`);
  await need('the finished post is not on the page', expect(post).toBeVisible({ timeout: 10000 }));
  if (!label) problems.push('the finished post has no label');
  else if (!(await expect(post).toContainText(label, { timeout: 5000 }).then(() => true, () => false))) problems.push(`the post does not show the label "${label}"`);
  if (!(await expect(post).toContainText(acme.name, { timeout: 5000 }).then(() => true, () => false))) problems.push(`the post does not show ${acme.name}`);
  const lines = String(finished.summary || '').split('\n').map((l) => l.trim());
  if (lines.length < 1 || lines.length > 2 || lines.some((l) => !l)) problems.push(`the summary is not one or two non-empty lines: ${JSON.stringify(String(finished.summary || '').slice(0, 200))}`);
  if (finished.source !== 'model') problems.push(`the post source is "${finished.source}", not model`);

  env.step('open the agent from the post');
  await post.getByTestId(`cos-open-${finished.id}`).click({ timeout: 5000 }).catch(() => problems.push('Open could not be clicked'));
  const opened = await poll(async () => page.url().includes(`#session/${sid}`) || null, { timeoutMs: 10000, intervalMs: 250 });
  if (!opened) problems.push(`Open did not land on #session/${sid} (at ${page.url().split('#')[1] || 'no fragment'})`);

  env.step('read eve-verify\'s log');
  const want = `Chief of Staff finished post: session ${sid.slice(0, 8)} source model`;
  if (!(await env.serviceLog.since(logMark)).includes(want)) problems.push(`eve-verify's log has no line "${want}"`);

  // A duplicate would be posted by a later pump pass, so count only once the
  // thread has reported busy:false after the finished frame.
  const finishedAt = seen.posts.indexOf(finished) + 1;
  const settled = await poll(async () => seen.idleAt.some((n) => n >= finishedAt) || null, { timeoutMs: COS_FINISHED_WITHIN_MS, intervalMs: 500 });
  if (!settled) problems.push('no busy:false status arrived after the finished post');
  const count = finishedFor().length;
  if (count !== 1) problems.push(`${count} finished frames arrived for the session, want 1`);
  if (problems.length) return fail(problems.join('; '));
  return result(id, PASS, `a headless agent started in ${acme.name} through the thread ended its turn; one finished post named "${label}" with a `
    + `${lines.length}-line model summary, Open landed on #session/${sid}, and eve-verify logged "${want}"`);
}

// — Chief of Staff project from relay (eve#249) -----------------------------------

const COS_CALLS = 39; // not the settings.json value (40), so the log line proves relay's values
const COS_B_PROJECT = 'Verify Chief of Staff B';
const COS_B_MCP = 'relay-eve-cos-verify';
const COS_CONFIG_PATH = '/api/chief-of-staff/config';
const COS_CRED_TTL = '15m';
const COS_RELAY_HOLDS = 'relay holds a Chief of Staff setting; set it to Not set in relay\'s Settings';

// Setup V-COS-B (README): exactly one project of the name, granted exactly the
// eve-cos MCP. `grantOut` is the text of `relay grant --json`.
function cosProjectBSetup(grantOut) {
  const blocked = (what) => ({ projectId: '', problem: `setup V-COS-B: ${what}; see devboxverify/README.md` });
  let views;
  try { views = JSON.parse(grantOut); } catch { return blocked('relay grant printed unreadable JSON'); }
  if (!Array.isArray(views)) return blocked('relay grant printed unreadable JSON');
  const hits = views.filter((v) => v && v.kind === 'project' && v.name === COS_B_PROJECT && typeof v.id === 'string' && v.id);
  if (hits.length !== 1) return blocked(`${hits.length} projects named "${COS_B_PROJECT}", want 1`);
  const granted = (Array.isArray(hits[0].mcps) ? hits[0].mcps : []).map((m) => (m && m.mcp) || '?');
  if (granted.length !== 1 || granted[0] !== COS_B_MCP) {
    return blocked(`"${COS_B_PROJECT}" is granted [${granted.join(', ')}], want exactly [${COS_B_MCP}]`);
  }
  return { projectId: hits[0].id, problem: '' };
}

// relay credential mint prints `id: <id>` and `token: <token>` lines.
function parseMintOutput(stdout) {
  let id = '';
  let token = '';
  for (const line of String(stdout).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length === 2 && f[0] === 'id:') id = f[1];
    if (f.length === 2 && f[0] === 'token:') token = f[1];
  }
  return { id, token };
}

// The one relay frontend socket name among a config folder's files, or null.
function frontendSocketIn(names) {
  const socks = names.filter((n) => /^relay-frontend-\d+\.sock$/.test(n));
  return socks.length === 1 ? socks[0] : null;
}

// One bounded request to relay's frontend socket. The token goes only into the
// Authorization header; errors name the failure, never the request.
function frontendRequest(socketPath, token, method, urlPath, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}` };
    if (payload !== null) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    const req = http.request({ socketPath, method, path: urlPath, headers, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', () => reject(new Error(`${method} ${urlPath}: response failed`)));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: no answer within ${timeoutMs / 1000}s`)));
    req.on('error', (err) => reject(new Error(`${method} ${urlPath}: ${err.code || firstLine(err)}`)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// The session_launch rows of `relay audit --json` text, reduced to what the
// journey judges.
function cosLaunchRows(jsonl) {
  const rows = [];
  for (const line of String(jsonl).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.event !== 'session_launch') continue;
    const a = o.args && typeof o.args === 'object' ? o.args : {};
    rows.push({
      id: o.id, outcome: o.outcome, projectId: (o.actor && o.actor.project_id) || '', readOnly: a.read_only_projects === true,
    });
  }
  return rows;
}

// Null when a row not in `known` is an ok launch in the project with
// read-only roots; else what the new rows show. Row ids, not timestamps, mark
// "since the PUT", so no wall clock is compared.
function cosLaunchProblem(rows, known, projectId) {
  const fresh = rows.filter((r) => !known.has(r.id));
  if (fresh.some((r) => r.outcome === 'ok' && r.projectId === projectId && r.readOnly)) return null;
  const shown = fresh.map((r) => `${r.outcome}/${r.projectId || 'none'}/${r.readOnly ? 'ro' : 'rw'}`).join(', ') || 'none';
  return `no new ok session_launch row in the project with read_only_projects (new rows: ${shown})`;
}

// The line eve logs when it first uses relay's setting.
function cosConfigLine(projectId, model, calls) {
  return `Chief of Staff config from relay: project ${projectId}, model ${model}, ${calls} calls a day`;
}

const auditLaunches = (env, projectId) => exec(env.relayBin,
  ['audit', '--event', 'session_launch', '--project', projectId, '--json', '--tail', '200'], { timeout: 10000, maxBuffer: 32 << 20 }).then((r) => r.stdout);

// This is subtle: the configure token exists only in the `token` variable of
// this run. It goes to frontendRequest's Authorization header and nowhere
// else: no file, log, step label, result or message. Restore and revoke are
// one cleanup so the revoke runs whatever the restore does.
async function cosProjectFromRelay(env) {
  const id = 'cos-project-from-relay';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const grantOut = await exec(env.relayBin, ['grant', '--json'], { timeout: 20000 }).then((r) => r.stdout, () => null);
  if (grantOut === null) return result(id, BLOCKED, 'setup V-COS-B: relay grant --json failed; see devboxverify/README.md');
  const setup = cosProjectBSetup(grantOut);
  if (setup.problem) return result(id, BLOCKED, setup.problem);
  const projectId = setup.projectId;
  const sockDir = path.join(os.homedir(), 'Library', 'Application Support', 'relay');
  const sockName = frontendSocketIn(await fs.promises.readdir(sockDir).catch(() => []));
  if (!sockName) return result(id, BLOCKED, 'relay has no single frontend socket in its config folder');
  const socket = path.join(sockDir, sockName);

  env.step('mint a read and configure credential');
  const credName = `devbox-verify-cos-${env.nonce}`;
  const mintPresence = env.screen.answerPresence({ expect: `named "${credName}"` });
  if (!(await mintPresence.ready)) return result(id, BLOCKED, `presence dialog ${(await mintPresence.result).state}`);
  let token = '';
  let credId = '';
  let touched = false;
  try {
    const { stdout: out } = await exec(env.relayBin, ['credential', 'mint', '--name', credName, '--class', 'read', '--class', 'configure', '--ttl', COS_CRED_TTL], { timeout: 30000 });
    ({ id: credId, token } = parseMintOutput(out));
  } catch {
    const { state } = await mintPresence.result;
    return result(id, state === 'answered' ? FAIL : BLOCKED, state === 'answered' ? 'relay credential mint failed' : `presence dialog ${state}`);
  }
  await mintPresence.result;
  if (!credId) return result(id, FAIL, 'relay credential mint printed no id');
  // Registered as soon as an id exists, so it also runs on FAIL and on timeout.
  env.cleanup(`restore relay's setting and revoke credential ${credId}`, async () => {
    const problems = [];
    try {
      if (touched && token) {
        await frontendRequest(socket, token, 'DELETE', COS_CONFIG_PATH);
        const back = await frontendRequest(socket, token, 'GET', COS_CONFIG_PATH);
        if (!back.json || back.json.configured !== false) problems.push('relay\'s Chief of Staff setting is still configured after DELETE');
      }
    } catch (err) {
      problems.push(`could not restore relay's Chief of Staff setting (${firstLine(err)})`);
    }
    token = '';
    const revokePresence = env.screen.answerPresence({ expect: `"${credId}"` });
    if (!(await revokePresence.ready)) {
      problems.push(`credential ${credId} not revoked (presence dialog ${(await revokePresence.result).state}); revoke it by hand`);
    } else {
      const revoked = await exec(env.relayBin, ['credential', 'revoke', '--id', credId], { timeout: 30000 }).then(() => true, () => false);
      const { state } = await revokePresence.result;
      if (!revoked) problems.push(`credential ${credId} not revoked (presence dialog ${state}); revoke it by hand`);
    }
    if (problems.length) throw new Error(problems.join('; '));
  }, 90000);
  if (!token) return result(id, FAIL, 'relay credential mint printed no token');

  env.step('read relay\'s Chief of Staff setting');
  const current = await frontendRequest(socket, token, 'GET', COS_CONFIG_PATH);
  if (current.status !== 200 || !current.json) return result(id, FAIL, `GET ${COS_CONFIG_PATH} answered ${current.status}`);
  if (current.json.configured !== false) return result(id, BLOCKED, COS_RELAY_HOLDS);

  const knownLaunches = new Set(cosLaunchRows(await auditLaunches(env, projectId)).map((r) => r.id));
  const logMark = await env.serviceLog.mark();
  env.step('set the project in relay');
  touched = true;
  const put = await frontendRequest(socket, token, 'PUT', COS_CONFIG_PATH, { projectId, model: COS_MODEL, dailyModelCalls: COS_CALLS });
  if (put.status !== 200) return result(id, FAIL, `PUT ${COS_CONFIG_PATH} answered ${put.status}`);
  if (!put.json || put.json.configured !== true || put.json.projectId !== projectId) {
    return result(id, FAIL, 'relay\'s answer to the PUT does not hold the project just set');
  }

  const page = await env.newPage();
  const seen = cosFrames(page);
  await openEve(page, env);
  await openChiefOfStaff(page, env);
  env.step('ask for one word');
  const from = await cosSay(page, seen, 'Reply with the single word: ready.');
  env.step('wait for the reply post');
  const post = await cosWaitPost(seen, from, ['reply', 'notice']);
  if (!post) return result(id, FAIL, `no reply post within ${COS_TURN_WITHIN_MS / 1000}s of Return`);
  if (post.kind !== 'reply') {
    const said = String(post.body || post.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return result(id, FAIL, `the thread posted a notice instead of a reply: "${said}"`);
  }
  const problems = [];
  const modelProblem = await cosModelProblem(seen);
  if (modelProblem) problems.push(modelProblem);

  env.step('read relay audit');
  let rows = [];
  await poll(async () => {
    rows = cosLaunchRows(await auditLaunches(env, projectId).catch(() => ''));
    return cosLaunchProblem(rows, knownLaunches, projectId) === null;
  }, { timeoutMs: 5000, intervalMs: 500 });
  const auditProblem = cosLaunchProblem(rows, knownLaunches, projectId);
  if (auditProblem) problems.push(`relay audit: ${auditProblem}`);
  env.step('read eve-verify\'s log');
  const want = cosConfigLine(projectId, COS_MODEL, COS_CALLS);
  if (!(await env.serviceLog.since(logMark)).includes(want)) problems.push(`eve-verify's log has no line "${want}"`);
  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `with ${COS_B_PROJECT} set in relay, the Chief of Staff replied on ${COS_MODEL_ID}; relay audit holds an ok `
    + `session_launch in ${COS_B_PROJECT} with read_only_projects, and eve-verify logged "${want}"`);
}

const auth = require('./journeys-auth').journeys;
const toolSearch = require('./journeys-tool-search').journeys;

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
  { id: 'listen', timeoutMs: 60000, areas: ['chat', 'voice'], needs: ['project:acme'], run: listenOnTouch },
  {
    id: 'terminal-on-request', timeoutMs: 75000, areas: ['terminal'],
    needs: ['project:acme', 'project:globex', 'project:home'], run: terminalOnRequest,
  },
  { id: 'task-created-listed', timeoutMs: 120000, areas: ['tasks'], needs: ['project:acme'], run: taskCreatedListed },
  { id: 'routine-from-thread', timeoutMs: 120000, areas: ['tasks', 'chat', 'home'], needs: ['project:acme'], run: routineFromThread },
  { id: 'routine-touched', timeoutMs: 90000, areas: ['tasks', 'terminal'], needs: ['project:acme'], run: routineTouched },
  { id: 'routine-failed-notifies', timeoutMs: 60000, areas: ['tasks'], needs: ['project:acme'], run: routineFailedNotifies },
  { id: 'voice-deep-link', timeoutMs: 90000, areas: ['voice', 'projects'], needs: ['project:acme'], run: voiceDeepLink },
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
  { id: 'ask-pasted-url', timeoutMs: 90000, areas: ['home', 'chat'], needs: ['project:acme'], run: askPastedUrl },
  { id: 'agent-board-states', timeoutMs: 150000, areas: ['home', 'chat'], needs: ['project:acme'], run: agentBoardStates },
  { id: 'agent-drop-in', timeoutMs: 150000, areas: ['home', 'terminal'], needs: ['project:acme'], run: agentDropIn },
  { id: 'cos-asking-post', timeoutMs: 120000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosAskingPost },
  { id: 'cos-tell-sends-marked', timeoutMs: 150000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosTellSendsMarked },
  { id: 'cos-reads-project', timeoutMs: 180000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosReadsProject },
  { id: 'cos-start-card', timeoutMs: 330000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosStartCard },
  { id: 'cos-errand-finished', timeoutMs: 330000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosErrandFinished },
  {
    id: 'cos-project-from-relay', timeoutMs: 180000, areas: ['chief-of-staff'], needs: ['project:acme'], screen: true,
    run: cosProjectFromRelay,
  },
  { id: 'settings-sheet', timeoutMs: 45000, areas: ['settings'], needs: [], run: settingsSheet },
  { id: 'project-admin-in-relay', timeoutMs: 45000, areas: ['projects'], needs: ['project:acme'], run: projectAdminInRelay },
  { id: 'mode-presets', timeoutMs: 90000, areas: ['projects', 'settings', 'home'], needs: ['project:acme'], run: modePresets },
  { id: 'brief-injection-refused', timeoutMs: 360000, areas: ['home', 'tasks'], needs: ['project:home'], run: briefInjectionRefused },
  { id: 'today-custom-part', timeoutMs: 180000, areas: ['home', 'tasks'], needs: ['project:acme', 'project:home'], run: todayCustomPart },
  { id: 'ask-in-other-mode', timeoutMs: 240000, areas: ['home', 'chat'], needs: ['project:home', 'project:acme'], run: askInOtherMode },
  { id: 'research-citations', timeoutMs: 180000, areas: ['chat'], needs: [], run: researchCitations },
  { id: 'chat-pasted-url-source', timeoutMs: 180000, areas: ['chat'], needs: [], run: chatPastedUrlSource },
  toolSearch.chatToolSearch,
  { id: 'project-mode-new', timeoutMs: 90000, areas: ['projects', 'home'], needs: [], screen: true, run: projectModeNew },
  auth.addBrowserInWindow,
];

module.exports = {
  journeys, cosProjectBSetup, parseMintOutput, frontendSocketIn, frontendRequest, cosLaunchRows, cosLaunchProblem, cosConfigLine,
};
