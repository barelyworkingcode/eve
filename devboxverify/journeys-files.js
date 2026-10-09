// The file-plane journeys: an agent's edit reaching the Changes tab, and files
// in a project on an SSH host. See docs/design-devboxverify.md.
// The helpers live in journeys.js, which requires this file at its bottom, so
// they are fetched when a journey runs, never at load (a circular require).
// No detail here ever holds a token or credential id.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { expect } = require('@playwright/test');
const { PASS, FAIL, BLOCKED, result, firstLine, need, poll, openEve, waitForModels, openProject, acmeIds, addedIds, deleteSession } = require('./journey-kit');

const exec = promisify(execFile);
const kit = () => require('./journeys');

const TURN_WITHIN_MS = 90000;
const CHANGES_WITHIN_MS = 15000;
const CRED_TTL = '15m';
const HOST_CONNECTED_WITHIN_MS = 30000;
const FILE_OP_WITHIN_MS = 15000;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);
// Every live model in a journey is Haiku; system/init names the model that ran.
const INIT_MODEL = 'claude-haiku-5-5';

// Null when `text` holds `line` as a whole line; else why the journey is BLOCKED.
function agentEditProblem(text, line, file) {
  return String(text).split(/\r?\n/).includes(line) ? null : `the agent did not edit ${file} (model output)`;
}

// The model the session's system/init event names, or null.
function initModel(frames) {
  const init = frames.find((f) => f.type === 'llm_event' && f.event?.type === 'system' && f.event?.subtype === 'init');
  return init ? init.event.model || null : null;
}

// The id of a 201 create answer, or what went wrong. `what` names the call.
function createdId(what, resp) {
  if (!resp || !resp.status) return { id: '', problem: `${what}: no answer` };
  if (resp.status !== 201) return { id: '', problem: `${what} answered ${resp.status}` };
  const id = resp.json && typeof resp.json.id === 'string' ? resp.json.id : '';
  return id ? { id, problem: '' } : { id: '', problem: `${what} answered 201 without an id` };
}

// Asks a haiku session in the project, over a socket of the harness's own, to
// append `line` to `rel` (relative to the project root), and waits for the
// turn to end. `states` is sessionStates(page) of a page opened before the call.
// `listIds` (optional) lists the project's sessions so a cleanup registered
// before the session exists deletes whatever appeared. `held` (optional,
// { sock, sid }) is filled in for a caller whose own cleanup closes and deletes
// them; the helper then registers none. Returns
// { problem: result|null }, where the result is the journey's BLOCKED or FAIL.
async function askAgentToAppend(env, id, { project, states, model, rel, line, listIds, held }) {
  const { openEveSocket } = kit();
  const mine = held || { sock: null, sid: '' };
  const before = listIds ? await listIds() : [];
  if (!held) {
    env.cleanup(`close the socket and delete the ${project.name} agent session`, async () => {
      if (mine.sock) mine.sock.close();
      const ids = new Set(mine.sid ? [mine.sid] : []);
      if (listIds) addedIds(before, await listIds()).forEach((s) => ids.add(s));
      let failure = null;
      for (const s of ids) await deleteSession(env, s).catch((err) => { failure = failure || err; });
      if (failure) throw failure;
    });
  }

  env.step('create the agent session');
  const sock = await openEveSocket(env);
  mine.sock = sock;
  sock.send({ type: 'create_session', projectId: project.id, model, name: `verify-${env.nonce}-edit`, settings: { permissionMode: 'acceptEdits' } });
  const made = await poll(async () => sock.frames.find((f) => f.type === 'session_created' || f.type === 'error') || null,
    { timeoutMs: 60000, intervalMs: 200 });
  if (!made) return { problem: result(id, FAIL, `no session_created within 60s of create_session (model ${model})`) };
  if (made.type === 'error') {
    return { problem: /template "/.test(String(made.message))
      ? result(id, BLOCKED, `launch refused: ${made.message}`)
      : result(id, FAIL, `create_session failed: ${made.message}`) };
  }
  const sid = made.sessionId;
  mine.sid = sid;
  sock.send({ type: 'join_session', sessionId: sid });

  env.step('ask the agent to edit the file');
  const sentAt = Date.now();
  sock.send({
    type: 'user_input', sessionId: sid,
    text: `Use your Edit tool to append the exact line "${line}" as a new last line of the file ${rel} `
      + '(the path is relative to the project folder). Change nothing else, then reply: done.',
  });
  // A person allows the file tools relay's hook asks about (acceptEdits still
  // asks for Read); anything else is denied, so the edit stays the agent's own.
  const answered = new Set();
  const ended = await poll(async () => {
    for (const f of sock.frames) {
      if (f.type !== 'permission_request' || f.sessionId !== sid || answered.has(f.permissionId)) continue;
      answered.add(f.permissionId);
      sock.send({ type: 'permission_response', permissionId: f.permissionId, approved: FILE_TOOLS.has(f.toolName) });
    }
    return states.find((f) => f.sessionId === sid && f.at >= sentAt && (f.state === 'idle' || f.state === 'errored')) || null;
  }, { timeoutMs: TURN_WITHIN_MS, intervalMs: 200 });
  if (!ended) return { problem: result(id, FAIL, `session ${sid}: turn did not end within ${TURN_WITHIN_MS / 1000}s`) };
  if (ended.state !== 'idle') return { problem: result(id, FAIL, `session ${sid}: the turn ended ${ended.state}, not idle`) };
  const ran = initModel(sock.frames);
  if (ran !== INIT_MODEL) return { problem: result(id, BLOCKED, `session ${sid}: system/init reported model ${ran || 'none'}, not ${INIT_MODEL}`) };
  return { problem: null };
}

