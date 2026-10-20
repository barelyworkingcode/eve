// The outside-session journeys (G6.93 to G6.96): a Claude started outside
// relay shows on the Chief of Staff rail; the thread can say what it last said;
// its conversation opens as a read-only thread; a tmux one also opens read-only
// in a terminal. See README.md.
// Everything live runs on claude-haiku-5-5 unless the stack names another. The harness starts the outside `claude`
// itself, in tmux, with no hooks (simple path) or with hooks from a settings
// file of its own (power path); it never edits the user's Claude settings.
// The helpers the Chief of Staff journeys share live in journeys.js, which
// requires this file at its bottom, so they are fetched when a journey runs.
// The few small readers below repeat theirs because journeys.js exports none.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');
const { expect } = require('@playwright/test');
const { PASS, FAIL, BLOCKED, result, firstLine, need, poll, openEve, eveJson } = require('./journey-kit');

const exec = promisify(execFile);

const CLAUDE_MODEL = 'haiku';
const INVENTORY_WITHIN_MS = 40000; // two probe intervals of 15 s, plus the first snapshot
const TRUST_WITHIN_MS = 30000;
const TRUST_MAX_DOWNS = 4;
const ROW_WITHIN_MS = 60000; // a probe interval of 15 s, claude start-up, and an ssh probe
const REPLY_WITHIN_MS = 120000;
const COS_TURN_WITHIN_MS = 120000;
const GONE_WITHIN_MS = 60000; // relay evicts a failed or ended session within 60 s
const HOOK_STATE_WITHIN_MS = 5000; // relay drains hook reports every 2 s
const PERMISSION_WITHIN_MS = 120000;
const VIEWER_WITHIN_MS = 15000;
// relay's hookless probe runs every 15 s; 2 s more covers its run and eve's fan-out.
const PROBE_STATE_WITHIN_MS = 17000;
const IDLE_WITHIN_MS = 45000;
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
  return kit().afterOwnPost(seen, from, text);
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

