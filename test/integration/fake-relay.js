/**
 * Fake relay — an in-process contract double for relay's frontend, used by
 * the integration harness. No real relay / relayLLM / LLM involved.
 *
 * Pinned to relay's source (../relay, macOS-only so it cannot run where this
 * suite runs in the cloud), not to a running relay. Each shape below carries
 * the relay file it was read from; relay-source-pins.test.js re-reads those
 * files when the checkout is present and fails when relay has moved. The
 * files, all under ../relay:
 *   cmd/relay/frontend_server.go          auth (401), route layout
 *   cmd/relay/frontend_dispatcher.go      unmatched paths, upstream WS close 1011
 *   cmd/relay/frontend_model_guard.go     POST /api/sessions refusals
 *   cmd/relay/project_routes.go           projects: 204 / 404 bodies
 *   cmd/relay/host_routes.go              hosts: 404 / 409 bodies
 *   cmd/relay/persistent_session_routes.go
 *   internal/sessions/api/http_session.go  session delete (204), list
 *   internal/sessions/api/http_terminal.go terminal log
 *   internal/sessions/api/ws_session.go    join / permission / resume frames
 *   internal/sessions/session/manager.go   session.Summary (GET /api/sessions)
 *   cmd/relay/audit_routes.go              GET /api/audit, GET /api/audit/log
 *   internal/audit/ops.go                  Query / LogPath when auditing is off
 *   cmd/relay/api_credential.go            X-Relay-Scope: chief-of-staff and what it reaches
 *   cmd/relay/session_chief_of_staff.go    POST /api/chief-of-staff/messages
 *   cmd/relay/session_chief_of_staff_start.go  POST /api/chief-of-staff/sessions
 *   internal/sessions/events/events.go     AssistantBlockStopEvent (a tool_use the person model made)
 *   cmd/relay/frontend_dispatcher.go       the scoped /ws is read-only (close 1008)
 *
 * The file plane (routes under /api/projects/{id}/files/*, pastetmp, /ws/files)
 * lives in fake-relay-files.js and is exposed here as `relay.files`. Its files:
 *   internal/projectfs/projectfs.go        codes, CleanRel, ValidateName, ValidateGitArgs
 *   internal/projectfs/local.go            console backend messages
 *   internal/projectfs/search.go           search validation and scan
 *   cmd/relay/file_routes.go               routes, body limits, error body
 *   cmd/relay/file_ops.go                  check order, read-only, audit gate
 *   cmd/relay/audit_file.go                file_op intent / completion / denied rows
 *   cmd/relay/file_ws.go                   /ws/files frames
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { relayFrames, EVENT_PROTOCOL_VERSION } = require('./protocol');
const { createFakeFiles } = require('./fake-relay-files');

// Built from the protocol contract so the fake can't silently diverge from it.
// openai.go (message building): every attached file becomes an `image_url`
// part. A bare payload gets a data: URI with the file's mime type, defaulting
// to image/png; a payload already starting with `data:` is used as is. The
// model server refuses a non-image data URI with the 400 below, which relay
// surfaces as an error in the thread. Text files must therefore never reach
// relay as `files`.
const NON_IMAGE_FILE_ERROR = 'chat: HTTP 400: image_url must use a base64 image data URI.';
function fileRefusal(files) {
  for (const f of Array.isArray(files) ? files : []) {
    const data = typeof f.data === 'string' ? f.data : '';
    const mime = data.startsWith('data:') ? data.slice(5).split(/[;,]/)[0] : (f.mimeType || 'image/png');
    if (!mime.startsWith('image/')) return NON_IMAGE_FILE_ERROR;
  }
  return null;
}

function defaultStream(sessionId) {
  return [
    relayFrames.assistantDelta({ sessionId, text: 'Hello ' }),
    relayFrames.assistantDelta({ sessionId, text: 'from fake relay' }),
    relayFrames.messageComplete({ sessionId }),
  ];
}

// The real browser drops version-less llm_event frames, so the fake must
// never emit them — otherwise a test could pass against frames production
// would silently discard.
//
// sessionId is defaulted onto a script frame that doesn't already have an
// opinion about it — but a frame that explicitly sets its own `sessionId`
// property to `undefined` (relayFrames.error's default, e.g.) is left with
// none at all on the wire (JSON.stringify drops undefined-valued keys).
// This used to unconditionally overwrite every scripted frame's sessionId,
// which meant a script built specifically to have none (relayFrames.error's
// session-less shape, matching real relay's sendWSError bug) silently got
// one anyway — masking exactly the gap that shape exists to test.
function stampFrame(f, sessionId) {
  const explicitlyNone = Object.prototype.hasOwnProperty.call(f, 'sessionId') && f.sessionId === undefined;
  const out = explicitlyNone ? { ...f } : { ...f, sessionId };
  if (out.type === 'llm_event' && out.event && out.event.v === undefined) {
    out.event = { ...out.event, v: EVENT_PROTOCOL_VERSION };
  }
  return out;
}

function createFakeRelay({ token = null } = {}) {
  // null => no auth, as before. A string => every HTTP request and WS upgrade
  // must carry `Authorization: Bearer <token>`; anything else is relay's
  // frontendCredentialAuth answer (frontend_server.go): a text/plain 401
  // "unauthorized", identical for an absent, malformed and wrong token.
  let requiredToken = token;
  const projects = new Map();
  const hosts = new Map();
  const files = createFakeFiles({ projects, hosts });
  const sessions = new Map();
  const sessionScripts = new Map();
  const requests = [];
  const rejectedRequests = [];
  const inbound = [];
  const inboundWaiters = [];
  const relayWs = new Set();
  // Mirrors relay's `eve_enrolment` settings record (../relay/docs/eve-passkey-enrolment.md):
  // absent/expired reads as closed, opening replaces any existing record.
  let eveEnrolment = null; // { expires: ISOString } | null
  const consumedEnrolments = [];
  // Mirrors relay's `eve_passkeys` / `eve_passkey_revocations` settings
  // records (../relay/docs/eve-passkey-enrolment.md "Listing and revoking
  // eve passkeys"). reportedPasskeys is whatever eve's last PUT contained;
  // pendingRevocations is what a test (standing in for relay's presence-gated
  // Revoke) has queued.
  let reportedPasskeys = [];
  const pendingRevocations = new Set();
  // Lets a test tell which of eve's (possibly several) relay upstreams a
  // frame arrived on — the only cover for the two-connection isolation tests.
  const relaySocketIds = new WeakMap();
  let relaySocketSeq = 0;
  const schedulerWs = new Set();
  const schedulerResolvers = [];
  const relayResolvers = [];
  let seq = 0;
  let closed = false;
  let sessionCreateGate = null;
  // null => the default models response below. A test swaps in relay's real
  // `{ models, providerSettings }` shape via setModels().
  let modelsPayload = null;
  let modelsGate = null;
  // sessionId -> Promise; a held join_session reply waits on it (holdJoin()).
  const joinGates = new Map();
  // Session ids whose join_session gets relay's "not found" reply (failJoinWith()).
  const failedJoins = new Set();
  const sessionCreates = [];
  // Chief of Staff (relay#234). The scope is a per-request narrowing: it reaches
  // only these three doors (api_credential.go chiefOfStaffProxyReach + the
  // ClassChiefOfStaff route); everything else is a 403.
  const SCOPED_REACH = ['GET /api/sessions', 'GET /ws', 'POST /api/chief-of-staff/messages'];
  const COS_SCOPE = 'chief-of-staff';
  // session_routes.go: the start door is the second ClassChiefOfStaff route, beside the send.
  const SCOPED_START = 'POST /api/chief-of-staff/sessions';
  const scopedWs = new Set();
  const scopedResolvers = [];
  // Every HTTP request and /ws upgrade with the scope header it carried (null = none).
  const scopeLog = [];
  // manager.go isListed: a headless session that is not an agent is hidden from the list
  // and answers like an unknown id to the scoped send.
  const unlistedIds = new Set();
  // The model's own sessions (name `__cos:`): what they were created with and every turn sent to them.
  const cosSessionCreates = [];
  const cosModelTurns = [];
  // provider/claude.go: a readOnlyProjects session runs `--tools Read,Grep,Glob --strict-mcp-config`,
  // so its init lists those three plus the relay MCP's tools for the project's grants (here eve-cos).
  // Any other Chief of Staff session lists nothing once eve's deny list has applied.
  const COS_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob',
    'mcp__relay__cos_list_sessions', 'mcp__relay__cos_session_status', 'mcp__relay__cos_propose_start', 'mcp__relay__cos_propose_send'];
  const cosReadOnlyIds = new Set();
  const cosInitTools = (sessionId) => (cosReadOnlyIds.has(sessionId) ? COS_READ_ONLY_TOOLS.slice() : []);
  // tools: what the session reports in system/init, or null for relay's own answer (cosInitTools).
  // reply: (text, n) => string, or null for the default.
  let cosModel = { tools: null, reply: null };
  // null => the send succeeds; { status, code, message } forces relay's host-side refusals.
  let cosSendFailure = null;
  // Every body the scoped start route accepted past its syntax checks, and the scope it carried.
  const cosStarts = [];
  const cosStartWaiters = [];
  // null => the start succeeds; { status, code, message } forces a refusal after the launch checks.
  let cosStartFailure = null;
  const cosTurnWaiters = [];
  // GET /api/chief-of-staff/config (project_routes.go): { configured: false } until a test sets a
  // value; 'absent' answers 404 like a relay older than the route.
  let cosConfig = { configured: false };
  // session_ended and the attention frames are broadcast to every connection, scoped ones included.
  const BROADCAST_TYPES = new Set(['session_state', 'turn_done', 'session_ended']);
  // join_session for an id relay does not hold is an error frame. Off by default
  // so callers that join an id they never created keep working; strictJoin() turns it on.
  let strictJoin = false;
  const seededJoinable = new Set();
  // null => normal create. A test forces relay's non-2xx create answers: the
  // model guard's 403/400/413, or a launch failure's 502/503
  // (frontend_model_guard.go; session_routes.go). { status, body }.
  let sessionCreateFailure = null;
  // projectId -> [{ name, template_id, n, created, attached, attached_here }]
  // and projectId -> { status, error }: relay's PersistentSessionOps, whose
  // backing store is the host's own `tmux ls`.
  const persistentSessions = new Map();
  const persistentFailures = new Map();
  // sessionId -> Set of relay socket ids that joined it (relay's sh.viewers /
  // sh.bound). Delivery and permission_response scoping read this.
  const joined = new Map();
  // permissionId -> sessionId for permission_request frames relay sent and
  // nobody has answered yet (relay's perms.PendingSessionID).
  const pendingPermissions = new Map();
  const terminals = new Map();
  // Templates as relay's GET /api/terminal/templates lists them (a bare array).
  let terminalTemplates = [];
  // terminalId -> Set of relay socket ids viewing it (ws_terminal.go th.viewers).
  const terminalViewers = new Map();
  // Mirrors relay's own handleClearSession (ws_session.go), which — like
  // handleSendMessage — can answer a dormant session with resume_required
  // instead of clearing it (SH-6/C11's B1 regression coverage).
  const clearSessionScripts = new Map();
  // null => normal success path. A test forces a specific non-2xx to drive
  // C11's terminal-create-failure and resume-failure branches.
  let terminalCreateFailStatus = null;
  let resumeFailStatus = null;
  // Drop in (relay session_dropin.go): sessionId -> terminalId while a terminal holds the
  // session; terminalId -> sessionId for the close that hands it back. failDropInWith forces
  // an answer after the refusals; dropInGate holds the 201 (holdDropIn()).
  const heldSessions = new Map();
  const dropInTerminals = new Map();
  const dropIns = [];
  let dropInFailure = null; // { status, body }
  let dropInGate = null;
  // null => POST /api/tasks falls through to the unhandled-route 404 below.
  let taskCreateFailure = null; // { status, body }
  // relay's reverse proxy to relayScheduler (enhanced_services.go) answers a
  // text/plain 502 "bad gateway" on every /api/tasks* path while the scheduler is down.
  let schedulerIsDown = false;
  // relay's audit log (internal/audit). Events as the recorder stores them, oldest first.
  let auditEnabled = true;
  // An event's outcome is audit.go's AuditOutcomeDenied ("denied") or one of its siblings; eve maps it, the fake only stores it.
  let auditEvents = [];

  // Go's time.RFC3339 in UTC: whole seconds, `Z`.
  const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  // relayScheduler state. taskId -> Task (task.go); taskId -> [Execution], newest first.
  const tasks = new Map();
  const histories = new Map();
  // 'auto': a run completes on its own (success, response 'done'); 'hold': it stays
  // running until finishTask(). Either way the lifecycle frames are the scheduler's.
  let taskRunMode = 'auto';
  const SCHEDULE_TYPES = new Set(['daily', 'hourly', 'interval', 'weekly', 'cron', 'once', 'on_demand']);

  // api.go validateTask / schedule.go ValidateSchedule, messages verbatim.
  const validateTask = (t) => {
    if (!t || typeof t !== 'object') return 'invalid JSON: unexpected input';
    if (!t.name) return 'name is required';
    if (!t.projectId) return 'projectId is required';
    if (!t.schedule || typeof t.schedule !== 'object') return 'schedule is required';
    if (!SCHEDULE_TYPES.has(t.schedule.type)) return `invalid schedule: unknown schedule type ${JSON.stringify(t.schedule.type)}`;
    if (t.schedule.type === 'once' && !(Date.parse(t.schedule.at) > Date.now())) {
      return `invalid schedule: once schedule 'at' is in the past: ${t.schedule.at}`;
    }
    // relayScheduler#10: outputFile is a bare file name on a PTY task run in its project directory.
    if (t.outputFile) {
      if (t.sessionType !== 'pty') return 'outputFile is only for PTY tasks';
      const f = String(t.outputFile);
      if (f === '.' || f === '..' || /[/\\\0]/.test(f)) return 'outputFile must be a file name, not a path';
      if (t.directory) return 'outputFile needs the task to run in its project directory; remove directory';
    }
    if (t.sessionType === 'pty') {
      if (!t.templateId) return 'templateId is required for PTY tasks';
    } else if (!t.sessionType || t.sessionType === 'headless') {
      if (!t.prompt) return 'prompt is required for chat tasks';
      if (!String(t.model || '').trim()) return `task ${JSON.stringify(t.name)}: model is required for chat tasks`;
    } else {
      return `invalid sessionType ${JSON.stringify(t.sessionType)} (expected "headless" or "pty")`;
    }
    return null;
  };

  // task.go taskView + MarshalJSON: the derived `view` on every stored task.
  const viewOf = (t, runId) => {
    const kind = t.sessionType === 'pty' ? 'readonly' : 'interactive';
    if (runId) return { kind, runId };
    const stored = t.sessionType === 'pty' ? t.lastTerminalId : t.lastSessionId;
    return stored ? { kind, runId: stored, hasLastRun: true } : { kind };
  };
  const taskWire = (t) => ({ ...t, view: viewOf(t) });

  const broadcastTask = (type, task, runId, extra = {}) => {
    const msg = { type, taskId: task.id, projectId: task.projectId, taskName: task.name, view: viewOf(task, runId), ...extra };
    for (const ws of schedulerWs) ws.send(JSON.stringify(msg));
  };

  const startTaskRun = (task) => {
    const runId = task.sessionType === 'pty' ? `term-${++seq}` : `sess-${++seq}`;
    const startedAt = ts();
    task.lastStatus = 'running';
    task.lastRun = startedAt;
    const exec = { taskId: task.id, taskName: task.name, projectId: task.projectId, startedAt, status: 'running' };
    if (task.sessionType === 'pty') exec.terminalId = runId; else exec.sessionId = runId;
    // A chat run is a headless session relayLLM keeps: joinable afterwards, and
    // listed by GET /api/sessions like any other (eve hides it via the task view).
    if (task.sessionType !== 'pty') {
      const project = projects.get(task.projectId);
      sessions.set(runId, {
        sessionId: runId, projectId: task.projectId, name: task.name, directory: (project && project.path) || '/fake',
        model: task.model || 'fake-model', headless: true, live: true, createdAt: startedAt,
        // client.go CreateSessionWithTools: the run's session settings.
        settings: task.useRelayTools ? { headless: true, useRelayTools: true } : { headless: true },
        history: [{ timestamp: startedAt, role: 'user', content: task.prompt }],
      });
    }
    histories.set(task.id, [exec, ...(histories.get(task.id) || [])]);
    broadcastTask('task_started', task, runId);
    if (taskRunMode === 'auto') setTimeout(() => finishTask(task.id, { status: 'success', response: 'done' }), 0);
    return exec;
  };

  // A run ends: the record, the task's run state and the lifecycle frame
  // (scheduler.go broadcastTaskEvent: completed carries status; error carries error + status).
  // `output` is what the script wrote to the task's outputFile: the scheduler
  // records it only on a successful run of a task that has one (task.go Execution.Output).
  const finishTask = (id, { status = 'success', response = '', error = '', exitCode, output } = {}) => {
    const task = tasks.get(id);
    const exec = (histories.get(id) || []).find((e) => e.status === 'running');
    if (!task || !exec) return false;
    exec.status = status;
    exec.completedAt = ts();
    // store.go SetLastRun runs when a run finishes, so lastRun is the finish time.
    task.lastRun = exec.completedAt;
    if (response) exec.response = response;
    if (error) exec.error = error;
    if (task.sessionType === 'pty' && exitCode !== undefined) exec.exitCode = exitCode;
    if (status === 'success' && task.outputFile && typeof output === 'string' && output !== '') exec.output = output;
    task.lastStatus = status;
    const runId = exec.terminalId || exec.sessionId;
    if (exec.sessionId) {
      task.lastSessionId = exec.sessionId;
      const run = sessions.get(exec.sessionId);
      if (run) {
        run.live = false;
        if (response) run.history.push({ timestamp: exec.completedAt, role: 'assistant', content: [{ type: 'text', text: response }] });
        run.messageCount = run.history.length;
        run.lastMessageAt = exec.completedAt;
      }
    }
    if (exec.terminalId) task.lastTerminalId = exec.terminalId;
    if (status === 'success') broadcastTask('task_completed', task, runId, { status });
    else broadcastTask('task_error', task, runId, { error, status });
    return true;
  };

  // project_dto.go projectToView: the list/get/create/update body. Mode is the
  // EFFECTIVE mode ("both" when unset); default_for lists the modes this project
  // is the valid default of (project_mode.go DefaultProjectFor); the allow-lists
  // and created_at are always present.
  const defaultProjects = { home: '', work: '' };
  const effectiveMode = (proj) => (proj.mode === 'home' || proj.mode === 'work' ? proj.mode : 'both');
  const validDefault = (mode) => {
    const proj = projects.get(defaultProjects[mode]);
    return proj && !proj.host_id && [mode, 'both'].includes(effectiveMode(proj)) ? proj.id : '';
  };
  const projectView = (proj) => {
    const out = {
      allowed_mcp_ids: [], allowed_models: [], allowed_templates: [], created_at: new Date(0).toISOString(),
      ...proj, mode: effectiveMode(proj),
    };
    const defaultFor = ['home', 'work'].filter((m) => validDefault(m) === proj.id);
    if (defaultFor.length) out.default_for = defaultFor; else delete out.default_for;
    return out;
  };

  // A terminal is a tiny scripted shell, enough for "runs my command": it echoes
  // what is typed, answers `echo ...` with the text and anything else with
  // "sh: <cmd>: command not found", then prompts again. Output goes to viewers.
  const SHELL_PROMPT = '$ ';
  const termOut = (term, text) => {
    term.scrollback += text;
    const frame = JSON.stringify({ type: 'terminal_output', terminalId: term.terminalId, data: Buffer.from(text).toString('base64') });
    const ids = terminalViewers.get(term.terminalId) || new Set();
    for (const sock of relayWs) if (ids.has(relaySocketIds.get(sock))) sock.send(frame);
  };
  const termInput = (term, data) => {
    for (const ch of String(data)) {
      if (ch === '\r' || ch === '\n') {
        const line = term.line.trim();
        term.line = '';
        const out = line === '' ? '' : (line.startsWith('echo ') ? `${line.slice(5)}\r\n` : `sh: ${line.split(/\s+/)[0]}: command not found\r\n`);
        termOut(term, `\r\n${out}${SHELL_PROMPT}`);
      } else if (ch === '\x7f') {
        if (term.line) { term.line = term.line.slice(0, -1); termOut(term, '\b \b'); }
      } else {
        term.line += ch;
        termOut(term, ch);
      }
    }
  };
  const termJoined = (term) => ({
    type: 'terminal_joined', terminalId: term.terminalId, templateId: term.templateId, name: term.name,
    directory: term.directory, state: term.state, cols: term.cols, rows: term.rows,
    scrollback: Buffer.from(term.scrollback).toString('base64'), host: null,
  });

  const toSummary = (sess) => {
    const out = {
      id: sess.sessionId,
      projectId: sess.projectId || '',
      name: sess.name || '',
      directory: sess.directory,
      model: sess.model,
      live: sess.live !== false,
      createdAt: sess.createdAt || new Date(0).toISOString(),
      messageCount: sess.messageCount || 0,
    };
    if (sess.folder) out.folder = sess.folder;
    // manager.go Summary.Origin: set when someone other than the person started the session.
    if (sess.origin) out.origin = sess.origin;
    if (sess.lastMessageAt) out.lastMessageAt = sess.lastMessageAt;
    if (sess.host) out.host = sess.host;
    // manager.go Summary.Headless (relay#241): omitted unless true.
    if (sess.headless) out.headless = true;
    // manager.go Summary.Attention: omitted for a session relay does not track.
    if (sess.attention) out.attention = sess.attention;
    // manager.go Summary.Headless: `omitempty`, so only a headless session carries it.
    if (sess.headless === true) out.headless = true;
    return out;
  };

  const notePending = (f) => {
    if (f && f.type === 'permission_request' && f.permissionId && f.sessionId) {
      pendingPermissions.set(f.permissionId, f.sessionId);
    }
  };

  const recordInbound = (msg) => {
    inbound.push(msg);
    for (let i = inboundWaiters.length - 1; i >= 0; i--) {
      if (inboundWaiters[i].pred(msg)) { inboundWaiters[i].resolve(msg); inboundWaiters.splice(i, 1); }
    }
  };

  const routeHandler = (req, res) => {
    const url = new URL(req.url, 'http://relay.local');
    const p = url.pathname;
    const send = (status, obj) => {
      // 204 has no body (net/http's WriteHeader(StatusNoContent)).
      if (status === 204) { res.writeHead(204); return res.end(); }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // Go's http.Error: text/plain, body + newline.
    const sendText = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end(`${text}\n`);
    };

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, path: p });
      scopeLog.push({ method: req.method, path: p, scope: req.headers['x-relay-scope'] ?? null });
      if (requiredToken !== null && req.headers.authorization !== `Bearer ${requiredToken}`) {
        rejectedRequests.push({ method: req.method, path: p });
        return sendText(401, 'unauthorized');
      }
      // api_credential.go Authorize: an unknown scope, a request outside the scope's reach, and the
      // scope-only route without the scope are all 403.
      const scopeHeader = req.headers['x-relay-scope'];
      if (scopeHeader !== undefined && (scopeHeader !== COS_SCOPE || !(SCOPED_REACH.includes(`${req.method} ${p}`) || `${req.method} ${p}` === SCOPED_START))) {
        return sendText(403, 'Forbidden');
      }
      if (scopeHeader === undefined && (p === '/api/chief-of-staff/messages' || p === '/api/chief-of-staff/sessions')) return sendText(403, 'Forbidden');
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}

      // Mirrors the real relay's path validation (filepath.IsAbs): the
      // frontend sends "~/..." verbatim and the backend does not expand it,
      // so relative paths get a 400, not a 201.
      const isAbsPath = (pth) => typeof pth === 'string' && pth.startsWith('/');
      const absPathError = (pth) => send(400, { error: `project path must be an absolute path: ${JSON.stringify(pth ?? '')}` });
      if (p === '/api/chief-of-staff/config' && req.method === 'GET') {
        if (cosConfig === 'absent') return sendText(404, '404 page not found');
        return send(200, cosConfig);
      }
      const fileRoute = files.match(req.method, p);
      if (fileRoute) return files.handle(req, res, fileRoute, body, url);
      if (p === '/api/projects' && req.method === 'GET') return send(200, [...projects.values()].map(projectView));
      if (p === '/api/projects' && req.method === 'POST') {
        if (!isAbsPath(parsed.path)) return absPathError(parsed.path);
        const id = parsed.id || `proj-${++seq}`;
        const proj = { ...parsed, id };
        projects.set(id, proj);
        return send(201, projectView(proj));
      }
      const pm = p.match(/^\/api\/projects\/([^/]+)$/);
      if (pm) {
        const id = pm[1];
        // project_routes.go: lowercase "project not found" for GET, PUT and DELETE.
        if (!projects.has(id) && ['GET', 'PUT', 'DELETE'].includes(req.method)) return send(404, { error: 'project not found' });
        if (req.method === 'GET') return send(200, projectView(projects.get(id)));
        // chat_templates are stored as sent, preset_for included (models.go
        // ChatTemplate.PresetFor); a PUT without chat_templates keeps them.
        if (req.method === 'PUT') {
          if (parsed.path !== undefined && !isAbsPath(parsed.path)) return absPathError(parsed.path);
          const proj = { ...(projects.get(id) || {}), ...parsed, id };
          projects.set(id, proj);
          return send(200, projectView(proj));
        }
        if (req.method === 'DELETE') { projects.delete(id); return send(204); }
      }

      // PUT /api/default_project/{mode} (project_routes.go): "" clears; a refusal is 400
      // with config.SetDefaultProject's message.
      const dm = p.match(/^\/api\/default_project\/([^/]+)$/);
      if (dm && req.method === 'PUT') {
        const mode = decodeURIComponent(dm[1]);
        if (!parsed || typeof parsed.project_id !== 'string') return send(400, { error: 'project_id is required; send "" to clear the default' });
        const refuse = (msg) => send(400, { error: `invalid default project: ${msg}` });
        if (mode !== 'home' && mode !== 'work') return refuse(`mode "${mode}" has no default project; want home or work`);
        if (parsed.project_id !== '') {
          const proj = projects.get(parsed.project_id);
          if (!proj) return refuse(`no project with id "${parsed.project_id}"`);
          if (proj.host_id) return refuse(`project "${proj.id}" is an access profile and cannot be a default project`);
          if (![mode, 'both'].includes(effectiveMode(proj))) return refuse(`project "${proj.id}" is ${effectiveMode(proj)}-only and cannot be the default for ${mode}`);
        }
        defaultProjects[mode] = parsed.project_id;
        return send(200, { home: validDefault('home'), work: validDefault('work') });
      }

      // SSH hosts (../relay/docs/ssh-hosts.md). ssh_argv here is whatever the
      // test set it to — normally a fake "ssh" that execs remote-fs-agent.js
      // locally instead of real ssh, so no network or real host is involved.
      if (p === '/api/hosts' && req.method === 'GET') return send(200, [...hosts.values()]);
      if (p === '/api/hosts' && req.method === 'POST') {
        const id = parsed.id || `h-${++seq}`;
        const host = { status: 'unknown', ssh_argv: [], ...parsed, id };
        hosts.set(id, host);
        return send(201, host);
      }
      const hm = p.match(/^\/api\/hosts\/([^/]+)$/);
      if (hm) {
        const id = hm[1];
        // host_routes.go: lowercase "host not found" for GET, PUT and DELETE.
        if (!hosts.has(id) && ['GET', 'PUT', 'DELETE'].includes(req.method)) return send(404, { error: 'host not found' });
        if (req.method === 'GET') return send(200, hosts.get(id));
        if (req.method === 'PUT') {
          const host = { ...(hosts.get(id) || {}), ...parsed, id };
          hosts.set(id, host);
          return send(200, host);
        }
        if (req.method === 'DELETE') {
          const referencing = [...projects.values()].filter((pr) => pr.host_id === id).map((pr) => pr.name);
          if (referencing.length > 0) return send(409, { error: 'host is used by one or more projects', projects: referencing });
          hosts.delete(id);
          return send(204);
        }
      }
      const probeMatch = p.match(/^\/api\/hosts\/([^/]+)\/probe$/);
      if (probeMatch && req.method === 'POST') {
        const id = probeMatch[1];
        const host = hosts.get(id);
        if (!host) return send(404, { error: 'host not found' });
        host.probe = { at: new Date().toISOString(), ok: true, os: 'Darwin', arch: 'arm64', home: '/tmp', shell: '/bin/zsh', node_path: process.execPath, node_version: process.version, claude_path: '/usr/local/bin/claude', claude_version: '0.0.0', error: '' };
        host.status = 'connected';
        return send(200, host);
      }
      const disconnectMatch = p.match(/^\/api\/hosts\/([^/]+)\/disconnect$/);
      if (disconnectMatch && req.method === 'POST') {
        const id = disconnectMatch[1];
        const host = hosts.get(id);
        if (!host) return send(404, { error: 'host not found' });
        host.status = 'idle';
        return send(200, host);
      }

      // Tracked in `sessions` so a later GET /api/sessions — the reconnect/
      // reload restore path's only session source — can see it. Real
      // relayLLM has no concept of eve's UI-only `sessionType` ("chat" vs
      // "voice"), so it's deliberately not stored here: restoring that
      // distinction after a reload is `eve-session-meta`'s job alone.
      // session_chief_of_staff.go handleChiefOfStaffMessage: checks in relay's order. The origin
      // is the constant, never read from the body.
      if (p === '/api/chief-of-staff/messages' && req.method === 'POST') {
        const coded = (status, code, message) => send(status, { error: code, message });
        if (Buffer.byteLength(body) > 64 << 10) return coded(413, 'body_too_large', 'request body is larger than 64 KiB');
        let msgBody = null;
        try { msgBody = JSON.parse(body); } catch {}
        if (!msgBody || typeof msgBody !== 'object' || Array.isArray(msgBody)) return coded(400, 'invalid_body', 'body must be JSON {"sessionId","text"}');
        if (!msgBody.sessionId) return coded(400, 'session_id_required', 'sessionId is required');
        if (typeof msgBody.text !== 'string' || msgBody.text.trim() === '') return coded(400, 'text_required', 'text is required');
        if (!auditEnabled) return coded(503, 'audit_unavailable', 'auditing is off; the Chief of Staff cannot send');
        const target = sessions.get(msgBody.sessionId);
        if (!target || unlistedIds.has(msgBody.sessionId)) return coded(404, 'session_not_found', 'session not found');
        if (cosSendFailure) return coded(cosSendFailure.status, cosSendFailure.code, cosSendFailure.message);
        const at = new Date().toISOString();
        target.history = [...(target.history || []), relayFrames.historyUser({ timestamp: at, content: msgBody.text, origin: 'chief-of-staff' })];
        target.messageCount = target.history.length;
        const live = JSON.stringify(relayFrames.userMessage({ sessionId: msgBody.sessionId, text: msgBody.text, origin: 'chief-of-staff' }));
        const ids = joined.get(msgBody.sessionId) || new Set();
        for (const sock of relayWs) if (ids.has(relaySocketIds.get(sock))) sock.send(live);
        return send(202, { sessionId: msgBody.sessionId, origin: 'chief-of-staff', at });
      }

      // session_chief_of_staff_start.go handleChiefOfStaffStart: relay's order of checks. The origin is
      // the constant; only these five body fields are read.
      if (p === '/api/chief-of-staff/sessions' && req.method === 'POST') {
        const coded = (status, code, message) => send(status, { error: code, message });
        if (Buffer.byteLength(body) > 64 << 10) return coded(413, 'body_too_large', 'request body is larger than 64 KiB');
        let sb = null;
        try { sb = JSON.parse(body); } catch {}
        if (!sb || typeof sb !== 'object' || Array.isArray(sb)) return coded(400, 'invalid_body', 'body must be JSON {"projectId","folder","prompt","model","mode"}');
        const prompt = typeof sb.prompt === 'string' ? sb.prompt.trim() : '';
        const folder = typeof sb.folder === 'string' ? sb.folder : '';
        const mode = sb.mode ? sb.mode : 'headless';
        if (!sb.projectId) return coded(400, 'project_id_required', 'projectId is required');
        if (prompt === '') return coded(400, 'prompt_required', 'prompt is required');
        if ([...prompt].length > 8000) return coded(400, 'prompt_too_long', 'prompt is longer than 8000 characters');
        if (!sb.model) return coded(400, 'model_required', 'model is required');
        if (mode !== 'headless' && mode !== 'terminal') return coded(400, 'mode_invalid', 'mode must be "headless" or "terminal"');
        if (folder.includes('\0') || folder.startsWith('/') || folder.split('/').includes('..')) return coded(400, 'folder_invalid', 'folder must be a relative path with no .. segment');
        if (!auditEnabled) return coded(503, 'audit_unavailable', 'auditing is off; the Chief of Staff cannot start a session');
        const proj = projects.get(sb.projectId);
        if (!proj || proj.kind === 'remote') return coded(403, 'project_not_available', 'project is not available for a session launch');
        // A hosted project's path is on the host: the folder is joined as text, never stat'd.
        const directory = proj.host_id ? path.posix.join(proj.path || '/fake', folder) : path.join(proj.path || '/fake', folder);
        if (!proj.host_id && (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) return coded(400, 'folder_not_found', 'folder does not exist in the project');
        if (mode === 'terminal' && proj.host_id) return coded(400, 'terminal_on_host', 'a terminal start is not available in a project on an SSH host; start a headless agent');
        const claude = ['haiku', 'sonnet', 'opus'].includes(sb.model);
        if (mode === 'terminal' && !claude) return coded(400, 'terminal_needs_claude', 'a terminal start needs a Claude model');
        cosStarts.push({ scope: scopeHeader ?? null, body: sb });
        cosStartWaiters.splice(0).forEach((r) => r());
        if (cosStartFailure) return coded(cosStartFailure.status, cosStartFailure.code, cosStartFailure.message);
        const first = prompt.split('\n')[0].split(/\s+/).filter(Boolean).join(' ');
        const name = [...first].slice(0, 60).join('') || 'Chief of Staff agent';
        const at = new Date().toISOString();
        let sessionId;
        if (mode === 'headless') {
          sessionId = `sess-${++seq}`;
          sessions.set(sessionId, {
            sessionId, projectId: sb.projectId, name, directory, model: sb.model, headless: true, agent: true, origin: 'chief-of-staff',
            createdAt: at, history: [relayFrames.historyUser({ timestamp: at, content: prompt, origin: 'chief-of-staff' })], messageCount: 1,
          });
        } else {
          sessionId = `term-${++seq}`;
          terminals.set(sessionId, {
            terminalId: sessionId, templateId: 'claude-code', name, directory, host: null, origin: 'chief-of-staff',
            state: 'running', cols: 80, rows: 24, scrollback: SHELL_PROMPT, line: '',
          });
        }
        return send(201, {
          sessionId, name, projectId: sb.projectId, directory, mode, kind: mode === 'headless' ? (claude ? 'claude' : 'chat') : 'pty',
          origin: 'chief-of-staff', at,
        });
      }

      // http_terminal.go HandleListTerminals: {terminals: [Summary]}; origin only when set.
      if (p === '/api/terminals' && req.method === 'GET') {
        return send(200, { terminals: [...terminals.values()].map((t) => ({
          id: t.terminalId, templateId: t.templateId, name: t.name, directory: t.directory, state: t.state,
          ...(t.origin ? { origin: t.origin } : {}),
        })) });
      }

      if (p === '/api/sessions' && req.method === 'POST') {
        sessionCreates.push(parsed);
        // session_launch.go AuthorizeLaunch, in its order, for eve's body
        // (kind from session_routes.go deriveSessionKind(model)): no project,
        // then an unknown or remote (kind: 'remote') project (refused
        // alike; an SSH-hosted project, host_id set, proceeds), then pi on a
        // hosted project, then a model outside a non-empty, non-wildcard
        // allowlist. A forced failure stands in for the launch
        // path behind them. Every body is {error: message}.
        const model = typeof parsed.model === 'string' ? parsed.model : '';
        const kind = ['haiku', 'sonnet', 'opus'].includes(model) ? 'claude' : model.startsWith('pi/') ? 'pi' : 'chat';
        if (!parsed.projectId) return send(403, { error: `${kind} sessions require a project` });
        const guardProject = projects.get(parsed.projectId);
        if (!guardProject || guardProject.kind === 'remote') {
          return send(403, { error: 'project is not available for a session launch' });
        }
        if (kind === 'pi' && guardProject.host_id) {
          return send(403, { error: 'provider "pi" is not available on a host project' });
        }
        const allowed = Array.isArray(guardProject.allowed_models) ? guardProject.allowed_models : [];
        if (model && allowed.length > 0 && !allowed.includes('*') && !allowed.includes(model)) {
          return send(403, { error: 'model is not allowed for this project' });
        }
        if (sessionCreateFailure) return send(sessionCreateFailure.status, sessionCreateFailure.body);
        const respond = () => {
          const sessionId = parsed.sessionId || `sess-${++seq}`;
          // types.Session JSON (internal/sessions/types/session.go).
          const session = {
            sessionId,
            projectId: parsed.projectId || '',
            name: parsed.name || '',
            directory: parsed.directory || '/fake',
            model: parsed.model || 'fake-model',
            providerType: 'claude',
            createdAt: new Date().toISOString(),
            messages: [],
            stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
          };
          // Mirrors relayLLM resolving the project's host_id through
          // ResolvePtyEnv (../relay/docs/ssh-hosts.md "Session and terminal
          // records gain Host").
          const project = projects.get(session.projectId);
          if (project?.host_id && hosts.has(project.host_id)) {
            const host = hosts.get(project.host_id);
            session.host = { id: host.id, name: host.name };
          }
          sessions.set(sessionId, session);
          if (parsed.settings && parsed.settings.headless === true && parsed.agent !== true) unlistedIds.add(sessionId);
          if (String(parsed.name || '').startsWith('__cos:')) {
            // session_launch.go mergePermissionSettings: a project with a policy replaces the client's
            // deniedTools; one without passes the client's through. claude.go hands deniedTools to
            // --disallowedTools and preflight.go refuses them with "denied by project policy".
            const policy = (project && project.permissionPolicy) || (parsed.settings && parsed.settings.permissionPolicy) || null;
            cosSessionCreates.push({ sessionId, body: parsed, deniedTools: (policy && policy.deniedTools) || [] });
            if (parsed.settings && parsed.settings.readOnlyProjects === true) cosReadOnlyIds.add(sessionId);
          }
          return send(201, session);
        };
        // Held open until the test releases it — see holdSessionCreate().
        if (sessionCreateGate) return sessionCreateGate.then(respond);
        return respond();
      }
      const sm = p.match(/^\/api\/sessions\/([^/]+)$/);
      // HandleDeleteSession (http_session.go): 204, no body.
      if (sm && req.method === 'DELETE') { sessions.delete(sm[1]); return send(204); }
      // Object-wrapped, matching relay's real session-host handler
      // (internal/sessions/api.HandleListSessions) — eve's own route
      // (routes/index.js) unwraps this before it ever reaches a test's
      // assertions, so this is what actually exercises that unwrap.
      // Items are session.Summary (manager.go): `id`, not `sessionId`.
      if (p === '/api/sessions' && req.method === 'GET') {
        return send(200, { sessions: [...sessions.values()].filter((sess) => !unlistedIds.has(sess.sessionId)).map(toSummary) });
      }

      // C11 SH-6 resume: eve calls this exactly once per resume_required it
      // decides to act on. Status is whatever the test last set via
      // failResumeWith() / clearResumeFail(); defaults to a real 200.
      const resumeMatch = p.match(/^\/api\/sessions\/([^/]+)\/resume$/);
      if (resumeMatch && req.method === 'POST') {
        const id = resumeMatch[1];
        if (resumeFailStatus) return send(resumeFailStatus, { error: 'forced resume failure' });
        return send(200, { session_id: id, resumed: true });
      }

      // POST /api/sessions/{id}/drop-in (cmd/relay/session_dropin.go, session/dropin.go), in
      // relay's order. Every refusal is {error, message}; 201 is {sessionId, claudeSessionId,
      // terminal} with no top-level host on the console.
      const dropInMatch = p.match(/^\/api\/sessions\/([^/]+)\/drop-in$/);
      if (dropInMatch && req.method === 'POST') {
        const id = decodeURIComponent(dropInMatch[1]);
        dropIns.push({ sessionId: id, body: parsed });
        const sess = sessions.get(id);
        if (!sess) return send(404, { error: 'session_not_found', message: `no session ${id}` });
        const model = typeof sess.model === 'string' ? sess.model : '';
        const kind = ['haiku', 'sonnet', 'opus'].includes(model) ? 'claude' : model.startsWith('pi/') ? 'pi' : 'chat';
        if (kind !== 'claude') {
          return send(409, { error: 'not_claude', message: `only Claude sessions can be taken over; this is a ${kind} session` });
        }
        if (!sess.headless) return send(409, { error: 'not_headless', message: 'this session is not headless; continue it in eve' });
        if (heldSessions.has(id)) return send(409, { error: 'dropped_in', message: 'a terminal already has this session; close it first' });
        if (dropInFailure) return send(dropInFailure.status, dropInFailure.body);
        const respond = () => {
          const terminalId = `term-${++seq}`;
          const terminal = {
            terminalId, templateId: 'claude-code', name: `${sess.name || 'session'} (drop-in)`,
            directory: sess.directory || '', host: null,
          };
          terminals.set(terminalId, { ...terminal, state: 'running', cols: parsed.cols || 80, rows: parsed.rows || 24, scrollback: SHELL_PROMPT, line: '' });
          heldSessions.set(id, terminalId);
          dropInTerminals.set(terminalId, id);
          for (const sock of relayWs) sock.send(JSON.stringify(relayFrames.sessionState({ sessionId: id, state: 'running', since: new Date().toISOString() })));
          return send(201, { sessionId: id, claudeSessionId: '00000000-0000-4000-8000-000000000196', terminal });
        };
        if (dropInGate) return dropInGate.then(respond);
        return respond();
      }

      // C11: eve's terminal_create WS frame is answered by this HTTP route,
      // not forwarded to relay over WS (see protocol.js). 201 body mirrors
      // relay's real CreatedBody (internal/sessions/terminal/types.go) —
      // `terminalId`, not `id`.
      if (p === '/api/terminals' && req.method === 'POST') {
        if (terminalCreateFailStatus) return send(terminalCreateFailStatus, { error: 'forced terminal create failure' });
        const terminalId = parsed.terminalId || `term-${++seq}`;
        const terminal = {
          terminalId,
          templateId: parsed.templateId || '',
          name: parsed.name || '',
          directory: parsed.directory || '',
          host: null, // CreatedBody.Host (terminal/types.go): null on the console
        };
        terminals.set(terminalId, { ...terminal, state: 'running', cols: parsed.cols || 80, rows: parsed.rows || 24, scrollback: SHELL_PROMPT, line: '' });
        return send(201, terminal);
      }

      if (p === '/api/models' && req.method === 'GET') {
        const respond = () => send(200, modelsPayload ?? { models: [{ value: 'fake-model', label: 'Fake Model' }] });
        // Held open until the test releases it — see holdModels().
        if (modelsGate) return modelsGate.then(respond);
        return respond();
      }
      if (p === '/api/mcps' && req.method === 'GET') return send(200, []);
      // Bare array, matching relay's real GET /api/terminal/templates
      // (cmd/relay/template_routes.go: config.EffectiveTerminalTemplates) —
      // relay's own route, unrelated to relay-sessions' object-wrapped
      // /api/sessions and /api/terminals. Empty by default so the picker's
      // "no templates available"/pty-card-absent branches are what a test
      // sees unless it seeds otherwise.
      if (p === '/api/terminal/templates' && req.method === 'GET') return send(200, terminalTemplates);
      // relayScheduler (../relayScheduler api.go), reached through relay's
      // reverse proxy, which adds nothing. Shapes: task.go (Task, Execution, TaskView).
      if (schedulerIsDown && p.startsWith('/api/tasks')) return sendText(502, 'bad gateway');
      // audit_routes.go parseAuditQueryParams + ops.go Query: filters actor.project_id and
      // event, limit defaults to 200, newest first, and [] while auditing is off.
      if (p === '/api/audit' && req.method === 'GET') {
        const q = url.searchParams;
        if (q.has('limit') && q.get('limit') !== '' && !/^[+-]?\d+$/.test(q.get('limit'))) {
          return send(400, { error: `limit: ${JSON.stringify(q.get('limit'))} is not an integer` });
        }
        if (q.has('deep') && q.get('deep') !== '' && !['1', 't', 'T', 'TRUE', 'true', 'True', '0', 'f', 'F', 'FALSE', 'false', 'False'].includes(q.get('deep'))) {
          return send(400, { error: `deep: ${JSON.stringify(q.get('deep'))} is not a boolean` });
        }
        if (!auditEnabled) return send(200, []);
        const limit = Number(q.get('limit')) > 0 ? Number(q.get('limit')) : 200;
        const rows = auditEvents.filter((e) => (!q.get('project_id') || (e.actor || {}).project_id === q.get('project_id'))
          && (!q.get('event') || e.event === q.get('event')));
        return send(200, rows.reverse().slice(0, limit));
      }
      // ops.go LogPath: the path while auditing is on, a 400 when it is off.
      if (p === '/api/audit/log' && req.method === 'GET') {
        return auditEnabled ? send(200, { path: '/fake/audit.log' }) : send(400, { error: 'auditing is disabled' });
      }
      if (p === '/api/tasks' && req.method === 'POST' && taskCreateFailure) {
        return send(taskCreateFailure.status, taskCreateFailure.body);
      }
      if (p === '/api/tasks' && req.method === 'GET') {
        const pid = url.searchParams.get('projectId');
        return send(200, [...tasks.values()].filter((t) => !pid || t.projectId === pid).map(taskWire));
      }
      if (p === '/api/tasks' && req.method === 'POST') {
        const err = validateTask(parsed);
        if (err) return send(400, { error: err });
        const now = ts();
        const task = { enabled: false, catchUp: false, ...parsed, id: `task-${++seq}`, createdAt: now, updatedAt: now };
        tasks.set(task.id, task);
        return send(201, taskWire(task));
      }
      const byProject = p.match(/^\/api\/tasks\/by-project\/([^/]+)$/);
      if (byProject && req.method === 'DELETE') {
        let count = 0;
        for (const [id, t] of [...tasks]) if (t.projectId === decodeURIComponent(byProject[1])) { tasks.delete(id); histories.delete(id); count++; }
        return send(200, { deleted: count });
      }
      const tm = p.match(/^\/api\/tasks\/([^/]+)(\/history|\/run)?$/);
      if (tm) {
        const id = tm[1];
        const task = tasks.get(id);
        if (!tm[2] && req.method === 'GET') return task ? send(200, taskWire(task)) : send(404, { error: 'task not found' });
        if (!tm[2] && req.method === 'PUT') {
          const err = validateTask(parsed);
          if (err) return send(400, { error: err });
          if (!task) return send(404, { error: 'task not found' });
          // Clients send definitions, not run state: the stored run state survives.
          const keep = {};
          for (const k of ['lastRun', 'lastStatus', 'lastSessionId', 'lastTerminalId']) if (!parsed[k]) keep[k] = task[k];
          const updated = { ...parsed, ...keep, id, createdAt: task.createdAt, updatedAt: ts() };
          tasks.set(id, updated);
          return send(200, taskWire(updated));
        }
        if (!tm[2] && req.method === 'DELETE') {
          if (!task) return send(404, { error: 'task not found' });
          tasks.delete(id); histories.delete(id);
          return send(200, { deleted: true });
        }
        if (tm[2] === '/history' && req.method === 'GET') {
          return task ? send(200, histories.get(id) || []) : send(404, { error: 'task not found' });
        }
        if (tm[2] === '/run' && req.method === 'POST') {
          if (!task) return send(404, { error: 'task not found' });
          if (task.lastStatus === 'running') return send(409, { error: 'task is already running' });
          startTaskRun(task);
          return send(200, { success: true, message: 'Task execution started' });
        }
      }

      if (p === '/api/eve/passkey-enrolment' && req.method === 'GET') {
        const open = !!eveEnrolment && Date.parse(eveEnrolment.expires) > Date.now();
        return send(200, open ? { open: true, expires: eveEnrolment.expires } : { open: false });
      }
      if (p === '/api/eve/passkey-enrolment/consume' && req.method === 'POST') {
        const open = !!eveEnrolment && Date.parse(eveEnrolment.expires) > Date.now();
        if (!open) return send(409, { error: 'not open' });
        const { expires } = eveEnrolment;
        eveEnrolment = null;
        consumedEnrolments.push({ ip: parsed.ip, label: parsed.label, at: new Date().toISOString() });
        return send(200, { expires });
      }

      // Report is the acknowledgement (decision 12): drop every pending
      // revocation whose id is absent from this report, or that would empty
      // it (mirrors relay's own last-credential guard, decision 13).
      if (p === '/api/eve/passkeys' && req.method === 'PUT') {
        reportedPasskeys = Array.isArray(parsed.passkeys) ? parsed.passkeys : [];
        const ids = new Set(reportedPasskeys.map((pk) => pk.id));
        for (const id of [...pendingRevocations]) {
          if (!ids.has(id) || reportedPasskeys.length === 1) pendingRevocations.delete(id);
        }
        return send(200, { revocations: [...pendingRevocations] });
      }
      if (p === '/api/eve/passkeys/revocations' && req.method === 'GET') {
        return send(200, { revocations: [...pendingRevocations] });
      }

      if (p.startsWith('/api/generated/') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from('FAKE-PNG-BYTES'));
      }
      // HandleTerminalLog (http_terminal.go): text/plain, and a bare 404 for a
      // terminal relay has no log for.
      const logMatch = p.match(/^\/api\/terminals\/(.+)\/log$/);
      if (logMatch && req.method === 'GET') {
        if (!terminals.has(logMatch[1])) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(Buffer.from('TERMINAL-LOG-BYTES'));
      }

      // persistent_session_routes.go. Errors carry the ops' own reason text.
      const psMatch = p.match(/^\/api\/projects\/([^/]+)\/persistent-sessions(?:\/([^/]+))?$/);
      if (psMatch && ((req.method === 'GET' && !psMatch[2]) || (req.method === 'DELETE' && psMatch[2]))) {
        const projectId = decodeURIComponent(psMatch[1]);
        const proj = projects.get(projectId);
        if (!proj || !proj.host_id) return send(404, { error: `hosted project "${projectId}" not found` });
        const failure = persistentFailures.get(projectId);
        if (failure) return send(failure.status, { error: failure.error });
        const list = persistentSessions.get(projectId) || [];
        if (req.method === 'GET') return send(200, list);
        const name = decodeURIComponent(psMatch[2]);
        if (!/^relay-/.test(name)) return send(400, { error: `${JSON.stringify(name)} is not a relay persistent session name` });
        const idx = list.findIndex((x) => x.name === name);
        if (idx === -1) return send(404, { error: `session ${JSON.stringify(name)} does not belong to project ${JSON.stringify(projectId)}` });
        list.splice(idx, 1);
        return send(204);
      }

      // frontend_dispatcher.go: a path no service claims.
      return sendText(404, 'no service registered for this path');
    });
  };

  // Test-side faults on a route the fake already serves: one hook ahead of the
  // route table, keyed on method and exact path. A fault adds no behaviour a
  // real relay lacks (a hop that answers an error, or answers late).
  const routeFaults = [];
  const server = http.createServer((req, res) => {
    const faultPath = new URL(req.url, 'http://relay.local').pathname;
    const fault = routeFaults.find((f) => f.method === req.method && f.path === faultPath);
    if (!fault) return routeHandler(req, res);
    const go = () => {
      if (fault.status === undefined) return routeHandler(req, res);
      requests.push({ method: req.method, path: faultPath });
      req.resume();
      res.writeHead(fault.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fault.body));
    };
    if (fault.delayMs) { const t = setTimeout(go, fault.delayMs); t.unref?.(); } else go();
  });

  // Registered before the WebSocketServer's own upgrade listener, so the
  // cork is in place when ws writes the 101 and fires `connection`.
  let handshakeHoldMs = 0;
  server.on('upgrade', (req, socket) => {
    if (!handshakeHoldMs || new URL(req.url, 'http://relay.local').pathname !== '/ws') return;
    const ms = handshakeHoldMs;
    handshakeHoldMs = 0;
    socket.cork();
    setTimeout(() => socket.uncork(), ms);
  });
  // A refused upgrade is an HTTP 401 before any WebSocket exists, exactly like
  // the HTTP routes (frontendCredentialAuth wraps the whole frontend mux).
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
      const wsScope = info.req.headers['x-relay-scope'];
      scopeLog.push({ method: 'GET', path: new URL(info.req.url, 'http://relay.local').pathname, scope: wsScope ?? null, upgrade: true });
      if (requiredToken !== null && info.req.headers.authorization !== `Bearer ${requiredToken}`) {
        rejectedRequests.push({ method: 'GET', path: info.req.url, upgrade: true });
        return cb(false, 401, 'unauthorized');
      }
      if (wsScope !== undefined && (wsScope !== COS_SCOPE || new URL(info.req.url, 'http://relay.local').pathname !== '/ws')) {
        return cb(false, 403, 'Forbidden');
      }
      return cb(true);
    },
  });
  wss.on('connection', (ws, req) => {
    // A scoped viewer only listens: it receives the broadcast frames (emitToRelay) and never joins a
    // session. Its first inbound frame ends the connection (frontend_dispatcher.go refuseClientFrames).
    if (req.headers['x-relay-scope'] !== undefined) {
      scopedWs.add(ws);
      scopedResolvers.splice(0).forEach((r) => r());
      ws.on('message', () => ws.close(1008, 'chief-of-staff scope is read-only'));
      ws.on('close', () => scopedWs.delete(ws));
      ws.on('error', () => {});
      return;
    }
    if (new URL(req.url, 'http://relay.local').pathname === '/ws/files') return files.serveWs(ws);
    const isScheduler = (req.url || '').startsWith('/ws/tasks');
    (isScheduler ? schedulerWs : relayWs).add(ws);
    if (!isScheduler) relaySocketIds.set(ws, ++relaySocketSeq);
    // wshandler.go: a scheduler client is sent task_status at once. `running`
    // is JSON null (a nil Go slice) when nothing runs.
    if (isScheduler) {
      const running = [...tasks.values()].filter((t) => t.lastStatus === 'running')
        .map((t) => ({ taskId: t.id, projectId: t.projectId, taskName: t.name, view: viewOf(t) }));
      ws.send(JSON.stringify({ type: 'task_status', running: running.length ? running : null }));
    }
    (isScheduler ? schedulerResolvers : relayResolvers).splice(0).forEach((r) => r());

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!isScheduler) msg.__relaySocketId = relaySocketIds.get(ws);
      recordInbound(msg);
      if (isScheduler) return;
      if (msg.type === 'join_session') {
        // ws_session.go handleJoinSession: an empty id is ignored without a
        // reply, an id relay does not hold gets an error frame with no
        // sessionId, and anything else is bound to this connection.
        if (!msg.sessionId) return;
        const known = sessions.has(msg.sessionId) || seededJoinable.has(msg.sessionId);
        if (failedJoins.has(msg.sessionId) || (strictJoin && !known)) {
          ws.send(JSON.stringify(relayFrames.error({ message: `session not found: ${msg.sessionId}` })));
          return;
        }
        const reply = () => {
          if (!joined.has(msg.sessionId)) joined.set(msg.sessionId, new Set());
          joined.get(msg.sessionId).add(relaySocketIds.get(ws));
          const sess = sessions.get(msg.sessionId);
          ws.send(JSON.stringify(relayFrames.sessionJoined({
            sessionId: msg.sessionId,
            directory: sess ? sess.directory : '/fake',
            session: sess,
          })));
        };
        const gate = joinGates.get(msg.sessionId);
        if (gate) gate.then(reply); else reply();
      } else if (msg.type === 'send_message' && String((sessions.get(msg.sessionId) || {}).name || '').startsWith('__cos:')) {
        // The Chief of Staff's model session. Turn 1 is the bootstrap: it reports its tool list in
        // system/init (events.go `tools`) before it answers.
        const sess = sessions.get(msg.sessionId);
        sess.cosTurns = (sess.cosTurns || 0) + 1;
        cosModelTurns.push({ sessionId: msg.sessionId, text: msg.text, n: sess.cosTurns });
        cosTurnWaiters.filter((w) => w.pred(cosModelTurns[cosModelTurns.length - 1])).forEach((w) => { cosTurnWaiters.splice(cosTurnWaiters.indexOf(w), 1); w.resolve(); });
        const person = String(msg.text).startsWith('Chief of Staff person');
        const fallback = sess.cosTurns === 1 ? 'ready' : (person ? 'Noted.' : `\`\`\`json\n{"posts":[]}\n\`\`\``);
        // reply() answers a string, or { text, toolUses: [{ id, name, input }], gate }: the tool_use
        // blocks stream first (events.go ToolUseBlockStop), and the turn ends only after `gate` settles.
        const scripted = cosModel.reply && cosModel.reply(String(msg.text), sess.cosTurns);
        const plan = scripted && typeof scripted === 'object' ? scripted : { text: scripted };
        const text = plan.text ?? fallback;
        const out = [];
        if (sess.cosTurns === 1) out.push(relayFrames.systemInit({ sessionId: msg.sessionId, model: 'claude-haiku-4-5-20251001', tools: cosModel.tools ?? cosInitTools(msg.sessionId) }));
        (plan.toolUses || []).forEach((t, index) => out.push({
          type: 'llm_event', sessionId: msg.sessionId,
          event: { v: EVENT_PROTOCOL_VERSION, type: 'assistant', index, content_block_stop: true, content_block: { type: 'tool_use', id: t.id, name: t.name, input: t.input } },
        }));
        const finish = [relayFrames.assistantDelta({ sessionId: msg.sessionId, text }), relayFrames.messageComplete({ sessionId: msg.sessionId })];
        for (const f of out) ws.send(JSON.stringify(f));
        const sendFinish = () => { for (const f of finish) ws.send(JSON.stringify(f)); };
        if (plan.gate) plan.gate.then(sendFinish); else sendFinish();
      } else if (msg.type === 'send_message') {
        const script = sessionScripts.get(msg.sessionId);
        const refusal = fileRefusal(msg.files);
        const frames = refusal
          ? [relayFrames.error({ message: refusal, sessionId: msg.sessionId })]
          : script
            ? script.map((f) => stampFrame(f, msg.sessionId))
            : defaultStream(msg.sessionId);
        for (const f of frames) { notePending(f); ws.send(JSON.stringify(f)); }
      } else if (msg.type === 'join_terminal' || msg.type === 'terminal_reconnect') {
        // ws_terminal.go: an unknown id is ignored; a known one is bound to this
        // connection and answered with terminal_joined (scrollback included).
        const term = terminals.get(msg.terminalId);
        if (!term) return;
        if (!terminalViewers.has(term.terminalId)) terminalViewers.set(term.terminalId, new Set());
        terminalViewers.get(term.terminalId).add(relaySocketIds.get(ws));
        if (msg.cols) term.cols = msg.cols;
        if (msg.rows) term.rows = msg.rows;
        ws.send(JSON.stringify(termJoined(term)));
      } else if (msg.type === 'terminal_input') {
        // ws_terminal.go handleTerminalInput: `data` is base64; bad base64 and an
        // unknown terminal are error frames.
        if (!msg.terminalId) return;
        const raw = String(msg.data || '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
          ws.send(JSON.stringify(relayFrames.error({ message: 'invalid base64 data' })));
          return;
        }
        const term = terminals.get(msg.terminalId);
        if (!term) { ws.send(JSON.stringify(relayFrames.error({ message: `terminal not found: ${msg.terminalId}` }))); return; }
        termInput(term, Buffer.from(raw, 'base64').toString('utf8'));
      } else if (msg.type === 'terminal_list') {
        ws.send(JSON.stringify({
          type: 'terminal_list',
          terminals: [...terminals.values()].sort((a, b) => (a.terminalId < b.terminalId ? -1 : 1)).map((t) => ({
            id: t.terminalId, templateId: t.templateId, name: t.name, directory: t.directory, state: t.state, host: null,
          })),
        }));
      } else if (msg.type === 'terminal_close') {
        if (!msg.terminalId) return;
        terminals.delete(msg.terminalId);
        terminalViewers.delete(msg.terminalId);
        // ws_terminal.go handleTerminalClose -> mgr.Close; relay then HandBack()s the session.
        const heldId = dropInTerminals.get(msg.terminalId);
        if (heldId) {
          dropInTerminals.delete(msg.terminalId);
          heldSessions.delete(heldId);
          for (const sock of relayWs) sock.send(JSON.stringify(relayFrames.sessionState({ sessionId: heldId, state: 'idle', since: new Date().toISOString() })));
        }
        for (const sock of relayWs) sock.send(JSON.stringify({ type: 'terminal_closed', terminalId: msg.terminalId }));
      } else if (msg.type === 'permission_response') {
        // ws_session.go handlePermissionResponse: unknown permission id is a
        // silent no-op; a connection that never joined the request's session
        // is refused; otherwise the request is resolved.
        const sessionId = pendingPermissions.get(msg.permissionId);
        if (sessionId === undefined) return;
        if (!(joined.get(sessionId) || new Set()).has(relaySocketIds.get(ws))) {
          ws.send(JSON.stringify(relayFrames.error({
            message: `permission response refused: this connection has not joined session ${sessionId}`,
          })));
          return;
        }
        pendingPermissions.delete(msg.permissionId);
      } else if (msg.type === 'clear_session') {
        const script = clearSessionScripts.get(msg.sessionId);
        if (script) {
          for (const f of script.map((fr) => stampFrame(fr, msg.sessionId))) ws.send(JSON.stringify(f));
        }
      }
    });
    ws.on('close', () => {
      relayWs.delete(ws); schedulerWs.delete(ws);
      for (const set of joined.values()) set.delete(relaySocketIds.get(ws));
    });
    ws.on('error', () => {});
  });

  return {
    failRoute: (method, path, status, body = { error: 'unavailable' }) => { routeFaults.push({ method, path, status, body }); },
    delayRoute: (method, path, delayMs) => { routeFaults.push({ method, path, delayMs }); },
    clearRouteFaults: () => { routeFaults.length = 0; },
    addProject: (proj) => { projects.set(proj.id, proj); },
    addHost: (host) => { hosts.set(host.id, { status: 'unknown', ssh_argv: [], ...host }); },
    // For reload/restore tests that need GET /api/sessions to already know
    // about an id a localStorage fixture references, without a real POST.
    seedSession: (session) => { sessions.set(session.sessionId, session); },
    // An id a strictJoin() test may join although no POST created it.
    allowJoin: (sessionId) => { seededJoinable.add(sessionId); },
    // The file plane: seed / emit / watch hooks and what relay saw (see docs/test.md).
    files: files.hooks,
    getProject: (id) => projects.get(id),
    listProjects: () => Object.fromEntries(projects),
    listSessions: () => [...sessions.values()],
    scriptSession: (sessionId, frames) => { sessionScripts.set(sessionId, frames); },
    scriptClearSession: (sessionId, frames) => { clearSessionScripts.set(sessionId, frames); },
    listTerminals: () => [...terminals.values()],
    seedTerminal: (terminal) => { terminals.set(terminal.terminalId, { templateId: '', name: '', directory: '', state: 'running', cols: 80, rows: 24, scrollback: SHELL_PROMPT, line: '', ...terminal }); },
    setTerminalTemplates: (list) => { terminalTemplates = list; },
    terminalScrollback: (id) => (terminals.get(id) || {}).scrollback,
    failTerminalCreateWith: (status) => { terminalCreateFailStatus = status; },
    clearTerminalCreateFail: () => { terminalCreateFailStatus = null; },
    failDropInWith: (status, body) => { dropInFailure = { status, body }; },
    clearDropInFail: () => { dropInFailure = null; },
    holdDropIn: () => {
      let release;
      dropInGate = new Promise((resolve) => { release = resolve; });
      return { release: () => { release(); dropInGate = null; } };
    },
    // Parsed POST /api/sessions/{id}/drop-in bodies, in arrival order: [{ sessionId, body }].
    dropIns,
    failResumeWith: (status) => { resumeFailStatus = status; },
    clearResumeFail: () => { resumeFailStatus = null; },
    // Tasks as relayScheduler holds them. seedTask stores a definition as given
    // (id required); holdTaskRuns() keeps runs `running` until finishTask().
    // Test-side PUT /api/default_project/{mode}, without the validation.
    setDefaultProject: (mode, projectId) => { defaultProjects[mode] = projectId; },
    seedTask: (task) => { tasks.set(task.id, { enabled: false, catchUp: false, createdAt: ts(), ...task }); },
    listTasks: () => [...tasks.values()].map(taskWire),
    taskHistory: (id) => histories.get(id) || [],
    holdTaskRuns: (on = true) => { taskRunMode = on ? 'hold' : 'auto'; },
    finishTask,
    failTaskCreateWith: (status, body) => { taskCreateFailure = { status, body }; },
    schedulerDown: (on = true) => { schedulerIsDown = on; },
    // Audit events as relay's recorder holds them (oldest first); setAuditEnabled(false) is "auditing off".
    seedAudit: (events) => { auditEvents = [...events]; },
    setAuditEnabled: (on = true) => { auditEnabled = on; },
    // Test-side equivalent of the tray's "Allow Eve Passkey Enrolment…" / `relay eve enrol`.
    openEveEnrolment: (ttlMs = 5 * 60 * 1000) => { eveEnrolment = { expires: new Date(Date.now() + ttlMs).toISOString() }; },
    listConsumedEnrolments: () => [...consumedEnrolments],
    // Test-side equivalent of relay's presence-gated `eve.passkey.revoke`.
    seedPasskeyRevocation: (id) => { pendingRevocations.add(id); },
    listReportedPasskeys: () => [...reportedPasskeys],
    listPendingRevocations: () => [...pendingRevocations],
    // Every relay socket, joined or not. Prefer emitToSession for anything relay
    // sends per session: relay delivers only to joined viewers (SendToSession).
    // A chat tool_result's is_error and scope_violation (relay events.go) are sent as given through it.
    emitToRelay: (frame) => {
      notePending(frame);
      for (const ws of relayWs) ws.send(JSON.stringify(frame));
      if (BROADCAST_TYPES.has(frame.type)) for (const ws of scopedWs) ws.send(JSON.stringify(frame));
    },
    emitToSession: (sessionId, frame) => {
      notePending(frame);
      const ids = joined.get(sessionId) || new Set();
      let delivered = 0;
      for (const ws of relayWs) {
        if (ids.has(relaySocketIds.get(ws))) { ws.send(JSON.stringify(frame)); delivered++; }
      }
      return delivered;
    },
    // Relay closes the client socket when its upstream dial fails:
    // 1011 "upstream unreachable" (frontend_dispatcher.go proxyWS).
    closeRelaySockets: (code = 1011, reason = 'upstream unreachable') => {
      for (const ws of [...relayWs]) { try { ws.close(code, reason); } catch {} }
    },
    strictJoin: (on = true) => { strictJoin = on; },
    joinedSessions: () => Object.fromEntries([...joined].map(([id, set]) => [id, [...set]])),
    // Bearer enforcement on HTTP and upgrade; null turns it off.
    requireToken: (t) => { requiredToken = t; },
    rejectedRequests,
    failSessionCreateWith: (status, body) => { sessionCreateFailure = { status, body }; },
    clearSessionCreateFail: () => { sessionCreateFailure = null; },
    seedPersistentSessions: (projectId, list) => { persistentSessions.set(projectId, list.map((x) => ({ attached: 0, attached_here: false, created: 0, ...x }))); },
    failPersistentSessionsWith: (projectId, status, error) => { persistentFailures.set(projectId, { status, error }); },
    clearPersistentFailure: (projectId) => { persistentFailures.delete(projectId); },
    emitToScheduler: (frame) => { for (const ws of schedulerWs) ws.send(JSON.stringify(frame)); },
    // Chief of Staff: scoped viewers, the scope each request carried, the model sessions eve made.
    waitForScopedRelay: () => (scopedWs.size > 0 ? Promise.resolve() : new Promise((r) => scopedResolvers.push(r))),
    scopedConnectionCount: () => scopedWs.size,
    scopeLog,
    cosSessionCreates,
    cosModelTurns,
    // { tools, reply }: what the model session reports and how it answers (see cosModel above).
    setCosModel: (m) => { cosModel = { tools: null, reply: null, ...m }; },
    // Forces relay's refusal of the scoped send after the checks that precede the host: { status, code, message }.
    failChiefOfStaffSend: (status, code, message = code) => { cosSendFailure = { status, code, message }; },
    clearChiefOfStaffSendFailure: () => { cosSendFailure = null; },
    // The scoped start route: every accepted body with its scope, a forced launch refusal, and a
    // promise that resolves when the next start arrives.
    cosStarts,
    failChiefOfStaffStart: (status, code, message = code) => { cosStartFailure = { status, code, message }; },
    clearChiefOfStaffStartFailure: () => { cosStartFailure = null; },
    // value: { projectId, model, dailyModelCalls } -> configured:true; null -> configured:false; 'absent' -> 404.
    setChiefOfStaffConfig: (value) => { cosConfig = value === null ? { configured: false } : value === 'absent' ? 'absent' : { configured: true, ...value }; },
    waitForCosStart: () => (cosStarts.length > 0 ? Promise.resolve() : new Promise((r) => cosStartWaiters.push(r))),
    // Resolves once the model session has been sent a turn matching pred({ sessionId, text, n }).
    waitForCosTurn: (pred) => (cosModelTurns.some(pred) ? Promise.resolve() : new Promise((resolve) => cosTurnWaiters.push({ pred, resolve }))),
    waitForRelay: () => (relayWs.size > 0 ? Promise.resolve() : new Promise((r) => relayResolvers.push(r))),
    relayConnectionCount: () => relayWs.size,
    // Holds the next /ws upgrade's 101 reply for `ms`: waitForRelay() then
    // resolves while eve's side of the socket is still CONNECTING.
    holdRelayHandshake: (ms) => { handshakeHoldMs = ms; },
    // Delays the reply to POST /api/sessions until release() is called, so a
    // test can pin down a state window that would otherwise race the real
    // cross-process round trip (HTTP POST, then a WS session_created push).
    holdSessionCreate: () => {
      let release;
      sessionCreateGate = new Promise((resolve) => { release = resolve; });
      return { release: () => { release(); sessionCreateGate = null; } };
    },
    setModels: (payload) => { modelsPayload = payload; },
    // Same pattern, per session id: holds the session_joined reply for that
    // id so a test can force it to land after another session's.
    holdJoin: (sessionId) => {
      let release;
      joinGates.set(sessionId, new Promise((resolve) => { release = resolve; }));
      return { release: () => { release(); joinGates.delete(sessionId); } };
    },
    failJoinWith: (sessionId) => { failedJoins.add(sessionId); },
    // Same pattern as holdSessionCreate, for GET /api/models: lets a test
    // prove a launch waits for the model list instead of racing it.
    holdModels: () => {
      let release;
      modelsGate = new Promise((resolve) => { release = resolve; });
      return { release: () => { release(); modelsGate = null; } };
    },
    // Parsed POST /api/sessions bodies, in arrival order.
    sessionCreates,
    waitForScheduler: () => (schedulerWs.size > 0 ? Promise.resolve() : new Promise((r) => schedulerResolvers.push(r))),
    inbound,
    waitForInbound: (pred, timeoutMs = 5000) => new Promise((resolve, reject) => {
      const existing = inbound.find(pred);
      if (existing) return resolve(existing);
      const t = setTimeout(() => reject(new Error('waitForInbound: timed out')), timeoutMs);
      inboundWaiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    requests,
    // port is only ever passed by a test reviving a fake relay on the exact
    // port a still-running eve was pointed at (RELAY_FRONTEND_URL is fixed at
    // eve's spawn time, so a reconnect test has no other way to be found).
    listen: (port = 0) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      if (closed) return resolve(); // a resilience test may close the relay before the harness does
      closed = true;
      for (const ws of [...relayWs, ...schedulerWs, ...scopedWs]) { try { ws.terminate(); } catch {} }
      files.closeAll();
      wss.close(() => server.close(() => resolve()));
      // A closing relay drops its sockets; server.close() alone waits for
      // eve's keep-alive connections to drain, which can outlast a test.
      server.closeAllConnections();
    }),
  };
}

module.exports = { createFakeRelay };