// `relay audit --event file_op --json` lines for one project since a mark, oldest
// first: the completed (outcome ok) mutations relay recorded, as
// { tool, path } with the path root-relative and no leading slash. Reads are
// never recorded, and an intent row (outcome pending) is not a finished write.
function fileOpRows(jsonl, { projectId, sinceMs }) {
  const rows = [];
  for (const line of String(jsonl).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o && o.ts);
    if (!o || o.event !== 'file_op' || (o.actor && o.actor.project_id) !== projectId || !(ts >= sinceMs) || o.outcome !== 'ok') continue;
    rows.push({ ts, tool: o.tool || '', path: String((o.args && o.args.path) || '').replace(/^\/+/, '') });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

// The `wanted` ({ tool, path }) mutations that are not among `rows`.
function missingFileOps(rows, wanted) {
  return wanted.filter((w) => !rows.some((r) => r.tool === w.tool && r.path === w.path.replace(/^\/+/, '')));
}

// Looks for the journey's writes as file_op rows in relay's audit. Returns null
// when every wanted write is there, else the sentence a FAIL carries.
// Waits: none possible: relay writes the completion row after the response,
// with no hook visible to the harness; a bounded poll on `relay audit --event file_op`.
async function auditFileOps(env, project, sinceMs, wanted) {
  let rows = [];
  const found = await poll(async () => {
    const { stdout } = await exec(env.relayBin, ['audit', '--event', 'file_op', '--project', project.id, '--json', '--tail', '200'],
      { timeout: 10000, maxBuffer: 16 << 20 });
    rows = fileOpRows(stdout, { projectId: project.id, sinceMs });
    return missingFileOps(rows, wanted).length === 0;
  }, { timeoutMs: FILE_OP_WITHIN_MS, intervalMs: 500 });
  if (found) return null;
  const missing = missingFileOps(rows, wanted).map((w) => `${w.tool} ${w.path}`).join(', ');
  return `relay audit has no file_op ok row for ${missing} from ${project.name} within ${FILE_OP_WITHIN_MS / 1000}s of the save `
    + `(it has ${rows.map((r) => `${r.tool} ${r.path}`).join(', ') || 'none'})`;
}

// The agent's edit reaches an open Changes tab with no reload.
// Waits: none possible: model output. The file is read once after the turn.
async function changesAgentEdit(env) {
  const id = 'changes-agent-edit';
  const { scratchFolder, commitOneFile, sessionStates } = kit();
  const acme = env.world.projects.acme;
  env.step('set up a clean repo');
  const dir = await scratchFolder(env, 'agentedit');
  const repo = path.basename(dir);
  const file = path.join(dir, 'notes.md');
  await fs.promises.writeFile(file, '# Notes\nfirst line\n');
  await commitOneFile(dir, 'notes.md');

  const page = await env.newPage();
  const states = sessionStates(page);
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, acme);
  env.step('open the Changes tab');
  await page.getByTestId('panel-tab-changes').click({ timeout: 10000 });
  const panel = page.getByTestId('changes-panel');
  await need(`the Changes tab does not list ${repo} within 15s`,
    expect(panel.getByTestId(`changes-repo-/${repo}`)).toContainText(repo, { timeout: 15000 }));
  const row = panel.getByTestId(`changes-file-/${repo}:notes.md`);
  await need('notes.md is listed as changed before the agent touched it', expect(row).toHaveCount(0, { timeout: 5000 }));

  const offered = await page.evaluate((pid) => (window.client.state.modelsForProject(pid) || []).map((m) => m.value), acme.id);
  // Exact id on purpose, as agent-drop-in: the alias is what relay launches.
  const model = offered.find((v) => v === 'haiku') || null;
  if (!model) return result(id, BLOCKED, `the haiku model id is not offered for ${acme.name}`);

  const line = `agent edit ${env.nonce}`;
  const { problem } = await askAgentToAppend(env, id, {
    project: acme, states, model, rel: `${repo}/notes.md`, line, listIds: () => acmeIds(env, 'sessions'),
  });
  if (problem) return problem;
  env.step('read the file once');
  const blocked = agentEditProblem(await fs.promises.readFile(file, 'utf8'), line, 'notes.md');
  if (blocked) return result(id, BLOCKED, blocked);

  env.step('look for the row, with no reload');
  await need(`the Changes tab does not list notes.md within ${CHANGES_WITHIN_MS / 1000}s of the agent's edit`,
    expect(row).toContainText('notes.md', { timeout: CHANGES_WITHIN_MS }));
  await need('notes.md is listed but not marked modified',
    expect(row.locator('.changes-panel__status')).toHaveText('M', { timeout: 5000 }));
  return result(id, PASS, `model ${model}: after the agent appended a line to notes.md the open Changes tab listed it as M with no reload`);
}