const { cleanEnv, outsideClaudeEnv, shellPrefix, writeOutsideSettings } = require('./outside-claude');

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
  // Default permission mode: the machine's own mode (auto, say) may never show a permission prompt.
  const args = ['--model', CLAUDE_MODEL, '--permission-mode', 'default'];
  if (settings) args.push('--settings', settings);
  const crypto = require('crypto');
  // Deliberate: the harness owns the conversation id, so its transcript can be removed by name.
  // Recorded before the start, so a start that fails is still covered.
  const sessionId = crypto.randomUUID();
  tools.claudeIds.push({ id: sessionId, journey: tools.journey });
  args.push('--session-id', sessionId);
  args.push(prompt);
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  env.step(`start ${name}`);
  // A running tmux server does not inherit the client's environment, so a stack's
  // spool goes in with -e. The spool defaults to a folder in the stack's relay config dir.
  const spool = env.stack ? (env.stack.outsideSpool || path.join(env.relayConfigDir, 'outside-reports')) : null;
  const spoolEnv = spool ? ['-e', `RELAY_OUTSIDE_SPOOL=${spool}`] : [];
  // A stack run's broker wiring goes in through the shell command, which reads the token file itself.
  await writeOutsideSettings(env, dir);
  await exec(tools.tmux, ['new-session', '-d', ...spoolEnv, '-s', name, '-x', '200', '-y', '50', '-c', dir, `${shellPrefix(env)}exec ${quote(tools.claude)} ${args.map(quote).join(' ')}`],
    { env: cleanEnv(), timeout: 20000 });
  tools.sessions.push(name);
  let trusted = false;
  let downs = 0;
  await poll(async () => {
    const text = await pane(tools.tmux, name);
    if (!trusted && TRUST_PROMPT.test(text)) {
      // The cursor may start on "No, exit": read which line it is on, move down
      // until it is on "Yes, I trust", then confirm.
      const cursorLine = (text.split('\n').find((l) => /^\s*[❯>]\s/.test(l)) || '');
      if (/Yes, I trust/i.test(cursorLine)) {
        trusted = true;
        await exec(tools.tmux, ['send-keys', '-t', name, 'Enter'], { timeout: 10000 });
      } else if (downs < TRUST_MAX_DOWNS) {
        downs++;
        await exec(tools.tmux, ['send-keys', '-t', name, 'Down'], { timeout: 10000 });
      }
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
  const { claudeRunning, removeTranscript, runMarks, TRANSCRIPT_CLEANUP_MS } = require('./claude-transcripts');
  const tools = { tmux: onPath('tmux'), claude: onPath('claude'), sessions: [], dirs: [], problem: '' };
  tools.claudeIds = [];
  tools.journey = id;
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
  env.cleanup(`${id}: remove the outside claude transcripts`, async () => {
    // In parallel: two Claudes must fit one cleanup's time limit.
    await Promise.all(tools.claudeIds.map(({ id: claudeId, journey }) => removeTranscript({
      journey, id: claudeId, token: `verify-${env.nonce}-`, marks: runMarks(env), running: async () => claudeRunning('--session-id', claudeId),
    })));
  }, TRANSCRIPT_CLEANUP_MS);
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

async function modelProblem(seen, env) {
  await poll(async () => seen.status && seen.status.model, { timeoutMs: 5000, intervalMs: 250 });
  const model = seen.status && seen.status.model;
  return model === kit().claudeModelId(env) ? null : `the Chief of Staff model is ${model ? `"${model}"` : 'not reported'}, not ${kit().claudeModelId(env)}`;
}


// — the thread tab (G6.96) ---------------------------------------------------

const threadOf = (page) => page.getByTestId('outside-thread');
const entryOf = (page, who) => threadOf(page).getByRole('log', { name: 'Conversation' }).locator('.outside-thread__entry')
  .filter({ has: page.locator('.outside-thread__who', { hasText: new RegExp(`^${who}$`) }) });

// Click the row, then wait for the first load: data-fetches counts settled requests.
async function openThread(page, row) {
  await row.click({ timeout: 5000 });
  const thread = threadOf(page);
  await need('the thread tab did not open', expect(thread).toBeVisible({ timeout: 10000 }));
  await need('the thread did not finish its first load',
    expect(thread).toHaveAttribute('aria-busy', 'false', { timeout: 20000 }));
  await need('the thread settled no request', expect.poll(async () => Number(await thread.getAttribute('data-fetches')), { timeout: 20000 }).toBeGreaterThan(0));
}

const rowLine = (row) => row.first().locator('.agent-row__line').first().evaluate((el) => el.textContent, null, { timeout: 2000 }).catch(() => '');

// An entry by label with the text; the thread polls, so the model's output has only a bounded wait.
const entryWith = (page, who, text) => poll(async () => {
  const texts = await entryOf(page, who).locator('.outside-thread__text').allTextContents().catch(() => []);
  return texts.some((t) => t.includes(text)) || null;
}, { timeoutMs: REPLY_WITHIN_MS, intervalMs: 1000 });

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
  // A loopback host is the console machine, so relay's console probe lists the hosted claude too, as a
  // Console row with no project. Pick the host's row by its machine; the gone check still covers every row.
  const hostRows = outsideRows(page, hostBase);
  const hostRow = hostRows.filter({ hasText: hosted.hostName });
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
  const modelIssue = await modelProblem(seen, env);
  if (modelIssue) problems.push(modelIssue);

  // A hookless state change. relay's probe reads a pending tool call as asking, so
  // the change it can show for sure is Idle to Waiting on you at a permission prompt.
  env.step('change the hookless console session to Waiting on you');
  const stateOf = async () => (await metaOf(consoleRow.first())).split(' · ').pop();
  const idle = await poll(async () => (await stateOf()) === 'Idle' || null, { timeoutMs: IDLE_WITHIN_MS, intervalMs: 500 });
  if (!idle) return result(id, FAIL, `${problems.length ? `${problems.join('; ')}; ` : ''}the console row did not settle on Idle within ${IDLE_WITHIN_MS / 1000}s of its reply (it shows "${await stateOf()}")`);
  const sentAt = Date.now();
  await exec(tools.tmux, ['send-keys', '-t', consoleName, '-l', `Use the Bash tool to run: touch verify-${env.nonce}-probe`], { timeout: 10000 });
  await exec(tools.tmux, ['send-keys', '-t', consoleName, 'Enter'], { timeout: 10000 });
  const promptAt = await poll(async () => (PERMISSION_PROMPT.test(await pane(tools.tmux, consoleName)) ? Date.now() : null), { timeoutMs: PERMISSION_WITHIN_MS, intervalMs: 250 });
  if (!promptAt) return result(id, BLOCKED, `the console claude showed no permission prompt within ${PERMISSION_WITHIN_MS / 1000}s of the request (model output)`);
  const waitingAt = await poll(async () => ((await stateOf()) === 'Waiting on you' ? Date.now() : null), { timeoutMs: PROBE_STATE_WITHIN_MS, intervalMs: 250 });
  if (!waitingAt) problems.push(`the console row did not show Waiting on you within ${PROBE_STATE_WITHIN_MS / 1000}s of the permission prompt (it shows "${await stateOf()}")`);
  const probeGap = waitingAt ? `Waiting on you ${((waitingAt - promptAt) / 1000).toFixed(1)}s after the prompt (${((waitingAt - sentAt) / 1000).toFixed(1)}s after the request)` : '';

  env.step('view the console session read-only');
  // A row click opens the thread now; the tmux viewer has the sibling button.
  const line = await rowLine(consoleRow);
  if (line !== 'Read-only thread') return result(id, FAIL, `${problems.length ? `${problems.join('; ')}; ` : ''}the console row offers "${line}", not Read-only thread`);
  await page.locator('.agent-row-wrap').filter({ has: consoleRow.first() }).getByRole('button', { name: /^View .+ read-only$/ }).click({ timeout: 5000 });
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
  // relay answers terminal_closed once it has handled every earlier frame from this page.
  const joinedAt = seen.received.lastIndexOf('terminal_joined');
  const detached = await poll(async () => seen.received.slice(joinedAt).includes('terminal_closed') || null, { timeoutMs: VIEWER_WITHIN_MS, intervalMs: 250 });
  if (!detached) problems.push(`relay sent no terminal_closed within ${VIEWER_WITHIN_MS / 1000}s of Close`);
  const leaked = seen.sent.slice(mark).filter((t) => t === 'terminal_input' || t === 'terminal_resize');
  if (leaked.length) problems.push(`typing in the viewer sent ${leaked.join(', ')}`);
  if ((await pane(tools.tmux, consoleName)).includes(typed)) problems.push('the typed text reached the outside tmux session');

  // The viewer left its terminal tab on screen; a person goes back to the Chief of Staff for the rail.
  await openChiefOfStaff(page, env);
  env.step('open the host session thread');
  const hostLine = await rowLine(hostRow);
  if (hostLine !== 'Read-only thread') problems.push(`the host row offers "${hostLine}", not Read-only thread`);
  await openThread(page, hostRow.first());
  if (!(await entryWith(page, 'Claude', hostMarker))) problems.push(`the host thread shows no Claude entry with ${hostMarker}`);
  if (!(await entryWith(page, 'You', ask(hostMarker)))) problems.push('the host thread shows no You entry with the host prompt');

  env.step('end both outside sessions');
  // Ended rows carry the folder too, so the live rows are told apart by the test ids they had while live.
  const idsOf = (rows) => rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  const liveIds = { console: await idsOf(consoleRow), host: await idsOf(hostRows) };
  await endClaude(tools, consoleName);
  await endClaude(tools, hostName);
  const gone = (ids) => poll(async () => {
    const counts = await Promise.all(ids.map((tid) => page.getByTestId(tid).count()));
    return counts.every((n) => n === 0) || null;
  }, { timeoutMs: GONE_WITHIN_MS, intervalMs: 500 });
  if (!(await gone(liveIds.console))) problems.push(`the console row is still on the rail ${GONE_WITHIN_MS / 1000}s after its claude ended`);
  if (!(await gone(liveIds.host))) problems.push(`the host row is still on the rail ${GONE_WITHIN_MS / 1000}s after its claude ended`);
  // The same two folders now show an Ended row each, under the Ended heading.
  const endedRows = (base) => page.getByTestId('rail-agents-group-ended').locator('[data-state="ended"]').filter({ hasText: base });
  for (const [label, base] of [['console', consoleBase], ['host', hostBase]]) {
    const shown = await poll(async () => (await endedRows(base).count()) > 0 || null, { timeoutMs: GONE_WITHIN_MS, intervalMs: 500 });
    if (!shown) problems.push(`no Ended row for the ${label} folder ${base} under the Ended heading ${GONE_WITHIN_MS / 1000}s after its claude ended`);
  }

  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `the rail showed two Outside rows (console ${consoleBase} on ${consoleBranch}, host ${hostBase} on ${hostBranch}) with machine, folder, branch and a state; `
    + `the Chief of Staff's reply carried ${consoleMarker}; with no hooks the row showed ${probeGap}; `
    + `the host row read Read-only thread and its thread showed the prompt and ${hostMarker}; `
    + `the View read-only button showed the Read-only badge, and typing up to Close sent no terminal_input or terminal_resize and never reached the pane; `
    + `both live rows left the rail and an Ended row showed for each folder within ${GONE_WITHIN_MS / 1000}s of their claude ending`);
}

// — cos-outside-hooks --------------------------------------------------------

// Where relay's optional report hook lives: the stack's relay checkout, else
// RELAY_OUTSIDE_REPORT, else the relay checkout's script. A stack run never
// falls back: another checkout's helper would write the tray's spool.
function reportHelper(env) {
  if (env.stack) return env.stack.relayCheckout ? path.join(env.stack.relayCheckout, 'scripts', 'outside-session-report.sh') : null;
  if (process.env.RELAY_OUTSIDE_REPORT) return process.env.RELAY_OUTSIDE_REPORT;
  const checkout = process.env.RELAY_CHECKOUT || path.resolve(__dirname, '..', '..', 'relay');
  return path.join(checkout, 'scripts', 'outside-session-report.sh');
}

async function cosOutsideHooks(env) {
  const id = 'cos-outside-hooks';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const tools = newTools(env, id);
  if (tools.problem) return result(id, BLOCKED, tools.problem);
  const helper = reportHelper(env);
  if (!helper) return result(id, BLOCKED, 'stack.json names no relay_checkout');
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
  // (the file's mtime) with the hook's stdin payload and hands the same payload to relay's helper, which spools it.
  // A stack run keeps its scratch beside its record, never in the system temp dir.
  const scratchRoot = env.stack ? env.stack.scratchDir : os.tmpdir();
  if (env.stack) await fs.promises.mkdir(scratchRoot, { recursive: true });
  const work = await fs.promises.mkdtemp(path.join(scratchRoot, `verify-${env.nonce}-hooks-`));
  tools.dirs.push(work);
  for (const p of [work, helper]) if (p.includes("'")) return result(id, BLOCKED, 'a path holds a quote; the hook command cannot be written safely');
  const wrapper = path.join(work, 'hook.sh');
  await fs.promises.writeFile(wrapper, `#!/bin/sh\ncat > '${work}'/fired."$1".$$\n/bin/sh '${helper}' < '${work}'/fired."$1".$$\n`, { mode: 0o700 });
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
  // Relay maps only PermissionRequest, or a Notification of type permission_prompt, to asking:
  // an idle_prompt Notification is not the permission hook.
  const isAsk = async (n) => {
    if (n.startsWith('fired.PermissionRequest.')) return true;
    if (!n.startsWith('fired.Notification.')) return false;
    try { return JSON.parse(await fs.promises.readFile(path.join(work, n), 'utf8')).notification_type === 'permission_prompt'; } catch { return false; }
  };
  const fired = await poll(async () => {
    const all = await fs.promises.readdir(work).catch(() => []);
    const flags = await Promise.all(all.map(isAsk));
    const names = all.filter((_, i) => flags[i]);
    if (!names.length) return null;
    const stats = await Promise.all(names.map((n) => fs.promises.stat(path.join(work, n))));
    return { at: Math.min(...stats.map((s) => s.mtimeMs)), names };
  }, { timeoutMs: PERMISSION_WITHIN_MS, intervalMs: 100 });
  if (!fired) {
    const text = await pane(tools.tmux, name);
    if (!PERMISSION_PROMPT.test(text)) return result(id, BLOCKED, `claude did not ask permission for the touch within ${PERMISSION_WITHIN_MS / 1000}s (model output or a permission rule${trusted ? '; a trust prompt was answered' : ''})`);
    return result(id, FAIL, `the pane shows a permission prompt but neither PermissionRequest nor a permission_prompt Notification fired the hook within ${PERMISSION_WITHIN_MS / 1000}s`);
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

// — outside-thread -----------------------------------------------------------

// Claude's Bash tool runs in a shell that leads its own process group, so ending claude's group
// alone would leave that shell (and its tail) running. End each direct child's group first.
// Throws only if claude's own group cannot be ended.
async function endProcessTree(pid) {
  let kids = [];
  try {
    kids = (await exec('pgrep', ['-P', String(pid)], { timeout: 10000 })).stdout.split('\n').map((n) => parseInt(n, 10)).filter(Number.isInteger);
  } catch { /* pgrep exits 1 when there are no children */ }
  for (const kid of kids) {
    try { process.kill(-kid, 'SIGKILL'); } catch { /* already gone, or not a group leader */ }
  }
  process.kill(-pid, 'SIGKILL');
}

// G6.96, the simple path: a console claude with no tmux (`claude -p`, detached)
// opens as a read-only thread; when the process ends the tab closes with a notice.
async function outsideThread(env) {
  const id = 'outside-thread';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const claude = onPath('claude');
  if (!claude) return result(id, BLOCKED, 'claude is not on PATH');

  const held = { child: null, exited: null, done: false };
  env.cleanup('end the outside claude', async () => {
    if (!held.child || held.done) return;
    try { await endProcessTree(held.child.pid); } catch { /* already gone */ }
    await held.exited;
  });

  const page = await env.newPage();
  const seen = frames(page);
  await openEve(page, env);
  await openChiefOfStaff(page, env);
  const blocked = await inventoryProblem(seen);
  if (blocked) return result(id, BLOCKED, blocked);

  env.step('create the folder');
  const branch = `verify-${env.nonce}-thread`;
  // Cleanups run in registration order: the process is ended first, then this folder is removed.
  const dir = await kit().scratchFolder(env, 'outside-thread');
  await gitFolder(dir, branch);
  const base = path.basename(dir);
  const marker = `verify-${env.nonce}-thread`;
  const prompt = `Reply with exactly ${marker}, then run tail -f keepalive.log with Bash.`;

  // Keep-alive is a tail, not a sleep: Claude CLI 2.1.300+ refuses a foreground sleep by itself, and
  // its sandbox reads only inside the working folder, so the empty file lives there.
  await fs.promises.writeFile(path.join(dir, 'keepalive.log'), '');

  env.step('start the outside claude with no tmux');
  // Detached into its own process group; the Bash tool's shell leads its own group, which endProcessTree ends too. One Bash call is allowed.
  // The harness runs with a trimmed environment; claude fails to sign in without USER, and then
  // exits at once, so the row never comes.
  await writeOutsideSettings(env, dir);
  const child = spawn(claude, ['-p', '--model', CLAUDE_MODEL, '--permission-mode', 'default', '--setting-sources', 'project,local', '--allowedTools', 'Bash(tail -f keepalive.log)', '--', prompt],
    { cwd: dir, env: { ...outsideClaudeEnv(env), USER: process.env.USER || os.userInfo().username }, detached: true, stdio: 'ignore' });
  held.child = child;
  held.exited = new Promise((resolve) => { child.once('exit', () => { held.done = true; resolve(); }); child.once('error', () => { held.done = true; resolve(); }); });
  child.unref();

  env.step('wait for the row on the rail');
  const listed = await poll(async () => seen.sessions.find((s) => String(s.directory || '').includes(base) || String(s.name || '').includes(base)) || null,
    { timeoutMs: ROW_WITHIN_MS, intervalMs: 500 });
  if (!listed) return result(id, FAIL, `no cos_outside_sessions frame listed the claude in ${base} within ${ROW_WITHIN_MS / 1000}s of its start (the claude ${held.done ? 'had already exited' : 'was still running'})`);
  const row = outsideRows(page, base);
  const there = await poll(async () => (await row.count()) > 0 || null, { timeoutMs: 10000, intervalMs: 250 });
  if (!there) return result(id, FAIL, `the frame listed ${base} but the rail shows no Outside row for it`);
  const problems = [];
  const line = await rowLine(row);
  if (line !== 'Read-only thread') problems.push(`the row offers "${line}", not Read-only thread`);

  env.step('open the thread');
  await openThread(page, row.first());
  const name = (await page.getByTestId('outside-thread-title').innerText({ timeout: 5000 }).catch(() => '')).trim();

  env.step('read the thread');
  if (!(await entryWith(page, 'You', prompt))) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}the thread shows no You entry with the prompt`);
  if (!(await entryWith(page, 'Claude', marker))) return result(id, BLOCKED, `the thread shows no Claude entry with ${marker} within ${REPLY_WITHIN_MS / 1000}s (model output)`);
  // Markdown: the text element holding the marker carries no active content (script, iframe, img, on* attribute).
  const texts = entryOf(page, 'Claude').locator('.outside-thread__text');
  const replies = await texts.evaluateAll((els) => els.map((el) => ({
    text: el.textContent,
    active: el.querySelectorAll('script, iframe, img').length
      + [el, ...el.querySelectorAll('*')].filter((n) => [...n.attributes].some((a) => /^on/i.test(a.name))).length,
  })));
  const said = replies.find((r) => r.text.includes(marker));
  const sample = (said ? said.text : replies.map((r) => r.text).join(' | ')).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!said) problems.push(`no Claude entry carries ${marker} (replies: "${sample}")`);
  else if (said.active > 0) problems.push(`the Claude entry with ${marker} holds ${said.active} active elements or attributes (script, iframe, img, on*) ("${sample}")`);
  const tool = await poll(async () => ((await entryOf(page, 'Tool').count()) > 0) || null, { timeoutMs: REPLY_WITHIN_MS, intervalMs: 1000 });
  if (!tool) problems.push(`the thread shows no Tool entry within ${REPLY_WITHIN_MS / 1000}s (model output, or the Bash call was refused)`);
  else {
    // A tool step reads as a closed details or a short pre, never a raw block.
    const folded = await entryOf(page, 'Tool').first().evaluate((el) => {
      if (el.querySelector('details:not([open])')) return true;
      // A short pre sits outside any details: at most 400 chars and 8 lines.
      return [...el.querySelectorAll('pre')].some((p) => !p.closest('details')
        && p.textContent.length <= 400 && p.textContent.replace(/\n$/, '').split('\n').length <= 8);
    });
    if (!folded) problems.push('the Tool entry holds neither a closed details nor a short pre');
  }

  env.step('check the thread has no controls');
  const thread = threadOf(page);
  if ((await thread.getByRole('textbox').count()) > 0) problems.push('the thread holds a textbox');
  if ((await thread.getByRole('button', { name: /send|stop/i }).count()) > 0) problems.push('the thread holds a Send or Stop button');

  env.step('end the outside claude');
  try { await endProcessTree(child.pid); } catch (err) { problems.push(`could not end the claude: ${firstLine(err)}`); }
  await held.exited;
  const notice = `${name || base} left the Agents list, so its thread closed.`;
  // Closing the tab hides the pane but leaves its nodes in the DOM: gone means hidden, as a person sees it.
  // The toast is watched from the same moment, in its own window, so its 8 s life cannot be missed.
  const toast = expect(page.getByText(notice)).toBeVisible({ timeout: GONE_WITHIN_MS }).then(() => true, () => false);
  const closed = await expect(thread).toBeHidden({ timeout: GONE_WITHIN_MS }).then(() => true, () => false);
  if (!closed) problems.push(`the thread tab is still open ${GONE_WITHIN_MS / 1000}s after the claude ended`);
  const told = await toast;
  if (!told) problems.push(`no notice "${notice}"`);

  env.step('find the Ended row');
  await openChiefOfStaff(page, env);
  const endedFrame = await poll(async () => seen.sessions.find((s) => s.state === 'ended' && String(s.directory || '').includes(base)) || null,
    { timeoutMs: GONE_WITHIN_MS, intervalMs: 500 });
  if (!endedFrame) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}no cos_outside_sessions frame listed an ended row for ${base} within ${GONE_WITHIN_MS / 1000}s of the claude ending`);
  const group = page.getByTestId('rail-agents-group-ended');
  const endedRow = group.locator('[data-state="ended"]').filter({ hasText: base });
  const endedThere = await poll(async () => (await endedRow.count()) > 0 || null, { timeoutMs: 10000, intervalMs: 250 });
  if (!endedThere) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}the frame listed an ended row for ${base} but the Ended group shows none`);
  // The heading is uppercased by CSS, which innerText returns; textContent of the title span is the source text.
  const endedHead = (await group.getByRole('heading').first().locator('span').first().textContent({ timeout: 2000 }).catch(() => '')).trim();
  if (!/^Ended\b/.test(endedHead)) problems.push(`the group holding the ended row is headed "${endedHead}", not Ended`);
  const endedMeta = (await metaOf(endedRow.first())).split(' · ').pop();
  if (endedMeta !== 'Ended') problems.push(`the ended row's line 2 ends with "${endedMeta}", not Ended`);
  // G6.106: the row is no button, and the only button beside it is Resume.
  const besideEnded = group.locator('.agent-row-wrap').filter({ has: page.locator('[data-state="ended"]').filter({ hasText: base }) }).getByRole('button');
  if ((await endedRow.first().evaluate((el) => el.tagName)) !== 'DIV' || (await endedRow.first().locator('button').count()) > 0
    || (await besideEnded.count()) !== 1 || !/^Resume .+ in a terminal$/.test((await besideEnded.first().getAttribute('aria-label')) || '')) problems.push('the ended row is a button, or the only button beside it is not Resume');

  env.step('read the last turn on the Ended row');
  const withTurn = await poll(async () => seen.sessions.find((s) => s.id === endedFrame.id && typeof s.lastExcerpt === 'string' && s.lastExcerpt.includes(marker)) || null,
    { timeoutMs: GONE_WITHIN_MS, intervalMs: 500 });
  if (!withTurn) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}no cos_outside_sessions frame gave the ended row for ${base} a lastExcerpt holding ${marker} within ${GONE_WITHIN_MS / 1000}s`);
  const turnLine = endedRow.first().locator('[data-kind="last-turn"]');
  const turnShown = await expect(turnLine).toContainText(marker, { timeout: 10000 }).then(() => true, () => false);
  if (!turnShown) problems.push(`line 3 of the ended row does not show ${marker}`);

  env.step('ask the Chief of Staff to summarize the ended session');
  const endedName = String(withTurn.name || name || base);
  const from = await say(page, seen, `Summarize the outside session ${endedName}. Quote its last reply.`);
  const post = await waitPost(seen, from, ['reply', 'notice', 'start_card', 'started']);
  if (!post) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}no post within ${COS_TURN_WITHIN_MS / 1000}s of Return on the summary question`);
  const summary = String(post.body || post.text || post.error || '').replace(/\s+/g, ' ').trim();
  if (post.kind !== 'reply') problems.push(`the summary question posted "${post.kind}", want reply: "${summary.slice(0, 160)}"`);
  else if (!summary.includes(marker)) problems.push(`the summary reply does not carry ${marker}: "${summary.slice(0, 200)}"`);

  env.step('tap Resume on the Ended row');
  // Registered before the tap: whatever terminal the answer names is closed, even on a failure path.
  let resumedId = '';
  env.cleanup('close the resumed terminal', async () => { if (resumedId) await env.api.closeTerminal(resumedId).catch(() => {}); });
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/outside-sessions/${encodeURIComponent(endedFrame.id)}/resume`), { timeout: GONE_WITHIN_MS })
    .then((r) => r.json()).catch(() => null);
  if ((await besideEnded.count()) !== 1) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}no single Resume button beside the ended row for ${base}, so Resume was not tapped`);
  const clickedAt = Date.now();
  await besideEnded.first().click({ timeout: 5000 });
  const answer = await answered;
  resumedId = answer?.terminal?.terminalId || '';
  if (!resumedId) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}Resume on ${base} opened no terminal (answer: ${JSON.stringify(answer || null).slice(0, 160)})`);
  const tabOpen = await poll(async () => (await page.locator('.tab.active').and(page.locator(`[data-tab-id="${resumedId}"]`)).count()) > 0 || null, { timeoutMs: TRUST_WITHIN_MS, intervalMs: 250 });
  if (!tabOpen) return result(id, FAIL, `${problems.join('; ')}${problems.length ? '; ' : ''}no active terminal tab for the resumed ${base} within ${TRUST_WITHIN_MS / 1000}s of Resume`);

  env.step('wait for the conversation in the terminal');
  const termPane = page.locator('#terminal');
  let trustAnswered = false;
  const history = await poll(async () => {
    // xterm wraps rows even mid-word: compare with whitespace gone, over the rows and the scrollback.
    const visible = await termPane.innerText({ timeout: 2000 }).catch(() => '');
    const buffered = await page.evaluate(() => {
      const b = window.client?.terminalManager?.activeTerm?.()?.buffer?.active;
      if (!b) return '';
      let out = '';
      for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) || '') + '\n';
      return out;
    }).catch(() => '');
    const flat = `${visible}${buffered}`.replace(/\s+/g, '');
    if (flat.includes(marker)) return true;
    if (!trustAnswered && /trust/i.test(flat)) {
      trustAnswered = true;
      await termPane.locator('.xterm-screen').filter({ visible: true }).last().click({ timeout: 5000 });
      await page.keyboard.press('Enter');
    }
    return null;
  }, { timeoutMs: Math.max(1, clickedAt + REPLY_WITHIN_MS - Date.now()), intervalMs: 500 });
  if (!history) problems.push(`"${marker}" is not in the resumed terminal within ${REPLY_WITHIN_MS / 1000}s of Resume${trustAnswered ? ' (a trust prompt was answered)' : ''}`);

  env.step('close the resumed terminal');
  await page.locator('.tab.active .tab-close').click({ timeout: 5000 });
  const gone = await expect(page.locator(`[data-tab-id="${resumedId}"]`)).toHaveCount(0, { timeout: GONE_WITHIN_MS }).then(() => true, () => false);
  if (!gone) problems.push(`the tab for terminal ${resumedId} is still open ${GONE_WITHIN_MS / 1000}s after Close`);

  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `the row for ${base} read Read-only thread; its thread showed a You entry with the prompt, a Claude entry carrying ${marker} with no script, iframe, img or on* attribute ("${sample}") and a Tool entry shown as a closed details or a short pre, with no textbox, Send or Stop; `
    + `once the claude ended the tab closed with "${notice}" within ${GONE_WITHIN_MS / 1000}s; `
    + `an ended row for ${base} sat under Ended with Ended in line 2 and Resume as its only button, line 3 showed ${marker}, and the Chief of Staff's summary quoted it; `
    + `Resume opened a terminal tab that held ${marker} from the ended conversation, and closing it closed the tab`);
}

module.exports = {
  metaProblems,
  journeys: {
    cosOutsideSimple: {
      id: 'cos-outside-simple', claude: true, timeoutMs: 600000, areas: ['chief-of-staff'], needs: ['project:acme'], screen: true, run: cosOutsideSimple,
    },
    outsideThread: {
      id: 'outside-thread', claude: true, timeoutMs: 720000, areas: ['chief-of-staff'], needs: ['project:acme'], run: outsideThread,
    },
    cosOutsideHooks: {
      id: 'cos-outside-hooks', claude: true, timeoutMs: 360000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosOutsideHooks,
    },
  },
};
