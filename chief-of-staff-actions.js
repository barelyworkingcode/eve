'use strict';
// Chief of Staff actions: the /internal/cos endpoint the eve-cos MCP calls, the
// per-turn tool-call record, and the Start and Send cards. Design:
// docs/design-chief-of-staff.md ("Actions and provenance").
//
// The person model proposes; eve decides. Every call is tied to a tool_use the
// model really made in the person's current turn (CosTurn.claim), then
// chief-of-staff-provenance.js says whether eve acts at once or posts a card.

const crypto = require('crypto');
const { isLoopbackReq, safeEqual } = require('./ui-command-bus');
const provenance = require('./chief-of-staff-provenance');

const TOOLS = Object.freeze(['cos_list_sessions', 'cos_session_status', 'cos_propose_start', 'cos_propose_send']);
const TEXT_MAX = 8000;
const LIST_MAX = 100;
const EXCERPT_MAX = 500;
const NAMES_MAX = 20;
const MODES = Object.freeze(['headless', 'terminal']);

// Sorted-key JSON, so two inputs compare equal whatever their key order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

class UnverifiedCall extends Error {
  constructor(message) {
    super(message || 'The turn ended before this call was seen in the model stream');
    this.name = 'UnverifiedCall';
    this.code = 'unverified_call';
  }
}

// What the person model did in one person turn. In memory only.
class CosTurn {
  constructor({ personPostId = null, personText = '', modelSessionId = null, now = () => Date.now() } = {}) {
    this.turnId = `t-${crypto.randomBytes(3).toString('hex')}`;
    this.personPostId = personPostId;
    this.personText = personText;
    this.modelSessionId = modelSessionId;
    this.startedAt = now();
    this._now = now;
    this.toolCalls = [];
    this.settled = false;
    this._waiters = [];
  }

  get readTools() {
    return this.toolCalls.filter((c) => provenance.isReadingTool(c.name)).map((c) => c.name);
  }

  record({ toolUseId, name, input, sessionId }) {
    if (this.settled) return;
    if (toolUseId && this.toolCalls.some((c) => c.toolUseId === toolUseId)) return;
    if (sessionId) this.modelSessionId = sessionId;
    this.toolCalls.push({ toolUseId, name, input, at: this._now(), claimed: false });
    this._wake();
  }

  // Resolves with the matching call once it is recorded; rejects when the turn
  // settles first. Event-driven: no timer.
  claim(name, args) {
    return new Promise((resolve, reject) => {
      const waiter = { name, key: canonical(args), resolve, reject };
      if (this._tryClaim(waiter)) return;
      if (this.settled) { reject(new UnverifiedCall()); return; }
      this._waiters.push(waiter);
    });
  }

  settle() {
    if (this.settled) return;
    this.settled = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.reject(new UnverifiedCall());
  }

  _tryClaim(w) {
    const call = this.toolCalls.find((c) => !c.claimed && c.name === w.name && canonical(c.input) === w.key);
    if (!call) return false;
    call.claimed = true;
    w.resolve(call);
    return true;
  }

  _wake() {
    this._waiters = this._waiters.filter((w) => !this._tryClaim(w));
  }
}

// ---- argument validation ---------------------------------------------------

function invalid(field, message) {
  return { error: { status: 400, code: 'invalid_args', message: `${field}: ${message}` } };
}

function checkText(field, v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < 1 || t.length > TEXT_MAX) return invalid(field, `must be 1 to ${TEXT_MAX} characters`);
  return { value: t };
}

function checkFolder(v) {
  if (v === undefined || v === null) return { value: '' };
  if (typeof v !== 'string') return invalid('folder', 'must be a string');
  const f = v.trim();
  if (!f) return { value: '' };
  if (f.includes('\0') || f.startsWith('/') || f.startsWith('\\') || /^[A-Za-z]:/.test(f) || f.startsWith('~')) {
    return invalid('folder', 'must be relative to the project');
  }
  if (f.split(/[\\/]/).includes('..')) return invalid('folder', 'must not contain ".."');
  return { value: f };
}