// Mints a configure credential and registers ONE cleanup that, in order,
// deletes the host project's session, the project, the host, the scratch
// folder, then revokes the credential. Deliberate: cleanups run in the order
// they were registered, and the revoke must come last. The returned `state`
// is filled in as things are made; the cleanup removes whatever is set.
async function mintForHost(env, id) {
  const { frontendSocketIn, frontendRequest, parseMintOutput } = kit();
  const sockDir = path.join(os.homedir(), 'Library', 'Application Support', 'relay');
  const sockName = frontendSocketIn(await fs.promises.readdir(sockDir).catch(() => []));
  if (!sockName) return { problem: result(id, BLOCKED, 'relay has no single frontend socket in its config folder') };
  const socket = path.join(sockDir, sockName);

  env.step('mint a configure credential');
  const credName = `devbox-verify-files-host-${env.nonce}`;
  const mintPresence = env.screen.answerPresence({ expect: `named "${credName}"` });
  if (!(await mintPresence.ready)) return { problem: result(id, BLOCKED, `presence dialog ${(await mintPresence.result).state}`) };
  const state = { token: '', credId: '', projectId: '', hostId: '', dir: '', held: { sock: null, sid: '' } };
  try {
    const { stdout: out } = await exec(
      env.relayBin, ['credential', 'mint', '--name', credName, '--class', 'configure', '--ttl', CRED_TTL], { timeout: 30000 });
    ({ id: state.credId, token: state.token } = parseMintOutput(out));
  } catch {
    const { state: s } = await mintPresence.result;
    return { problem: result(id, s === 'answered' ? FAIL : BLOCKED, s === 'answered' ? 'relay credential mint failed' : `presence dialog ${s}`) };
  }
  await mintPresence.result;
  if (!state.credId) return { problem: result(id, FAIL, 'relay credential mint printed no id') };

  // Deliberate: the realpath, since the folder is kept as one (/var is a symlink on macOS).
  const tmpRoot = await fs.promises.realpath(os.tmpdir());
  const prefix = `verify-${env.nonce}-host-`;
  // Registered as soon as an id exists, so it also runs on FAIL and on timeout.
  env.cleanup(`remove the host project, host and folder, and revoke credential ${state.credId}`, async () => {
    const problems = [];
    const del = async (what, urlPath) => {
      try {
        const res = await frontendRequest(socket, state.token, 'DELETE', urlPath);
        if (res.status !== 204 && res.status !== 404) problems.push(`DELETE ${what} answered ${res.status}`);
      } catch (err) { problems.push(`could not delete ${what} (${firstLine(err)})`); }
    };
    if (state.held.sock) state.held.sock.close();
    if (state.held.sid) await deleteSession(env, state.held.sid).catch((err) => problems.push(`could not delete the session (${firstLine(err)})`));
    if (state.projectId) await del('project', `/api/projects/${state.projectId}`);
    if (state.hostId) await del('host', `/api/hosts/${state.hostId}`);
    if (state.dir) {
      if (path.dirname(state.dir) !== tmpRoot || !path.basename(state.dir).startsWith(prefix)) {
        problems.push('refused to remove a folder outside the temp dir');
      } else {
        await fs.promises.rm(state.dir, { recursive: true, force: true }).catch((err) => problems.push(`could not remove the folder (${firstLine(err)})`));
      }
    }
    state.token = '';
    const revokePresence = env.screen.answerPresence({ expect: `"${state.credId}"` });
    if (!(await revokePresence.ready)) {
      problems.push(`credential ${state.credId} not revoked (presence dialog ${(await revokePresence.result).state}); revoke it by hand`);
    } else {
      const revoked = await exec(
        env.relayBin, ['credential', 'revoke', '--id', state.credId], { timeout: 30000 }).then(() => true, () => false);
      const { state: s } = await revokePresence.result;
      if (!revoked) problems.push(`credential ${state.credId} not revoked (presence dialog ${s}); revoke it by hand`);
    }
    if (problems.length) throw new Error(problems.join('; '));
  }, 120000);
  if (!state.token) return { problem: result(id, FAIL, 'relay credential mint printed no token') };
  return { state, socket, prefix, tmpRoot };
}

