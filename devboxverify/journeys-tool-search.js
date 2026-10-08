// The chat-tool-search journey (simple path of relayLLM#29): in a project with
// far more tools than a model should be sent at once, a web chat finds the one
// it needs through tool_search and answers from it. See README.md.
// Verdicts rest on the visible thread; relay's audit and relay-sessions' log
// are the second witnesses. The harness edits no settings: a box whose chat
// config turns tool search off is BLOCKED, never changed.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { expect } = require('@playwright/test');
const {
  PASS, FAIL, BLOCKED, result, sleep, now, seconds, need, poll, pickModel, optionValues, openEve, waitForModels,
  openProject, openLauncher, captureErrors, thread, threadError, eveJson, callToolRows, deleteSession,
} = require('./journey-kit');

const exec = promisify(execFile);
const PROJECT_NAME = 'Verify Skills';
const LOOKUP_TOOL = 'tides_lookup';
const MIN_SKILLS = 40;
const AUDIT_SLACK_MS = 2000;
const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'relay');
const CHAT_CONFIG = path.join(SUPPORT, 'sessions', 'chat.json');
const SESSIONS_LOG = path.join(SUPPORT, 'logs', 'relaysessions.log');

// The tool's contract: 'TIDE-' + first 8 lowercase hex of sha256(lower(trim(port))).
const tideCode = (port) => `TIDE-${crypto.createHash('sha256').update(String(port).trim().toLowerCase()).digest('hex').slice(0, 8)}`;

// The top-level `toolSearch` of the parsed chat config; its mode is the value
// itself or its `mode`. undefined when the config does not set one there.
function toolSearchMode(node) {
  if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, 'toolSearch')) return undefined;
  const v = node.toolSearch;
  return typeof v === 'string' ? v : (v && typeof v === 'object' ? v.mode : v);
}

// Tool steps as the thread shows them, top to bottom: the name, what the model
// sent, and what came back. textContent, so a collapsed step still reads.
async function toolSteps(page) {
  return page.getByTestId('messages-container').evaluate((root) =>
    [...root.querySelectorAll('[data-testid="message-tool-use"]')].map((el) => ({
      name: (el.querySelector('.tool-name')?.textContent || '').trim(),
      input: (el.querySelector('.tool-detail')?.textContent || '').trim(),
      output: (el.querySelector('.tool-result')?.textContent || '').trim(),
    })), null, { timeout: 10000 });
}

// A second witness for what a call_tool step was asked to run: the WebSocket
// frames, independent of how the thread draws the step. This records every
// tool_use the session's llm_event frames carry, in arrival order: a full
// assistant message block, a content_block start, or a content_block_stop
// (the one with the final input). Frames may arrive inside a __batch.
function recordToolUses(page) {
  const uses = [];
  const take = (m) => {
    if (!m || m.type !== 'llm_event' || !m.event || m.event.type !== 'assistant') return;
    const e = m.event;
    const blocks = [];
    for (const b of (e.message && e.message.content) || []) blocks.push({ block: b, stop: true });
    if (e.content_block) blocks.push({ block: e.content_block, stop: Boolean(e.content_block_stop) });
    for (const { block, stop } of blocks) {
      if (!block || block.type !== 'tool_use') continue;
      let input = block.input;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* keep the string */ } }
      uses.push({ sessionId: m.sessionId, name: block.name, input, stop });
    }
  };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { return; }
    if (frame.type === '__batch' && Array.isArray(frame.msgs)) frame.msgs.forEach(take);
    else take(frame);
  }));
  return uses;
}

// A direct tides_lookup call, or call_tool whose argument `name` is tides_lookup.
const lookupFrame = (u) => u.name === LOOKUP_TOOL
  || (u.name === 'call_tool' && Boolean(u.input) && typeof u.input === 'object' && u.input.name === LOOKUP_TOOL);
const describeUse = (u) => `${u.name}${u.input && typeof u.input === 'object' && u.input.name ? `(${u.input.name})` : ''}`;