function checkModel(v, fallback) {
  if (v === undefined || v === null) return { value: fallback };
  const m = typeof v === 'string' ? v.trim() : '';
  if (!m || m.length > 200) return invalid('model', 'must be a non-empty string');
  return { value: m };
}

function checkMode(v) {
  if (v === undefined || v === null) return { value: 'headless' };
  if (!MODES.includes(v)) return invalid('mode', 'must be "headless" or "terminal"');
  return { value: v };
}

// prompt, folder, model, mode: shared by tool arguments and card edits.
function validateStartFields({ prompt, folder, model, mode }, defaultModel) {
  const p = checkText('prompt', prompt); if (p.error) return p;
  const f = checkFolder(folder); if (f.error) return f;
  const m = checkModel(model, defaultModel); if (m.error) return m;
  const d = checkMode(mode); if (d.error) return d;
  return { value: { prompt: p.value, folder: f.value, model: m.value, mode: d.value } };
}

// project: exact id, or exact case-insensitive name among all projects, local or on a host.
function resolveProjectArg(listProjects, ref) {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) return invalid('project', 'is required');
  const all = [...listProjects()];
  const byId = all.find((p) => p.id === r);
  if (byId) return { value: byId };
  const named = all.filter((p) => typeof p.name === 'string' && p.name.trim().toLowerCase() === r.toLowerCase());
  if (named.length === 1) return { value: named[0] };
  if (named.length > 1) {
    return { error: { status: 409, code: 'ambiguous_project', message: `More than one project is named "${r}"; use its id` } };
  }
  const names = all.filter((p) => p.name).map((p) => p.name).slice(0, NAMES_MAX);
  return { error: { status: 404, code: 'unknown_project', message: `No project "${r}". Projects: ${names.join(', ') || 'none'}` } };
}

// ---- actions ---------------------------------------------------------------

// Starts through relay's scoped route, then lets the roster see a headless
// session. Posts `started` or `start_failed`. Returns {ok, ...}.
async function runStart(cos, { project, folder, model, mode, prompt, byModel }) {
  const res = await cos._startSession({ projectId: project.id, folder, prompt, model, mode });
  if (!res.ok) {
    cos._addPost({ kind: 'start_failed', projectName: project.name, error: res.message, byModel: false });
    return res;
  }
  try {
    await cos._fetchRoster({ seed: false });
  } catch (err) {
    cos.log.warn(`Chief of Staff roster refresh after start failed: ${err.message}`);
  }
  cos._emitStatus();
  cos._addPost({
    kind: 'started', sessionId: res.sessionId, name: res.name, projectId: project.id, projectName: project.name,
    mode: res.mode || mode, origin: 'chief-of-staff', byModel: byModel === true,
  });
  return { ok: true, sessionId: res.sessionId, name: res.name, mode: res.mode || mode };
}

function postStartCard(cos, turn, project, f, why) {
  return cos._addPost({
    kind: 'start_card',
    card: {
      state: 'pending', project: { id: project.id, name: project.name }, folder: f.folder, model: f.model,
      mode: f.mode, prompt: f.prompt, why, turnId: turn.turnId, result: null, error: null,
    },
    byModel: true,
  });
}

function postSendCard(cos, turn, sessionId, label, text, why) {
  return cos._addPost({
    kind: 'send_card',
    card: { state: 'pending', sessionId, label, text, why, turnId: turn.turnId, error: null },
    byModel: true,
  });
}

function sessionRow(cos, row) {
  return {
    sessionId: row.id,
    label: cos._labelOf(row, row.id),
    project: cos._projectName(row.projectId),
    projectId: row.projectId || '',
    state: row.state || 'unknown',
    since: row.since || '',
    headless: row.headless === true,
    origin: row.origin || '',
  };
}

// ---- /internal/cos ---------------------------------------------------------

