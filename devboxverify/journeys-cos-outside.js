// The outside-session journeys (G6.93 to G6.95): a Claude started outside
// relay, in a tmux session, shows on the Chief of Staff rail; the thread can
// say what it last said; its tmux session opens read-only. See README.md.
// Everything live runs on Haiku. The harness starts the outside `claude`
// itself, in tmux, with no hooks (simple path) or with hooks from a settings
// file of its own (power path); it never edits the user's Claude settings.
// The helpers the Chief of Staff journeys share live in journeys.js, which
// requires this file at its bottom, so they are fetched when a journey runs.
// The few small readers below repeat theirs because journeys.js exports none.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { expect } = require('@playwright/test');
const { PASS, FAIL, BLOCKED, result, firstLine, need, poll, openEve, eveJson } = require('./journey-kit');

const exec = promisify(execFile);

const CLAUDE_MODEL = 'haiku';
const COS_MODEL_ID = 'claude-haiku-5-5';
const INVENTORY_WITHIN_MS = 40000; // two probe intervals of 15 s, plus the first snapshot
const TRUST_WITHIN_MS = 30000;
const ROW_WITHIN_MS = 60000; // a probe interval of 15 s, claude start-up, and an ssh probe
const REPLY_WITHIN_MS = 120000;
const COS_TURN_WITHIN_MS = 120000;
const GONE_WITHIN_MS = 60000; // relay evicts a failed or ended session within 60 s
const HOOK_STATE_WITHIN_MS = 5000; // relay drains hook reports every 2 s
const PERMISSION_WITHIN_MS = 120000;
const VIEWER_WITHIN_MS = 15000;
const HOST_PREFIX = 'loopback-';
const HOST_STATE_DIR = 'grant-dropin-'; // swept by verify-fixtures-removed's grant-* rule
const STATE_WORDS = ['Working', 'Waiting on you', 'Idle'];
const TRUST_PROMPT = /trust (this|the files in this) folder|Do you trust|Yes, I trust/i;
const PERMISSION_PROMPT = /Do you want to (proceed|make|create|allow)|Yes, and don't ask again|1\. Yes/i;
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];

const kit = () => require('./journeys');

// Eve's own Chief of Staff frames: the newest status, every post, the outside
// inventory (machines and sessions) and what this page sent on its sockets.
function frames(page) {
  const seen = { status: null, posts: [], machines: [], sessions: [], sent: [], received: [] };
  const take = (m) => {
    if (!m) return;
    if (typeof m.type === 'string') seen.received.push(m.type);
    if ((m.type === 'cos_snapshot' || m.type === 'cos_status') && m.status) seen.status = m.status;
    if (m.type === 'cos_snapshot') {
      if (Array.isArray(m.outsideMachines)) seen.machines = m.outsideMachines;
      if (Array.isArray(m.outsideSessions)) seen.sessions = m.outsideSessions;
    }
    if (m.type === 'cos_outside_sessions') {
      if (Array.isArray(m.machines)) seen.machines = m.machines;
      if (Array.isArray(m.sessions)) seen.sessions = m.sessions;
    }
    if (m.type === 'cos_post' && m.post) seen.posts.push(m.post);
  };
  const parse = (payload) => {
    if (typeof payload !== 'string') return null;
    try { return JSON.parse(payload); } catch { return null; }
  };
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const f = parse(payload);
      if (f && f.type === '__batch' && Array.isArray(f.msgs)) f.msgs.forEach(take);
      else take(f);
    });
    ws.on('framesent', ({ payload }) => {
      const f = parse(payload);
      if (f && typeof f.type === 'string') seen.sent.push(f.type);
    });
  });
  return seen;
}

async function openChiefOfStaff(page, env) {
  env.step('open Chief of Staff');
  await page.getByTestId('sidebar-chief-of-staff').click({ timeout: 10000 });
  await need('the Chief of Staff thread did not open', expect(page.getByTestId('cos-page')).toBeVisible({ timeout: 10000 }));
}

async function say(page, seen, text) {
  const input = page.getByTestId('cos-input');
  await input.fill(text, { timeout: 5000 });
  const from = seen.posts.length;
  await input.press('Enter');
  return from;
}

const waitPost = (seen, from, kinds) => poll(
  async () => seen.posts.slice(from).find((p) => kinds.includes(p.kind)) || null, { timeoutMs: COS_TURN_WITHIN_MS, intervalMs: 250 });