// The thread's tool steps against the search-first rule: the index of the
// tool_search step, or { error } naming why the order fails.
function searchStep(steps) {
  const stepNames = steps.map((s) => s.name).join(', ') || 'none';
  const first = steps[0];
  if (!first || first.name !== 'tool_search') {
    return { error: `the first tool step is ${first ? `"${first.name}"` : 'missing'}, not tool_search (steps: ${stepNames})` };
  }
  if (!first.output.includes(LOOKUP_TOOL)) {
    return { error: `the tool_search result does not name ${LOOKUP_TOOL}: ${first.output.slice(0, 200)}` };
  }
  return { index: 0 };
}

async function logSince(mark) {
  let fh;
  try { fh = await fs.promises.open(SESSIONS_LOG, 'r'); } catch { return ''; }
  try {
    const { size } = await fh.stat();
    const from = size < mark ? 0 : mark;
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}
const logSize = () => fs.promises.stat(SESSIONS_LOG).then((s) => s.size, () => 0);

// The session's chat.tool_search summary line, or null. Warn lines share the
// op and session id, so the summary is the one with msg "chat tool search" or
// an `active` field. Fields may sit at the top level of the record or under `fields`.
function toolSearchLine(text, sessionId) {
  for (const line of text.split('\n')) {
    if (!line.includes('chat.tool_search') || !line.includes(sessionId)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.op !== 'chat.tool_search') continue;
    const pick = (k) => (o[k] !== undefined ? o[k] : o.fields && o.fields[k]);
    if (o.msg !== 'chat tool search' && pick('active') === undefined) continue;
    return { active: pick('active'), reason: pick('reason'), skills: Number(pick('skills')), sent: Number(pick('tools_sent')), total: Number(pick('tools_total')) };
  }
  return null;
}

async function relayRows(env, event, project) {
  const args = ['audit', '--event', event, '--project', project.id, '--json', '--tail', '200'];
  const { stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 32 << 20 });
  return stdout;
}

// Evidence for a FAIL: the tool_use blocks the WebSocket frames carried for the
// session, in order, then each tool step's output. Best effort; never throws.
async function traceDetail(ctx) {
  const clip = (v) => (typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v) || '').slice(0, 200);
  const parts = [];
  const uses = (ctx.toolUses || []).filter((u) => !ctx.sessionId || u.sessionId === ctx.sessionId);
  parts.push(`tool_use frames: ${uses.map((u) => `${u.name}(${clip(u.input)})`).join(', ') || 'none'}`);
  try {
    const steps = await toolSteps(ctx.page);
    parts.push(`tool step outputs: ${steps.map((s, i) => `${i + 1}. ${s.name}: ${s.output.slice(0, 200)}`).join(' | ') || 'none'}`);
  } catch (err) {
    parts.push(`tool step outputs unavailable: ${String(err && err.message || err).split('\n')[0]}`);
  }
  return parts.join('; ');
}

async function chatToolSearch(env) {
  const ctx = {};
  const res = await chatToolSearchRun(env, ctx);
  if (res.state === FAIL && ctx.page) res.detail += ` [${await traceDetail(ctx)}]`;
  return res;
}