// A project on a loopback SSH host, made through relay's API: open and save a
// file, see a file made outside eve, and see an agent's edit in Changes.
// Waits: none possible: model output (the agent edit; checked once after the turn).
async function filesOnHost(env) {
  const id = 'files-on-host';
  const { commitOneFile, sessionStates, frontendRequest, endOfFile } = kit();
  const made = await mintForHost(env, id);
  if (made.problem) return made.problem;
  const { state, socket, prefix, tmpRoot } = made;

  env.step('make the loopback host');
  const hostName = `loopback-${env.nonce}`;
  const host = createdId('POST /api/hosts', await frontendRequest(socket, state.token, 'POST', '/api/hosts',
    { name: hostName, target: 'localhost', tmux_path: '/usr/bin/tmux' }, 30000));
  if (host.problem) return result(id, host.problem.includes('answered') ? FAIL : BLOCKED, host.problem);
  state.hostId = host.id;

  env.step('make a repo for the host project');
  state.dir = await fs.promises.mkdtemp(path.join(tmpRoot, prefix));
  const dir = state.dir;
  await fs.promises.writeFile(path.join(dir, 'notes.md'), '# Notes\nfirst line\n');
  await fs.promises.writeFile(path.join(dir, 'agent.md'), '# Agent\nstart\n');
  await commitOneFile(dir, 'notes.md');
  await commitOneFile(dir, 'agent.md');

  env.step('make the host project');
  const projName = `Verify Files Host ${env.nonce}`;
  const presence = env.screen.answerPresence({ expect: `"${projName}"` });
  if (!(await presence.ready)) return result(id, BLOCKED, `presence dialog ${(await presence.result).state}`);
  const created = createdId('POST /api/projects', await frontendRequest(socket, state.token, 'POST', '/api/projects',
    { name: projName, path: dir, host_id: state.hostId, allowed_templates: ['claude-code'] }, 60000));
  await presence.result;
  if (created.problem) return result(id, FAIL, created.problem);
  state.projectId = created.id;
  const project = { id: created.id, name: projName };

  const page = await env.newPage();
  const states = sessionStates(page);
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, project);
  // eve starts the host's file agent on the first file call, so the Files
  // tab opens before the host can read connected.
  await page.getByTestId('panel-tab-files').click({ timeout: 10000 });
  env.step('wait for the host to read connected');
  const bar = page.locator('#panelHostBar');
  const connected = await expect(bar).toHaveClass(/panel-host-bar--connected/, { timeout: HOST_CONNECTED_WITHIN_MS }).then(() => true, () => false);
  if (!connected) {
    const shown = await bar.evaluate((el) => `${el.className} "${el.textContent.trim()}" ${el.hidden ? 'hidden' : 'shown'}`).catch(() => 'no host bar');
    return result(id, FAIL, `the host did not show connected within ${HOST_CONNECTED_WITHIN_MS / 1000}s (host bar: ${shown})`);
  }

  env.step('open notes.md');
  await page.getByTestId('file-tree-item-/notes.md').click({ timeout: 15000 });
  const text = page.locator('#monacoEditor .view-lines');
  await need('notes.md did not open with "first line" within 15s', expect(text).toContainText('first line', { timeout: 15000 }));

  env.step('edit and save');
  const saved = `saved ${env.nonce}`;
  const savedAt = Date.now();
  const label = page.locator('.tab.active .tab-label');
  await endOfFile(page, text);
  await page.keyboard.type(saved);
  await need('the tab shows no unsaved mark after typing', expect(label).toContainText('●', { timeout: 5000 }));
  await page.keyboard.press('ControlOrMeta+s');
  await need('the tab still shows the unsaved mark 15s after ⌘S', expect(label).not.toContainText('●', { timeout: 15000 }));
  // The host is this machine, so its disk is the same disk.
  if (!(await fs.promises.readFile(path.join(dir, 'notes.md'), 'utf8')).includes(saved)) {
    return result(id, FAIL, 'the saved line is not on the host\'s disk after the unsaved mark cleared');
  }
  env.step('look for the save in relay\'s audit');
  const unaudited = await auditFileOps(env, project, savedAt, [{ tool: 'write', path: 'notes.md' }]);
  if (unaudited) return result(id, FAIL, unaudited);

  env.step('make a file outside eve');
  const outside = `outside-${env.nonce}.md`;
  await fs.promises.writeFile(path.join(dir, outside), '# Outside\n');
  await need(`a file made outside eve did not show in the host project's open tree within 15s`,
    expect(page.getByTestId(`file-tree-item-/${outside}`)).toBeVisible({ timeout: 15000 }));

  env.step('open the Changes tab');
  await page.getByTestId('panel-tab-changes').click({ timeout: 10000 });
  const panel = page.getByTestId('changes-panel');
  // The project folder is the repo, so its path is the root.
  const row = panel.getByTestId('changes-file-/:agent.md');
  await need('the Changes tab does not list the project\'s repo within 15s',
    expect(panel.getByTestId('changes-repo-/')).toBeVisible({ timeout: 15000 }));
  await need('agent.md is listed as changed before the agent touched it', expect(row).toHaveCount(0, { timeout: 5000 }));

  const offered = await page.evaluate((pid) => (window.client.state.modelsForProject(pid) || []).map((m) => m.value), project.id);
  const model = offered.find((v) => v === 'haiku') || null;
  if (!model) return result(id, BLOCKED, `the haiku model id is not offered for ${projName}`);
  const line = `agent edit ${env.nonce}`;
  const asked = await askAgentToAppend(env, id, { project, states, model, rel: 'agent.md', line, held: state.held });
  if (asked.problem) return asked.problem;
  env.step('read the file once');
  const blocked = agentEditProblem(await fs.promises.readFile(path.join(dir, 'agent.md'), 'utf8'), line, 'agent.md');
  if (blocked) return result(id, BLOCKED, blocked);

  env.step('look for the row, with no reload');
  await need(`the Changes tab does not list agent.md within ${CHANGES_WITHIN_MS / 1000}s of the agent's edit`,
    expect(row).toContainText('agent.md', { timeout: CHANGES_WITHIN_MS }));
  await need('agent.md is listed but not marked modified',
    expect(row.locator('.changes-panel__status')).toHaveText('M', { timeout: 5000 }));
  return result(id, PASS, `the host read connected; notes.md saved to the host's disk and recorded as a file_op write in relay's audit; a file made outside eve showed in the open tree; `
    + `after the agent (${model}) edited agent.md the Changes tab listed it as M`);
}

const journeys = {
  changesAgentEdit: { id: 'changes-agent-edit', timeoutMs: 150000, areas: ['git', 'chat'], needs: ['project:acme'], run: changesAgentEdit },
  filesOnHost: {
    id: 'files-on-host', timeoutMs: 240000, areas: ['hosts', 'files', 'git'], needs: [], screen: true, run: filesOnHost,
  },
};

module.exports = { journeys, agentEditProblem, createdId, initModel, fileOpRows, missingFileOps, auditFileOps };
