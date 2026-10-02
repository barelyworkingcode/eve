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
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const { relayFrames, EVENT_PROTOCOL_VERSION } = require('./protocol');

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
  const finishTask = (id, { status = 'success', response = '', error = '', exitCode } = {}) => {
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
    if (sess.lastMessageAt) out.lastMessageAt = sess.lastMessageAt;
    if (sess.host) out.host = sess.host;
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
      if (requiredToken !== null && req.headers.authorization !== `Bearer ${requiredToken}`) {
        rejectedRequests.push({ method: req.method, path: p });
        return sendText(401, 'unauthorized');
      }
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}

      // Mirrors the real relay's path validation (filepath.IsAbs): the
      // frontend sends "~/..." verbatim and the backend does not expand it,
      // so relative paths get a 400, not a 201.
      const isAbsPath = (pth) => typeof pth === 'string' && pth.startsWith('/');
      const absPathError = (pth) => send(400, { error: `project path must be an absolute path: ${JSON.stringify(pth ?? '')}` });
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
      if (p === '/api/sessions' && req.method === 'POST') {
        sessionCreates.push(parsed);
        // frontend_model_guard.go, in its order: a forced failure stands in
        // for the launch path behind it; the remote-project refusal (400)
        // precedes the allowed_models check (403); an unknown project, an
        // empty or wildcard allowlist, or no model all pass.
        const guardProject = projects.get(parsed.projectId);
        if (parsed.projectId && guardProject && guardProject.host_id) {
          return send(400, { error: `project ${parsed.projectId} is a remote project and cannot host a session` });
        }
        const allowed = guardProject && Array.isArray(guardProject.allowed_models) ? guardProject.allowed_models : [];
        if (parsed.projectId && parsed.model && guardProject && allowed.length > 0
          && !allowed.includes('*') && !allowed.includes(parsed.model)) {
          return send(403, { error: 'model not allowed for this project' });
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
        return send(200, { sessions: [...sessions.values()].map(toSummary) });
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
      if (requiredToken === null || info.req.headers.authorization === `Bearer ${requiredToken}`) return cb(true);
      rejectedRequests.push({ method: 'GET', path: info.req.url, upgrade: true });
      return cb(false, 401, 'unauthorized');
    },
  });
  wss.on('connection', (ws, req) => {
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
    emitToRelay: (frame) => { notePending(frame); for (const ws of relayWs) ws.send(JSON.stringify(frame)); },
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
      for (const ws of [...relayWs, ...schedulerWs]) { try { ws.terminate(); } catch {} }
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

module.exports = { createFakeRelay };