async function chatToolSearchRun(env, ctx) {
  const id = 'chat-tool-search';
  let chatConfig = null;
  try { chatConfig = await fs.promises.readFile(CHAT_CONFIG, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return result(id, BLOCKED, `cannot read chat.json: ${err.code || err.message}`); }
  if (chatConfig !== null) {
    let parsed;
    try { parsed = JSON.parse(chatConfig); } catch { return result(id, BLOCKED, 'chat.json is not valid JSON'); }
    const mode = toolSearchMode(parsed);
    if (mode !== undefined && mode !== 'auto') return result(id, BLOCKED, `chat.json sets toolSearch to "${mode}", not auto`);
  }
  const project = (await eveJson(env, 'GET', '/api/projects')).find((p) => p.name === PROJECT_NAME);
  if (!project) return result(id, BLOCKED, `no project named "${PROJECT_NAME}" on this box`);

  const page = await env.newPage();
  const errors = captureErrors(page);
  const toolUses = recordToolUses(page);
  ctx.page = page;
  ctx.toolUses = toolUses;
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, project);
  const mine = async () => (await eveJson(env, 'GET', '/api/sessions')).filter((s) => s.projectId === project.id).map((s) => s.id);
  const before = await mine();
  // Deliberate: this project is not in the world, so neither the leak check
  // nor the sweep would remove a session. relay-sessions logs its summary at
  // provider Start, so the log mark is taken before the click too.
  env.cleanup('delete the tool-search sessions', async () => {
    for (const sid of (await mine()).filter((s) => !before.includes(s))) await deleteSession(env, sid);
  });
  const logMark = await logSize();

  const dialog = await openLauncher(page, env, project);
  env.step('open the Web Chat form');
  await dialog.getByTestId('shell-card-web-chat').click({ timeout: 10000 });
  const select = dialog.getByTestId('launcher-model-select');
  const model = pickModel(await optionValues(select), env.model);
  if (!model) return result(id, BLOCKED, `model "${env.model}" is not offered for ${PROJECT_NAME}`);
  await select.selectOption(model, { timeout: 5000 });
  env.step('start the chat');
  await dialog.getByRole('button', { name: 'Start Chat' }).click({ timeout: 5000 });
  const failed = (detail) => {
    const refusal = errors.find((e) => /template "chat"/.test(e));
    return refusal ? result(id, BLOCKED, `launch refused: ${refusal}`) : result(id, FAIL, detail);
  };

  env.step('wait for the session');
  const created = await poll(async () => {
    if ((await mine()).some((s) => !before.includes(s))) return {};
    const error = threadError(await thread(page));
    return error ? { error } : null;
  }, { timeoutMs: 30000, intervalMs: 1000 });
  if (!created) return failed(`no ${PROJECT_NAME} session within 30s of Start Chat`);
  if (created.error) return failed(`error in the thread: ${created.error}`);
  const added = (await mine()).filter((s) => !before.includes(s));
  if (added.length !== 1) return result(id, FAIL, `${added.length} new ${PROJECT_NAME} sessions, expected 1`);
  const sessionId = added[0];
  ctx.sessionId = sessionId;

  const port = env.nonce;
  const expected = tideCode(port);
  const question = `What is the tide code for the port "${port}"? Reply with the code only.`;
  const input = page.getByTestId('chat-input');
  env.step('wait for the composer');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  await input.fill(question, { timeout: 5000 });
  env.step('send the question');
  const sentAt = Date.now();
  const sentMono = now();
  await page.getByTestId('chat-submit').click({ timeout: 5000 });
  await need('the question is not shown as the user message', expect(
    page.getByTestId('messages-container').getByTestId('message-user').filter({ hasText: env.nonce }),
  ).toBeVisible({ timeout: 10000 }));

  env.step('wait for the reply');
  const stop = page.getByTestId('chat-stop');
  const settled = await poll(async () => {
    const messages = await thread(page);
    const error = threadError(messages);
    if (error) return { error };
    const at = messages.findIndex((m) => m.who === 'message-user' && m.text.includes(env.nonce));
    const reply = messages.slice(at + 1).filter((m) => m.who === 'message-assistant' && m.text).map((m) => m.text).join('\n').trim();
    if (reply && !(await stop.isVisible())) return { reply };
    return null;
  }, { timeoutMs: 150000, intervalMs: 1000 });
  if (!settled) return failed('no finished assistant reply within 150s');
  if (settled.error) return failed(`error in the thread: ${settled.error}`);
  await sleep(500);

  const steps = await toolSteps(page);
  const messages = await thread(page);
  const shown = messages.map((m) => `${m.who.replace('message-', '')}: ${m.text}`).join(' | ').slice(0, 400);
  const stepNames = steps.map((s) => s.name).join(', ') || 'none';
  const search = searchStep(steps);
  if (search.error) return result(id, FAIL, `${search.error}; thread: ${shown}`);
  const mineUses = toolUses.filter((u) => u.sessionId === sessionId);
  const searchAt = mineUses.findIndex((u) => u.name === 'tool_search');
  const laterLookup = searchAt >= 0 && mineUses.slice(searchAt + 1).some(lookupFrame);
  if (!steps.slice(search.index + 1).some((s) => s.name === LOOKUP_TOOL) && !laterLookup) {
    const seen = mineUses.map(describeUse).join(', ') || 'none';
    return result(id, FAIL, `no step after tool_search calls ${LOOKUP_TOOL}; `
      + `tool_use frames seen for the session: ${seen}${searchAt < 0 ? ' (no tool_search frame)' : ''}; steps: ${stepNames}`);
  }
  // The live step's detail must show what the model sent, not `{}`: the frames
  // above prove the call was made, this proves the thread shows it.
  const callSteps = steps.filter((s) => s.name === 'call_tool');
  if (callSteps.length && !callSteps.some((s) => s.input.includes(LOOKUP_TOOL))) {
    return result(id, FAIL, `no call_tool step's detail shows ${LOOKUP_TOOL}: "${callSteps[0].input.slice(0, 120)}"`);
  }
  // A direct tides_lookup step must show its arguments too: the port carries
  // the nonce, so its detail text has to include it.
  const directSteps = steps.slice(search.index + 1).filter((s) => s.name === LOOKUP_TOOL);
  const callShows = callSteps.some((s) => s.input.includes(LOOKUP_TOOL));
  if (!callShows && !directSteps.some((s) => s.input.includes(env.nonce))) {
    return result(id, FAIL, `no ${LOOKUP_TOOL} step shows its arguments in the thread: "${(directSteps[0] || callSteps[0] || { input: '' }).input.slice(0, 120)}"`);
  }
  const reply = settled.reply;
  if (!reply.includes(expected)) {
    return result(id, FAIL, `the reply does not contain ${expected}: "${reply.slice(0, 120)}"`);
  }
  const took = seconds(sentMono);

  env.step('read relay audit');
  const audited = await poll(async () => {
    const rows = callToolRows(await relayRows(env, 'call_tool', project).catch(() => ''), { projectId: project.id, sinceMs: sentAt - AUDIT_SLACK_MS });
    return rows.find((r) => (r.tool === LOOKUP_TOOL || r.tool.endsWith(`_${LOOKUP_TOOL}`)) && r.outcome === 'ok') || null;
  }, { timeoutMs: 15000, intervalMs: 1000 });
  if (!audited) return result(id, FAIL, `relay audit has no call_tool ${LOOKUP_TOOL} outcome ok for ${PROJECT_NAME} since the question`);

  env.step('read the relay-sessions log');
  const line = await poll(async () => toolSearchLine(await logSince(logMark), sessionId), { timeoutMs: 10000, intervalMs: 1000 });
  if (!line) return result(id, FAIL, `no chat.tool_search line for session ${sessionId} in the relay-sessions log`);
  const problems = [];
  if (line.active !== true && line.active !== 'true') problems.push(`active=${line.active}`);
  if (line.reason !== 'auto_threshold') problems.push(`reason=${line.reason}`);
  if (!(line.skills >= MIN_SKILLS)) problems.push(`skills=${line.skills}, expected >=${MIN_SKILLS}`);
  if (!(line.sent < line.total)) problems.push(`tools_sent=${line.sent} not below tools_total=${line.total}`);
  if (problems.length) return result(id, FAIL, `chat.tool_search line: ${problems.join(', ')}`);

  // Detail only, never a verdict.
  let tokens = 'unknown';
  try {
    const rows = (await relayRows(env, 'model_call', project)).split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter((o) => o.model_key_label === `session:${sessionId}`).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (rows[0] && rows[0].prompt_tokens !== undefined) tokens = String(rows[0].prompt_tokens);
  } catch { /* detail only */ }
  return result(id, PASS, `${expected} in ${took}s via tool_search then ${LOOKUP_TOOL}; first model_call prompt_tokens=${tokens}; `
    + `tools_sent=${line.sent} of ${line.total}, skills=${line.skills}`);
}

module.exports = {
  searchStep,
  journeys: {
    chatToolSearch: {
      id: 'chat-tool-search', timeoutMs: 240000, areas: ['chat'], needs: [], run: chatToolSearch,
    },
  },
};
