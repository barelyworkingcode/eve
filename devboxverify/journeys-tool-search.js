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
  PASS, FAIL, BLOCKED, result, sleep, seconds, need, poll, pickModel, optionValues, openEve, waitForModels,
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

// The first `toolSearch` key anywhere in the parsed chat config; its mode is
// the value itself or its `mode`. undefined when the config never sets one.
function toolSearchMode(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(node, 'toolSearch')) {
    const v = node.toolSearch;
    return typeof v === 'string' ? v : (v && typeof v === 'object' ? v.mode : v);
  }
  for (const child of Object.values(node)) {
    const mode = toolSearchMode(child);
    if (mode !== undefined) return mode;
  }
  return undefined;
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

const callsLookup = (s) => s.name === LOOKUP_TOOL || (s.name === 'call_tool' && s.input.includes(LOOKUP_TOOL));

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

// The session's chat.tool_search line, or null. Fields may sit at the top
// level of the log record or under `fields`.
function toolSearchLine(text, sessionId) {
  for (const line of text.split('\n')) {
    if (!line.includes('chat.tool_search') || !line.includes(sessionId)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.op !== 'chat.tool_search') continue;
    const pick = (k) => (o[k] !== undefined ? o[k] : o.fields && o.fields[k]);
    return { active: pick('active'), reason: pick('reason'), skills: Number(pick('skills')), sent: Number(pick('tools_sent')), total: Number(pick('tools_total')) };
  }
  return null;
}

async function relayRows(env, event, project) {
  const args = ['audit', '--event', event, '--project', project.id, '--json', '--tail', '200'];
  const { stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 32 << 20 });
  return stdout;
}

async function chatToolSearch(env) {
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
  await openEve(page, env);
  await waitForModels(page, env);
  await openProject(page, env, project);
  const mine = async () => (await eveJson(env, 'GET', '/api/sessions')).filter((s) => s.projectId === project.id).map((s) => s.id);
  const before = await mine();

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
  // Deliberate: this project is not in the world, so neither the leak check
  // nor the sweep would remove the session.
  env.cleanup('delete the tool-search session', () => deleteSession(env, sessionId));

  const port = `Port Verify${env.nonce}`;
  const expected = tideCode(port);
  const question = `What is the tide code for the port of ${port}? Reply with the code only.`;
  const input = page.getByTestId('chat-input');
  env.step('wait for the composer');
  await need('the composer never became usable', expect(input).toBeEnabled({ timeout: 30000 }));
  const logMark = await logSize();
  await input.fill(question, { timeout: 5000 });
  env.step('send the question');
  const sentAt = Date.now();
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
  const first = steps[0];
  if (!first || first.name !== 'tool_search') {
    return result(id, FAIL, `the first tool step is ${first ? `"${first.name}"` : 'missing'}, not tool_search (steps: ${stepNames}); thread: ${shown}`);
  }
  if (!first.output.includes(LOOKUP_TOOL)) {
    return result(id, FAIL, `the tool_search result does not name ${LOOKUP_TOOL}: ${first.output.slice(0, 200)}`);
  }
  if (!steps.slice(1).some(callsLookup)) {
    return result(id, FAIL, `no tool step after tool_search calls ${LOOKUP_TOOL} (steps: ${stepNames})`);
  }
  const reply = settled.reply;
  if (!reply.includes(expected)) {
    return result(id, FAIL, `the reply does not contain ${expected}: "${reply.slice(0, 120)}"`);
  }
  const took = seconds(sentAt);

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
  journeys: {
    chatToolSearch: {
      id: 'chat-tool-search', timeoutMs: 240000, areas: ['chat'], needs: [], run: chatToolSearch,
    },
  },
  tideCode,
  toolSearchMode,
};