function fail(status, code, message) {
  return { status, body: { ok: false, error: code, message } };
}

function ok(result) {
  return { status: 200, body: { ok: true, result } };
}

// Steps 2 to 6 of the contract. Returns {status, body}; never throws.
async function handleCall(cos, { tool, args, meta } = {}) {
  if (!TOOLS.includes(tool)) return fail(400, 'unknown_tool', `Unknown tool "${String(tool).slice(0, 60)}"`);
  if (!cos.settings.enabled || cos.off || cos._stopped) return fail(409, 'off', 'The Chief of Staff is off');
  const model = cos.personModel || cos.model;
  const modelProject = model && model.projectId;
  const projectId = meta && typeof meta.project_id === 'string' ? meta.project_id : '';
  if (!projectId || !modelProject || projectId !== modelProject) {
    return fail(403, 'not_cos_session', 'This call did not come from the Chief of Staff session');
  }
  const turn = cos._turn;
  if (!turn || turn.settled) return fail(409, 'no_turn', 'No person turn is in flight');
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  try {
    await turn.claim(provenance.RELAY_MCP_PREFIX + tool, input);
  } catch {
    return fail(403, 'unverified_call', 'This call was not seen in the model stream of the current turn');
  }
  try {
    return await dispatch(cos, turn, tool, input);
  } catch (err) {
    cos.log.error(`Chief of Staff ${tool} failed: ${err && err.message}`);
    return fail(500, 'internal_error', 'The Chief of Staff could not run that');
  }
}

async function dispatch(cos, turn, tool, args) {
  switch (tool) {
    case 'cos_list_sessions': return listSessions(cos);
    case 'cos_session_status': return sessionStatus(cos, args);
    case 'cos_propose_start': return proposeStart(cos, turn, args);
    default: return proposeSend(cos, turn, args);
  }
}

async function freshRoster(cos) {
  try {
    await cos._fetchRoster({ seed: false, prune: true });
    return null;
  } catch (err) {
    cos.log.warn(`Chief of Staff roster refetch failed: ${err.message}`);
    return fail(502, 'roster_unavailable', "I couldn't read the sessions just now");
  }
}

async function listSessions(cos) {
  const bad = await freshRoster(cos);
  if (bad) return bad;
  return ok({ sessions: [...cos.roster.values()].slice(0, LIST_MAX).map((r) => sessionRow(cos, r)) });
}

async function sessionStatus(cos, args) {
  const id = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!id) { const e = invalid('sessionId', 'is required'); return fail(e.error.status, e.error.code, e.error.message); }
  const bad = await freshRoster(cos);
  if (bad) return bad;
  const row = cos.roster.get(id);
  if (!row) return fail(404, 'unknown_session', 'No such session');
  return ok({ ...sessionRow(cos, row), model: row.model || '', lastExcerpt: String(row.lastExcerpt || '').slice(0, EXCERPT_MAX) });
}

function failFrom(e) {
  return fail(e.error.status, e.error.code, e.error.message);
}

async function proposeStart(cos, turn, args) {
  const f = validateStartFields(args, cos.settings.model);
  if (f.error) return failFrom(f);
  const p = resolveProjectArg(cos.listProjects, args.project);
  if (p.error) return failFrom(p);
  const project = p.value;
  const d = provenance.decide({
    sessionHasRead: cos._sessionHasRead(), personText: turn.personText, candidate: f.value.prompt, target: project.name,
  });
  if (d.action === 'card') {
    return ok({ status: 'card', cardId: postStartCard(cos, turn, project, f.value, d.why).id });
  }
  const r = await runStart(cos, { project, ...f.value, byModel: true });
  if (!r.ok) return fail(502, `relay_${r.code}`, r.message);
  return ok({ status: 'started', sessionId: r.sessionId, name: r.name, project: project.name, mode: r.mode });
}