// Like eveJson, with room for relay's host probe and a presence dialog.
async function eveJsonSlow(env, method, urlPath, body) {
  const res = await fetch(env.url.replace(/\/+$/, '') + urlPath, {
    method, headers: { 'X-Session-Token': env.session.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} answered ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// — tmux and the outside claude ---------------------------------------------

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return '';
}

// A scratch folder that is a git repo on a branch of its own, so the row has a branch to show.
async function gitFolder(dir, branch) {
  const git = (...args) => exec('git', ['-C', dir, ...args], { env: cleanEnv(), timeout: 20000 });
  await git('init', '-q', '-b', branch);
  await git('-c', 'user.name=Acme Verify', '-c', 'user.email=verify@acme.invalid', 'commit', '-q', '--allow-empty', '-m', 'start');
}

async function pane(tmux, name) {
  try { return (await exec(tmux, ['capture-pane', '-p', '-J', '-t', name], { timeout: 10000 })).stdout; } catch { return ''; }
}

// Starts `claude --model haiku <prompt>` in a detached tmux session and answers
// the folder-trust prompt if it comes. Returns { trusted } once the prompt text
// is on the pane or the trust bound passes.
async function startClaude(env, tools, { name, dir, prompt, settings }) {
  const args = ['--model', CLAUDE_MODEL];
  if (settings) args.push('--settings', settings);
  args.push(prompt);
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  env.step(`start ${name}`);
  await exec(tools.tmux, ['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', dir, `${quote(tools.claude)} ${args.map(quote).join(' ')}`],
    { env: cleanEnv(), timeout: 20000 });
  tools.sessions.push(name);
  let trusted = false;
  await poll(async () => {
    const text = await pane(tools.tmux, name);
    if (!trusted && TRUST_PROMPT.test(text)) {
      trusted = true;
      await exec(tools.tmux, ['send-keys', '-t', name, 'Enter'], { timeout: 10000 });
      return null;
    }
    return text.includes(prompt.slice(-24)) ? true : null;
  }, { timeoutMs: TRUST_WITHIN_MS, intervalMs: 500 });
  return { trusted };
}

async function endClaude(tools, name) {
  await exec(tools.tmux, ['kill-session', '-t', `=${name}`], { timeout: 10000 });
  tools.sessions = tools.sessions.filter((n) => n !== name);
}

function newTools(env, id) {
  const tools = { tmux: onPath('tmux'), claude: onPath('claude'), sessions: [], dirs: [], problem: '' };
  if (!tools.tmux) tools.problem = 'tmux is not on PATH';
  else if (!tools.claude) tools.problem = 'claude is not on PATH';
  env.cleanup(`${id}: end the outside claude sessions and remove the scratch folders`, async () => {
    const failures = [];
    for (const name of tools.sessions.slice()) {
      try { await endClaude(tools, name); } catch (err) { if (!/can't find|no server|not found/i.test(String(err.stderr || err.message))) failures.push(`tmux ${name}: ${firstLine(err)}`); }
    }
    for (const dir of tools.dirs) {
      if (!dir || !path.isAbsolute(dir) || dir === path.parse(dir).root || dir === os.homedir() || dir === os.tmpdir()) { failures.push(`refusing to remove "${dir}"`); continue; }
      try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (err) { failures.push(`folder: ${firstLine(err)}`); }
    }
    if (failures.length) throw new Error(failures.join('; '));
  });
  return tools;
}

// — the rail -------------------------------------------------------------------

const outsideRows = (page, base) => page.locator('[data-testid^="rail-agent-outside:"]').filter({ hasText: base });
const metaOf = (row) => row.locator('.agent-row__outside').first().evaluate((el) => el.textContent, null, { timeout: 2000 }).catch(() => '');

// The meta line is "Outside · machine · folder · branch · state".
function metaProblems(meta, { base, branch, machineWants }) {
  const parts = String(meta).split(' · ').map((s) => s.trim());
  const problems = [];
  if (parts[0] !== 'Outside') problems.push(`the row is not marked Outside ("${meta}")`);
  if (!parts[1] || parts[1] === 'Outside' || parts[1].includes(base)) problems.push(`the row shows no machine ("${meta}")`);
  else if (machineWants && !parts[1].includes(machineWants)) problems.push(`the machine is "${parts[1]}", not the host ${machineWants}`);
  if (!parts.some((p) => p.includes(base))) problems.push(`the row shows no folder ${base} ("${meta}")`);
  if (!parts.includes(branch)) problems.push(`the row shows no branch ${branch} ("${meta}")`);
  if (!STATE_WORDS.includes(parts[parts.length - 1])) problems.push(`the row ends with "${parts[parts.length - 1]}", not a state word`);
  return problems;
}

// BLOCKED reason when relay serves no outside inventory (its route answers 404,
// which leaves eve with no machine): the first snapshot lists the console at least.
async function inventoryProblem(seen) {
  const machine = await poll(async () => seen.machines[0] || null, { timeoutMs: INVENTORY_WITHIN_MS, intervalMs: 500 });
  return machine ? null : `relay serves no outside inventory: no machine in the Chief of Staff snapshot within ${INVENTORY_WITHIN_MS / 1000}s (relay without outside sessions answers 404)`;
}

async function modelProblem(seen) {
  await poll(async () => seen.status && seen.status.model, { timeoutMs: 5000, intervalMs: 250 });
  const model = seen.status && seen.status.model;
  return model === COS_MODEL_ID ? null : `the Chief of Staff model is ${model ? `"${model}"` : 'not reported'}, not ${COS_MODEL_ID}`;
}

// — cos-outside-simple -------------------------------------------------------

// Hosted setup, the recipe of cos-host-agent: a loopback host and a project on it.
async function createHostedProject(env, held, nonce) {
  const hostName = `${HOST_PREFIX}${nonce}-outside`;
  const projectName = `Drop-in Host outside ${nonce}`;
  const dir = path.join(os.homedir(), '.local', 'state', 'devboxverify', `${HOST_STATE_DIR}${nonce}-outside`);
  held.hostDir = dir;
  try {
    const host = await eveJsonSlow(env, 'POST', '/api/hosts', { name: hostName, target: 'localhost', tmux_path: '/usr/bin/tmux' });
    held.hostId = host && host.id ? host.id : '';
  } catch (err) {
    return { problem: `loopback host not set up (setup P11): ${firstLine(err)}` };
  }
  if (!held.hostId) return { problem: 'loopback host not set up (setup P11): eve answered no host id' };
  await fs.promises.mkdir(dir, { recursive: true });
  const folder = await fs.promises.realpath(dir).catch(() => dir);
  // Relay gates every project create behind a presence dialog, so the POST
  // answers only once the helper has answered it. It must be ready first.
  const presence = env.screen.answerPresence({ expect: 'create the project' });
  if (!(await presence.ready)) return { problem: `presence dialog ${(await presence.result).state}` };
  try {
    const project = await eveJsonSlow(env, 'POST', '/api/projects', { name: projectName, path: folder, host_id: held.hostId, allowed_templates: ['claude-code'] });
    held.projectId = project && project.id ? project.id : '';
  } catch (err) {
    const { state } = await presence.result;
    return { problem: `hosted project not created (setup P11; presence dialog ${state}): ${firstLine(err)}` };
  }
  if (!held.projectId) return { problem: 'hosted project not created (setup P11): eve answered no project id' };
  return { hostName, folder };
}

async function cosOutsideSimple(env) {
  const id = 'cos-outside-simple';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const tools = newTools(env, id);
  if (tools.problem) return result(id, BLOCKED, tools.problem);
  const held = { hostId: '', projectId: '', hostDir: '' };
  // One cleanup, in dependency order: the project, then the host, then its folder.
  env.cleanup('delete the hosted project and host', async () => {
    const failures = [];
    const attempt = async (label, fn) => { try { await fn(); } catch (err) { failures.push(`${label}: ${firstLine(err)}`); } };
    if (held.projectId) await attempt('project', () => eveJson(env, 'DELETE', `/api/projects/${held.projectId}`));
    if (held.hostId) await attempt('host', () => eveJson(env, 'DELETE', `/api/hosts/${held.hostId}`));
    if (held.hostDir && path.basename(held.hostDir).startsWith(HOST_STATE_DIR)) await attempt('folder', () => fs.promises.rm(held.hostDir, { recursive: true, force: true }));
    if (failures.length) throw new Error(failures.join('; '));
  });

  const consoleMarker = `verify-${env.nonce}-outside-console`;
  const hostMarker = `verify-${env.nonce}-outside-host`;
  const consoleBranch = `verify-${env.nonce}-console`;
  const hostBranch = `verify-${env.nonce}-hosted`;
  const consoleName = `verify-${env.nonce}-outside-console`;
  const hostName = `verify-${env.nonce}-outside-host`;

  const page = await env.newPage();
  const seen = frames(page);
  await openEve(page, env);
  await openChiefOfStaff(page, env);
  const blocked = await inventoryProblem(seen);
  if (blocked) return result(id, BLOCKED, blocked);

  env.step('create the folders');
  const consoleDir = await kit().scratchFolder(env, 'outside');
  await gitFolder(consoleDir, consoleBranch);
  const hosted = await createHostedProject(env, held, env.nonce);
  if (hosted.problem) return result(id, BLOCKED, hosted.problem);
  const hostDir = await fs.promises.mkdtemp(path.join(hosted.folder, 'outside-'));
  await gitFolder(hostDir, hostBranch);

  const consoleBase = path.basename(consoleDir);
  const hostBase = path.basename(hostDir);
  const ask = (m) => `Reply with exactly ${m} and nothing else.`;
  const started = {
    console: await startClaude(env, tools, { name: consoleName, dir: consoleDir, prompt: ask(consoleMarker) }),
    host: await startClaude(env, tools, { name: hostName, dir: hostDir, prompt: ask(hostMarker) }),
  };

  const problems = [];
  env.step('wait for both rows on the rail');
  const consoleRow = outsideRows(page, consoleBase);
  const hostRow = outsideRows(page, hostBase);
  for (const [label, row] of [['console', consoleRow], ['host', hostRow]]) {
    const there = await poll(async () => (await row.count()) > 0 || null, { timeoutMs: ROW_WITHIN_MS, intervalMs: 500 });
    if (!there) return result(id, FAIL, `no Outside row for the ${label} claude on the rail within ${ROW_WITHIN_MS / 1000}s of its start`);
  }
  problems.push(...metaProblems(await metaOf(consoleRow.first()), { base: consoleBase, branch: consoleBranch }));
  problems.push(...metaProblems(await metaOf(hostRow.first()), { base: hostBase, branch: hostBranch, machineWants: hosted.hostName }));
  if (problems.length) return result(id, FAIL, problems.join('; '));

  env.step('wait for the outside replies');
  // The pane holds the marker twice once the model answered: once in the prompt, once in the reply.
  const answered = (name, marker) => poll(async () => ((await pane(tools.tmux, name)).split(marker).length - 1 >= 2) || null, { timeoutMs: REPLY_WITHIN_MS, intervalMs: 1000 });
  if (!(await answered(consoleName, consoleMarker))) return result(id, BLOCKED, `the console claude did not reply ${consoleMarker} within ${REPLY_WITHIN_MS / 1000}s (model output${started.console.trusted ? '; a trust prompt was answered' : ''})`);
  if (!(await answered(hostName, hostMarker))) return result(id, BLOCKED, `the hosted claude did not reply ${hostMarker} within ${REPLY_WITHIN_MS / 1000}s (model output)`);

  env.step('ask the Chief of Staff about the console session');
  const from = await say(page, seen, `What did the outside Claude session in the folder ${consoleBase} reply last? Quote it.`);
  const post = await waitPost(seen, from, ['reply', 'notice', 'start_card', 'started']);
  if (!post) return result(id, FAIL, `no post within ${COS_TURN_WITHIN_MS / 1000}s of Return`);
  const said = String(post.body || post.text || post.error || '').replace(/\s+/g, ' ').trim();
  if (post.kind !== 'reply') problems.push(`the question posted "${post.kind}", want reply: "${said.slice(0, 160)}"`);
  else if (!said.includes(consoleMarker)) problems.push(`the reply does not carry ${consoleMarker}: "${said.slice(0, 200)}"`);
  else if (said.includes(hostMarker)) problems.push(`the reply about the console session carries the hosted marker ${hostMarker}`);
  const modelIssue = await modelProblem(seen);
  if (modelIssue) problems.push(modelIssue);

  env.step('view the console session read-only');
  const line = await consoleRow.first().locator('.agent-row__line').first().evaluate((el) => el.textContent, null, { timeout: 2000 }).catch(() => '');
  if (line !== 'View read-only') return result(id, FAIL, `${problems.length ? `${problems.join('; ')}; ` : ''}the console row offers "${line}", not View read-only`);
  await consoleRow.first().getByText('View read-only').click({ timeout: 5000 });
  const badge = page.getByTestId('terminal-read-only');
  const shown = await expect(badge).toBeVisible({ timeout: VIEWER_WITHIN_MS }).then(() => true, () => false);
  if (!shown) return result(id, FAIL, `${problems.length ? `${problems.join('; ')}; ` : ''}the terminal shows no Read-only badge within ${VIEWER_WITHIN_MS / 1000}s of View read-only`);
  if (!(await badge.innerText().then((t) => /Read-only/.test(t), () => false))) problems.push('the terminal badge does not say Read-only');
  // Type only once relay has joined the viewer: a join clears what was typed before it.
  const joined = await poll(async () => seen.received.includes('terminal_joined') || null, { timeoutMs: VIEWER_WITHIN_MS, intervalMs: 250 });
  if (!joined) return result(id, FAIL, `${problems.length ? `${problems.join('; ')}; ` : ''}no terminal_joined within ${VIEWER_WITHIN_MS / 1000}s of View read-only`);
  const mark = seen.sent.length;
  const typed = `typed-${env.nonce}`;
  await page.getByRole('textbox', { name: 'Terminal input' }).focus({ timeout: 5000 });
  await page.keyboard.type(`echo ${typed}`);
  await page.keyboard.press('Enter');
  // Close is the marker: its frame goes out after every earlier keystroke was handled.
  await page.getByRole('button', { name: `Close ${consoleName}`, exact: true }).click({ timeout: 5000 });
  const closed = await poll(async () => seen.sent.slice(mark).includes('terminal_close') || null, { timeoutMs: VIEWER_WITHIN_MS, intervalMs: 250 });
  if (!closed) problems.push(`Close sent no terminal_close within ${VIEWER_WITHIN_MS / 1000}s`);
  const leaked = seen.sent.slice(mark).filter((t) => t === 'terminal_input' || t === 'terminal_resize');
  if (leaked.length) problems.push(`typing in the viewer sent ${leaked.join(', ')}`);
  if ((await pane(tools.tmux, consoleName)).includes(typed)) problems.push('the typed text reached the outside tmux session');

  env.step('end both outside sessions');
  await endClaude(tools, consoleName);
  await endClaude(tools, hostName);
  const gone = async (row) => poll(async () => (await row.count()) === 0 || null, { timeoutMs: GONE_WITHIN_MS, intervalMs: 500 });
  if (!(await gone(consoleRow))) problems.push(`the console row is still on the rail ${GONE_WITHIN_MS / 1000}s after its claude ended`);
  if (!(await gone(hostRow))) problems.push(`the host row is still on the rail ${GONE_WITHIN_MS / 1000}s after its claude ended`);

  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `the rail showed two Outside rows (console ${consoleBase} on ${consoleBranch}, host ${hostBase} on ${hostBranch}) with machine, folder, branch and a state; `
    + `the Chief of Staff's reply carried ${consoleMarker}; View read-only showed the Read-only badge and ${TYPED_OBSERVE_MS / 1000}s of typing sent no terminal_input or terminal_resize; `
    + `both rows were gone within ${GONE_WITHIN_MS / 1000}s of their claude ending`);
}

// — cos-outside-hooks --------------------------------------------------------

// Where relay's optional report hook lives: RELAY_OUTSIDE_REPORT, else the relay checkout's script.
function reportHelper() {
  if (process.env.RELAY_OUTSIDE_REPORT) return process.env.RELAY_OUTSIDE_REPORT;
  const checkout = process.env.RELAY_CHECKOUT || path.resolve(__dirname, '..', '..', 'relay');
  return path.join(checkout, 'scripts', 'outside-session-report.sh');
}

async function cosOutsideHooks(env) {
  const id = 'cos-outside-hooks';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const tools = newTools(env, id);
  if (tools.problem) return result(id, BLOCKED, tools.problem);
  const helper = reportHelper();
  if (!fs.existsSync(helper)) return result(id, BLOCKED, 'relay\'s outside-session-report.sh is not in the relay checkout (set RELAY_OUTSIDE_REPORT); it ships with relay\'s outside sessions');

  const page = await env.newPage();
  const seen = frames(page);
  await openEve(page, env);
  await openChiefOfStaff(page, env);
  const blocked = await inventoryProblem(seen);
  if (blocked) return result(id, BLOCKED, blocked);

  env.step('write the hook settings');
  // The settings file is the harness's own, passed with --settings; the user's
  // Claude settings are never read or changed. A wrapper stamps each firing
  // (its file's mtime) and hands the same stdin to relay's helper, which spools it.
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `verify-${env.nonce}-hooks-`));
  tools.dirs.push(work);
  for (const p of [work, helper]) if (p.includes("'")) return result(id, BLOCKED, 'a path holds a quote; the hook command cannot be written safely');
  const wrapper = path.join(work, 'hook.sh');
  await fs.promises.writeFile(wrapper, `#!/bin/sh\n: > '${work}'/fired."$1".$$\nexec /bin/sh '${helper}'\n`, { mode: 0o700 });
  const settings = path.join(work, 'settings.json');
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: `/bin/sh '${wrapper}' ${e}` }] }]]));
  await fs.promises.writeFile(settings, JSON.stringify({ hooks }));

  const consoleBranch = `verify-${env.nonce}-hooks`;
  const dir = await kit().scratchFolder(env, 'outside-hooks');
  await gitFolder(dir, consoleBranch);
  const base = path.basename(dir);
  const target = path.join(dir, `verify-${env.nonce}-hook.txt`);
  const name = `verify-${env.nonce}-outside-hooks`;
  const prompt = `Run exactly this shell command with your Bash tool, then say done: touch ${target}`;
  const { trusted } = await startClaude(env, tools, { name, dir, prompt, settings });

  env.step('wait for the row on the rail');
  const row = outsideRows(page, base);
  const there = await poll(async () => (await row.count()) > 0 || null, { timeoutMs: ROW_WITHIN_MS, intervalMs: 250 });
  if (!there) return result(id, FAIL, `no Outside row for the claude on the rail within ${ROW_WITHIN_MS / 1000}s of its start`);
  const problems = metaProblems(await metaOf(row.first()), { base, branch: consoleBranch });
  if (problems.length) return result(id, FAIL, problems.join('; '));

  env.step('wait for the permission hook to fire');
  const askNames = (n) => n.startsWith('fired.PermissionRequest.') || n.startsWith('fired.Notification.');
  const fired = await poll(async () => {
    const names = (await fs.promises.readdir(work).catch(() => [])).filter(askNames);
    if (!names.length) return null;
    const stats = await Promise.all(names.map((n) => fs.promises.stat(path.join(work, n))));
    return { at: Math.min(...stats.map((s) => s.mtimeMs)), names };
  }, { timeoutMs: PERMISSION_WITHIN_MS, intervalMs: 100 });
  if (!fired) {
    const text = await pane(tools.tmux, name);
    if (!PERMISSION_PROMPT.test(text)) return result(id, BLOCKED, `claude did not ask permission for the touch within ${PERMISSION_WITHIN_MS / 1000}s (model output or a permission rule${trusted ? '; a trust prompt was answered' : ''})`);
    return result(id, FAIL, `the pane shows a permission prompt but neither PermissionRequest nor Notification fired the hook within ${PERMISSION_WITHIN_MS / 1000}s`);
  }

  env.step('wait for Waiting on you');
  const deadline = fired.at + HOOK_STATE_WITHIN_MS;
  const asking = await page.waitForFunction(([base2, words]) => {
    const rows = [...document.querySelectorAll('[data-testid^="rail-agent-outside:"]')].filter((r) => r.textContent.includes(base2));
    return rows.some((r) => (r.querySelector('.agent-row__outside')?.textContent || '').endsWith(words));
  }, [base, 'Waiting on you'], { polling: 100, timeout: Math.max(1, deadline - Date.now()) }).then(() => Date.now(), () => 0);
  if (!asking) {
    const now2 = await metaOf(row.first());
    return result(id, FAIL, `the row did not read Waiting on you within ${HOOK_STATE_WITHIN_MS / 1000}s of the ${fired.names[0].split('.')[1]} hook firing; the row reads "${now2}"`);
  }
  const took = Math.max(0, Math.round(asking - fired.at));
  return result(id, PASS, `the ${fired.names[0].split('.')[1]} hook spooled a report and the Outside row read Waiting on you ${took} ms after the hook fired, within the ${HOOK_STATE_WITHIN_MS / 1000}s bound`);
}

module.exports = {
  metaProblems,
  journeys: {
    cosOutsideSimple: {
      id: 'cos-outside-simple', timeoutMs: 600000, areas: ['chief-of-staff'], needs: ['project:acme'], screen: true, run: cosOutsideSimple,
    },
    cosOutsideHooks: {
      id: 'cos-outside-hooks', timeoutMs: 360000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosOutsideHooks,
    },
  },
};