async function proposeSend(cos, turn, args) {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!sessionId) return failFrom(invalid('sessionId', 'is required'));
  const t = checkText('text', args.text);
  if (t.error) return failFrom(t);
  const bad = await freshRoster(cos);
  if (bad) return bad;
  const row = cos.roster.get(sessionId);
  if (!row) return fail(404, 'unknown_session', 'No such session');
  const label = cos._labelOf(row, sessionId);
  const d = provenance.decide({ sessionHasRead: cos._sessionHasRead(), personText: turn.personText, candidate: t.value, target: label });
  if (d.action === 'card') {
    return ok({ status: 'card', cardId: postSendCard(cos, turn, sessionId, label, t.value, d.why).id });
  }
  const r = await cos._send(sessionId, t.value);
  if (!r.ok) return fail(502, `relay_${r.code}`, r.message);
  return ok({ status: 'sent', sessionId, label });
}

// Express handler: loopback peer, then the secret, then the call.
function internalHandler(cos, secret) {
  return async (req, res) => {
    if (!isLoopbackReq(req)) return res.status(403).json({ ok: false, error: 'forbidden', message: 'Loopback only' });
    if (!safeEqual(req.headers['x-eve-internal'] || '', secret || '')) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Bad internal secret' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await handleCall(cos, { tool: body.tool, args: body.args, meta: body.meta });
    return res.status(out.status).json(out.body);
  };
}

// ---- card actions ----------------------------------------------------------

function cardFail(message) { return { ok: false, message }; }

// One action per card: the state leaves `pending` before anything is awaited.
async function cardAction(cos, { postId, action, edits } = {}) {
  if (action !== 'start' && action !== 'cancel') return cardFail('Unknown card action');
  const post = cos.posts.find((p) => p.id === postId);
  if (!post || (post.kind !== 'start_card' && post.kind !== 'send_card')) return cardFail('That card is gone');
  const card = post.card;
  if (card.state !== 'pending') return cardFail(`This card is ${card.state}`);
  if (action === 'cancel') {
    card.state = 'cancelled';
    cos._updatePost(post);
    return { ok: true };
  }
  const e = edits && typeof edits === 'object' && !Array.isArray(edits) ? edits : {};
  return post.kind === 'start_card' ? tapStart(cos, post, e) : tapSend(cos, post, e);
}

async function tapStart(cos, post, edits) {
  const card = post.card;
  const f = validateStartFields({
    prompt: edits.prompt !== undefined ? edits.prompt : card.prompt,
    folder: edits.folder !== undefined ? edits.folder : card.folder,
    model: edits.model !== undefined ? edits.model : card.model,
    mode: edits.mode !== undefined ? edits.mode : card.mode,
  }, cos.settings.model);
  if (f.error) return cardFail(f.error.message);
  const project = cos.listProjects().find((p) => p.id === card.project.id);
  if (!project) {
    card.state = 'failed';
    card.error = 'That project is no longer available';
    cos._updatePost(post);
    return { ok: true };
  }
  Object.assign(card, f.value, { state: 'starting' });
  cos._updatePost(post);
  const r = await runStart(cos, { project, ...f.value, byModel: false });
  if (r.ok) {
    card.state = 'started';
    card.result = { sessionId: r.sessionId, name: r.name };
  } else {
    card.state = 'failed';
    card.error = r.message;
  }
  cos._updatePost(post);
  return { ok: true };
}

async function tapSend(cos, post, edits) {
  const card = post.card;
  let text = card.text;
  if (edits.text !== undefined) {
    const t = checkText('text', edits.text);
    if (t.error) return cardFail(t.error.message);
    text = t.value;
  }
  card.text = text;
  card.state = 'sending';
  cos._updatePost(post);
  const r = await cos._send(card.sessionId, text);
  if (r.ok) {
    card.state = 'sent';
  } else {
    card.state = 'failed';
    card.error = r.message;
  }
  cos._updatePost(post);
  return { ok: true };
}

module.exports = {
  CosTurn, TOOLS, canonical, validateStartFields, resolveProjectArg,
  handleCall, internalHandler, cardAction, runStart,
};
