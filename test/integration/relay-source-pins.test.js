/**
 * Drift guard for the fake relay. Every behaviour fake-relay.js / protocol.js
 * copies from relay is listed here with the relay file and the exact text it
 * was read from. When a relay checkout is present (../relay, or
 * EVE_RELAY_SOURCE) each needle must still be in its file, so a relay change
 * that moves a status, a message or a JSON key fails here instead of leaving
 * the fake quietly wrong. The fake side runs everywhere: each pin also names
 * the text the fake must carry, so the two cannot be edited apart.
 *
 * Without a relay checkout (CI, other machines) the relay half is reported as
 * a todo, not a pass.
 */
const fs = require('fs');
const path = require('path');

const FAKE = fs.readFileSync(path.join(__dirname, 'fake-relay.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, 'protocol.js'), 'utf8');

function firstExisting(candidates, marker) {
  return candidates.filter(Boolean).find((dir) => fs.existsSync(path.join(dir, marker)));
}
const relayRoot = () => firstExisting([process.env.EVE_RELAY_SOURCE, path.resolve(__dirname, '..', '..', '..', 'relay')],
  path.join('cmd', 'relay', 'frontend_server.go'));
// relayScheduler sits beside eve, or at the cloud clone path; EVE_SCHEDULER_SOURCE overrides.
const schedulerRoot = () => firstExisting([
  process.env.EVE_SCHEDULER_SOURCE,
  path.resolve(__dirname, '..', '..', '..', 'relayScheduler'),
  path.resolve(__dirname, '..', '..', '..', 'relayscheduler'),
  path.resolve(__dirname, '..', '..', '..', 'barelyworkingcode', 'relayscheduler'),
], 'scheduler.go');

// [what, file, needle in that file, needle the fake must carry, source: 'relay' (default) | 'scheduler']
const PINS = [
  ['401 is text/plain "unauthorized"', 'cmd/relay/frontend_server.go', 'http.Error(w, "unauthorized", http.StatusUnauthorized)', "sendText(401, 'unauthorized')"],
  ['unmatched path is a text/plain 404', 'cmd/relay/frontend_dispatcher.go', 'http.Error(w, "no service registered for this path", http.StatusNotFound)', "sendText(404, 'no service registered for this path')"],
  ['upstream dial failure closes 1011', 'cmd/relay/frontend_dispatcher.go', 'websocket.CloseInternalServerErr, "upstream unreachable"', "code = 1011, reason = 'upstream unreachable'"],
  ['model allowlist refusal', 'cmd/relay/session_launch.go', 'forbidden("model_not_allowed", "model is not allowed for this project"', "error: 'model is not allowed for this project'"],
  ['remote project refusal', 'cmd/relay/session_launch.go', 'forbidden("project_not_available", "project is not available for a session launch"', "error: 'project is not available for a session launch'"],
  ['no-project refusal', 'cmd/relay/session_launch.go', 'forbidden("project_required", fmt.Sprintf("%s sessions require a project", req.Kind)', ' sessions require a project'],
  ['project 404 body', 'cmd/relay/project_routes.go', '"error": "project not found"', "error: 'project not found'"],
  ['project delete is 204', 'cmd/relay/project_routes.go', 'w.WriteHeader(http.StatusNoContent)', "projects.delete(id); return send(204)"],
  ['host 404 body', 'cmd/relay/host_routes.go', '"error": "host not found"', "error: 'host not found'"],
  ['host in use 409', 'cmd/relay/host_routes.go', '"host is used by one or more projects"', "error: 'host is used by one or more projects'"],
  ['persistent sessions list route', 'cmd/relay/persistent_session_routes.go', '"GET /api/projects/{id}/persistent-sessions"', 'persistent-sessions'],
  ['persistent sessions kill route', 'cmd/relay/persistent_session_routes.go', '"DELETE /api/projects/{id}/persistent-sessions/{name}"', 'persistent-sessions'],
  ['persistent sessions unhosted project text', 'cmd/relay/persistent_session_ops.go', 'hosted project %q not found', 'hosted project "${projectId}" not found'],
  ['persistent sessions no-tmux kind', 'cmd/relay/persistent_session_ops.go', 'errors.New("host has no tmux")', 'persistentFailures'],
  ['persistent session row keys', 'cmd/relay/persistent_session_ops.go', 'json:"attached_here"', 'attached_here'],
  ['session delete is 204', 'internal/sessions/api/http_session.go', 'w.WriteHeader(http.StatusNoContent)', "sessions.delete(sm[1]); return send(204)"],
  ['every attached file becomes an image_url part', 'internal/sessions/provider/openai.go', '"type": "image_url",', "const NON_IMAGE_FILE_ERROR = 'chat: HTTP 400: image_url must use a base64 image data URI.'"],
  ['file data: prefix is kept as is', 'internal/sessions/provider/openai.go', 'if !strings.HasPrefix(url, "data:") {', "data.startsWith('data:')"],
  ['file mime defaults to image/png', 'internal/sessions/provider/openai.go', 'mime = "image/png"', "f.mimeType || 'image/png'"],
  ['session list row uses id', 'internal/sessions/session/manager.go', 'ID            string            `json:"id"`', 'id: sess.sessionId'],
  ['session list row has live', 'internal/sessions/session/manager.go', '`json:"live"`', 'live: sess.live !== false'],
  ['session list row has messageCount', 'internal/sessions/session/manager.go', '`json:"messageCount"`', 'messageCount'],
  // relay#232: agent state on the list row and the session_state frame.
  ['session list row has attention', 'internal/sessions/session/manager.go', 'Attention *attention.Attention `json:"attention,omitempty"`', 'out.attention = sess.attention'],
  ['attention has a since key', 'internal/sessions/attention/board.go', 'Since string `json:"since"`', 'since'],
  ['the session_state frame type', 'internal/sessions/events/ws_messages.go', 'WSMsgSessionState         = "session_state"', "type: 'session_state'"],
  ['the session_state frame carries since', 'internal/sessions/api/ws_session.go', '"since":     attention.FormatTime(c.Since),', 'sessionState: ({ sessionId, state, since'],
  ['session create body key', 'internal/sessions/types/session.go', '`json:"sessionId"`', 'sessionId,'],
  ['session create body providerType', 'internal/sessions/types/session.go', '`json:"providerType"`', "providerType: 'claude'"],
  ['terminal created body has host', 'internal/sessions/terminal/types.go', 'Host       map[string]string `json:"host"`', 'host: null'],
  ['terminal log is text/plain', 'internal/sessions/api/http_terminal.go', 'w.Header().Set("Content-Type", "text/plain; charset=utf-8")', "'text/plain; charset=utf-8' });\n        return res.end(Buffer.from('TERMINAL-LOG-BYTES'))"],
  ['join of an unknown session', 'internal/sessions/api/ws_session.go', 'sendWSError(c, "session not found: "+req.SessionID)', 'session not found: ${msg.sessionId}'],
  ['session_joined has live', 'internal/sessions/api/ws_session.go', '"live": p != nil && p.Alive(),', 'live: session.live !== false'],
  ['session_joined has protocolVersion', 'internal/sessions/api/ws_session.go', '"protocolVersion": events.ProtocolVersion,', 'protocolVersion: EVENT_PROTOCOL_VERSION'],
  ['session_joined has history', 'internal/sessions/api/ws_session.go', '"history":         history,', 'history: session.history || []'],
  ['permission response needs a joined connection', 'internal/sessions/api/ws_session.go', 'permission response refused: this connection has not joined session ', 'permission response refused: this connection has not joined session ${sessionId}'],
  ['resume_required carries message', 'internal/sessions/api/ws_session.go', '"message":   err.Error(),', "code: 'resume_required', sessionId, message"],
  ['project view has the effective mode', 'cmd/relay/project_dto.go', 'Mode             config.ProjectMode         `json:"mode"`', 'mode: effectiveMode(proj)'],
  ['project view has default_for', 'cmd/relay/project_dto.go', '`json:"default_for,omitempty"`', 'out.default_for = defaultFor'],
  ['project view has created_at', 'cmd/relay/project_dto.go', '`json:"created_at"`', 'created_at:'],
  ['default project route', 'cmd/relay/project_routes.go', '"PUT /api/default_project/{mode}"', '/api/default_project/'],
  ['default project id required', 'cmd/relay/project_routes.go', 'project_id is required; send \"\" to clear the default', 'project_id is required; send "" to clear the default'],
  ['default project mode refusal', 'internal/config/project_mode.go', 'mode %q has no default project; want home or work', 'has no default project; want home or work'],
  ['default project access-profile refusal', 'internal/config/project_mode.go', 'is an access profile and cannot be a default project', 'is an access profile and cannot be a default project'],
  ['default project mode mismatch', 'internal/config/project_mode.go', 'is %s-only and cannot be the default for %s', '-only and cannot be the default for'],
  ['a chat template stores preset_for', 'internal/config/models.go', 'PresetFor []ProjectMode `json:"preset_for,omitempty"`', 'preset_for'],
  ['project update: an absent mode is no change', 'internal/project/apply.go', 'Mode             *config.ProjectMode      `json:"mode,omitempty"`', 'const proj = { ...(projects.get(id) || {}), ...parsed, id };'],
  ['project update: absent allowed_models are no change', 'internal/project/apply.go', 'AllowedModels    *[]string                `json:"allowed_models,omitempty"`', 'const proj = { ...(projects.get(id) || {}), ...parsed, id };'],
  ['audit query route is read class', 'cmd/relay/audit_routes.go', 'rr.Handle(control.ClassRead, "GET /api/audit", func', "p === '/api/audit' && req.method === 'GET'"],
  ['audit log route is read class', 'cmd/relay/audit_routes.go', 'rr.Handle(control.ClassRead, "GET /api/audit/log", func', "p === '/api/audit/log' && req.method === 'GET'"],
  ['audit limit refusal', 'cmd/relay/audit_routes.go', 'fmt.Errorf("limit: %q is not an integer", v)', 'is not an integer'],
  ['audit deep refusal', 'cmd/relay/audit_routes.go', 'fmt.Errorf("deep: %q is not a boolean", v)', 'is not a boolean'],
  ['audit log while off is a 400', 'internal/audit/ops.go', 'invalidAudit("auditing is disabled")', "error: 'auditing is disabled'"],
  ['audit query while off is empty', 'internal/audit/ops.go', 'return []AuditEvent{}, nil', 'if (!auditEnabled) return send(200, [])'],
  ['audit event project key', 'internal/audit/audit.go', 'json:"project_id,omitempty"', 'project_id'],
  ['audit event tool key', 'internal/audit/audit.go', 'json:"tool,omitempty"', 'tool'],
  ['audit denied outcome', 'internal/audit/audit.go', 'AuditOutcomeDenied       = "denied"', 'AuditOutcomeDenied'],
  ['eve may read the audit routes', 'cmd/relay/api_credential.go', 'var frontendConsumerClasses = []control.CapabilityClass{control.ClassRead,', 'GET /api/audit'],
  ['scheduler down is a text/plain 502', 'cmd/relay/enhanced_services.go', 'http.Error(w, "bad gateway", http.StatusBadGateway)', "sendText(502, 'bad gateway')"],
  ['lastRun is the finish time', 'store.go', 't.LastRun = time.Now().UTC()', 'task.lastRun = exec.completedAt', 'scheduler'],
  ['a finished run sets lastRun', 'scheduler.go', 's.store.SetLastRun(task.ID, exec.Status)', 'task.lastRun = exec.completedAt', 'scheduler'],
  ['task not found', 'api.go', 'writeError(w, http.StatusNotFound, "task not found")', "error: 'task not found'", 'scheduler'],
  ['run started body', 'api.go', '"message": "Task execution started",', "message: 'Task execution started'", 'scheduler'],
  ['delete body', 'api.go', 'map[string]bool{"deleted": true}', "{ deleted: true }", 'scheduler'],
  ['by-project body', 'api.go', 'map[string]int{"deleted": count}', "{ deleted: count }", 'scheduler'],
  ['task name required', 'api.go', 'errors.New("name is required")', "'name is required'", 'scheduler'],
  ['chat prompt required', 'api.go', 'errors.New("prompt is required for chat tasks")', "'prompt is required for chat tasks'", 'scheduler'],
  ['pty template required', 'api.go', 'errors.New("templateId is required for PTY tasks")', "'templateId is required for PTY tasks'", 'scheduler'],
  ['schedule refusal prefix', 'api.go', 'fmt.Errorf("invalid schedule: %w", err)', 'invalid schedule:', 'scheduler'],
  ['once in the past', 'schedule.go', "once schedule 'at' is in the past", "once schedule 'at' is in the past", 'scheduler'],
  ['task view on the wire', 'task.go', 'View TaskView `json:"view"`', 'view: viewOf(t)', 'scheduler'],
  ['lifecycle envelope', 'scheduler.go', '"taskName":  task.Name,', 'taskName: task.name', 'scheduler'],
  ['task_started event', 'scheduler.go', '"task_started"', "'task_started'", 'scheduler'],
  ['task_completed event', 'scheduler.go', '"task_completed"', "'task_completed'", 'scheduler'],
  ['task_error event', 'scheduler.go', '"task_error"', "'task_error'", 'scheduler'],
  ['task_status on connect', 'hub.go', '"type":    "task_status",', "type: 'task_status'", 'scheduler'],
  ['a task stores useRelayTools (PUT replaces it)', 'task.go', 'json:"useRelayTools,omitempty"', 'const updated = { ...parsed, ...keep, id, createdAt: task.createdAt, updatedAt: ts() };', 'scheduler'],
  ['a run passes useRelayTools in the session settings', 'client.go', 'settings["useRelayTools"] = true', 'task.useRelayTools ? { headless: true, useRelayTools: true } : { headless: true }', 'scheduler'],
  // relayScheduler#10: a PTY task's outputFile, captured as the run's output on success.
  ['a task stores outputFile', 'task.go', 'json:"outputFile,omitempty"', 'task.outputFile', 'scheduler'],
  ['a successful run records output', 'task.go', 'json:"output,omitempty"', 'exec.output = output', 'scheduler'],
  ['outputFile on a chat task', 'api.go', 'errors.New("outputFile is only for PTY tasks")', "'outputFile is only for PTY tasks'", 'scheduler'],
  ['outputFile that is a path', 'api.go', 'errors.New("outputFile must be a file name, not a path")', "'outputFile must be a file name, not a path'", 'scheduler'],
  ['outputFile with a directory', 'api.go', 'errors.New("outputFile needs the task to run in its project directory; remove directory")', "'outputFile needs the task to run in its project directory; remove directory'", 'scheduler'],
  ['a chat tool_result carries scope_violation', 'internal/sessions/events/events.go', 'json:"scope_violation,omitempty"', 'is_error and scope_violation (relay events.go)'],
  ['a chat tool_result takes is_error from the MCP result', 'internal/sessions/provider/chat_base.go', 'isError = toolErr != nil || callRes.IsError', 'is_error and scope_violation (relay events.go)'],
  ['a chat session reads settings.useRelayTools', 'internal/sessions/provider/settings.go', 'Key:     "useRelayTools",', 'useRelayTools: true }'],
  // eve#196: Drop in. Pinned to relay#239 (session_dropin.go, session/dropin.go).
  ['drop-in route', 'cmd/relay/session_routes.go', '"POST /api/sessions/{id}/drop-in"', "/drop-in$/"],
  ['Claude is haiku, sonnet or opus (eve decides Drop in from the model)', 'cmd/relay/session_routes.go', 'case "haiku", "sonnet", "opus":', "CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']", 'relay', '../public/agent-board.js'],
  ['drop-in is a 201 with the response body', 'cmd/relay/session_dropin.go', 'writeJSON(w, http.StatusCreated, dropInResponseBody{', "send(201, { sessionId: id, claudeSessionId"],
  ['drop-in body has claudeSessionId', 'cmd/relay/session_dropin.go', 'json:"claudeSessionId"', "claudeSessionId: '00000000-0000-4000-8000-000000000196', terminal })"],
  ['drop-in body has host only when set', 'cmd/relay/session_dropin.go', 'json:"host,omitempty"', "{ sessionId: id, claudeSessionId: '00000000-0000-4000-8000-000000000196', terminal }"],
  ['the 201 body is built from sessionId, claudeSessionId, host and terminal', 'cmd/relay/session_dropin.go', 'SessionID: res.SessionID, ClaudeSessionID: res.ClaudeSessionID, Host: res.Host, Terminal: terminal,', "send(201, { sessionId: id, claudeSessionId"],
  ['drop-in body has terminal', 'cmd/relay/session_dropin.go', 'json:"terminal"', 'directory: sess.directory || \'\', host: null'],
  ['a drop-in refusal is {error, message}', 'cmd/relay/session_dropin.go', 'map[string]string{"error": refusal.Code, "message": refusal.Message}', "{ error: 'session_not_found', message:"],
  ['drop-in of an unknown session', 'cmd/relay/session_dropin.go', 'fmt.Sprintf("no session %s", req.SessionID)', 'message: `no session ${id}`'],
  ['drop-in of a non-Claude session', 'cmd/relay/session_dropin.go', 'only Claude sessions can be taken over; this is a %s session', 'only Claude sessions can be taken over; this is a ${kind} session'],
  ['the drop-in terminal name', 'cmd/relay/session_dropin.go', 'name + " (drop-in)"', '`${sess.name || \'session\'} (drop-in)`'],
  ['the drop-in terminal template', 'cmd/relay/session_dropin.go', 'const dropInTemplateID = "claude-code"', "templateId: 'claude-code'"],
  ['drop-in of a non-headless session', 'internal/sessions/session/dropin.go', 'this session is not headless; continue it in eve', 'this session is not headless; continue it in eve'],
  ['drop-in of a held session', 'internal/sessions/session/dropin.go', 'a terminal already has this session; close it first', 'a terminal already has this session; close it first'],
  ['drop-in while a tool runs', 'internal/sessions/session/dropin.go', 'a tool is running (%s); wait for it to finish or stop the turn, then try again', 'a tool is running (Bash); wait for it to finish or stop the turn, then try again', 'relay', 'e2e/goals/agent-drop-in.spec.js'],
  ['closing a terminal tab closes the terminal', 'internal/sessions/api/ws_terminal.go', 'th.mgr.Close(req.TerminalID)', "type === 'terminal_close'"],
  ['closing the drop-in terminal hands the session back', 'internal/sessions/hostapi/server.go', 's.sessions.HandBack(', "sessionState({ sessionId: heldId, state: 'idle'"],
  ['a drop-in moves the session to running', 'internal/sessions/attention/attention.go', 'case DroppedIn:\n\t\treturn Running', "sessionState({ sessionId: id, state: 'running'"],
  ['the session list row carries headless only when true', 'internal/sessions/session/manager.go', 'Headless bool `json:"headless,omitempty"`', 'if (sess.headless) out.headless = true;'],
  // relay#234: the Chief of Staff scope, marked send and listed rule (eve#197).
  ['the scope header', 'cmd/relay/api_credential.go', 'scopeHeader       = "X-Relay-Scope"', "'x-relay-scope'"],
  ['the scope value', 'cmd/relay/api_credential.go', 'chiefOfStaffScope = "chief-of-staff"', "COS_SCOPE = 'chief-of-staff'"],
  ['a scoped request reaches two proxy doors', 'cmd/relay/api_credential.go', 'var chiefOfStaffProxyReach = []string{"GET /api/sessions", "GET /ws"}', "SCOPED_REACH = ['GET /api/sessions', 'GET /ws', 'POST /api/chief-of-staff/messages']"],
  ['the scoped send route', 'cmd/relay/session_routes.go', '"POST /api/chief-of-staff/messages"', "p === '/api/chief-of-staff/messages' && req.method === 'POST'"],
  ['the scoped /ws is read-only', 'cmd/relay/frontend_dispatcher.go', '"chief-of-staff scope is read-only"', "ws.close(1008, 'chief-of-staff scope is read-only')"],
  ['a body over 64 KiB', 'cmd/relay/session_chief_of_staff.go', 'http.StatusRequestEntityTooLarge, "body_too_large", "request body is larger than 64 KiB"', "coded(413, 'body_too_large', 'request body is larger than 64 KiB')"],
  ['a whitespace text', 'cmd/relay/session_chief_of_staff.go', 'http.StatusBadRequest, "text_required", "text is required"', "coded(400, 'text_required', 'text is required')"],
  ['a dropped-in session refuses the send', 'cmd/relay/session_chief_of_staff.go', 'http.StatusConflict, hostapi.ErrDroppedIn, "a terminal holds this session; close it first"', "failChiefOfStaffSend(409, 'dropped_in', 'a terminal holds this session; close it first')", 'relay', 'integration/relay-fidelity.test.js'],
  ['the dropped_in wire code', 'internal/sessions/hostapi/types.go', 'ErrDroppedIn         = "dropped_in"', "error: 'dropped_in'", 'relay', 'unit/chief-of-staff.test.js'],
  ['audit off refuses the send', 'cmd/relay/session_chief_of_staff.go', 'http.StatusServiceUnavailable, "audit_unavailable", "auditing is off; the Chief of Staff cannot send"', "coded(503, 'audit_unavailable', 'auditing is off; the Chief of Staff cannot send')"],
  ['the 202 body carries the origin', 'cmd/relay/session_chief_of_staff.go', 'json:"origin"', "origin: 'chief-of-staff', at"],
  ['the origin constant', 'internal/sessions/types/provider.go', 'OriginChiefOfStaff = "chief-of-staff"', "origin: 'chief-of-staff'"],
  ['the live user_message frame carries the origin', 'internal/sessions/session/manager.go', 'frame["origin"] = origin', "type: 'user_message', sessionId, text, ...(origin"],
  ['a rejoined history row carries the origin', 'internal/sessions/api/ws_session.go', 'history = session.MarkOrigins(h, messages)', 'historyUser'],
  ['a list row carries headless only when true', 'internal/sessions/session/manager.go', 'Headless bool `json:"headless,omitempty"`', 'if (sess.headless === true) out.headless = true;'],
  ['a headless non-agent session is unlisted', 'internal/sessions/session/manager.go', 'return !sess.Headless || sess.Agent', 'unlistedIds'],
  ['the turn_done frame type', 'internal/sessions/events/ws_messages.go', 'WSMsgTurnDone             = "turn_done"', "type: 'turn_done'"],
  ['the turn_done frame carries the excerpt', 'internal/sessions/api/ws_session.go', '"excerpt":   d.Excerpt,', 'excerpt = '],
  ['the session_ended frame type', 'internal/sessions/events/ws_messages.go', 'WSMsgSessionEnded         = "session_ended"', "'session_ended'"],
  ['system/init lists tools', 'internal/sessions/events/events.go', 'Tools      []string `json:"tools"`', "subtype: 'init', model, tools"],
  ['deniedTools reach claude as --disallowedTools', 'internal/sessions/provider/claude.go', '"--disallowedTools"', '--disallowedTools'],
  ['the preflight denies a denied tool', 'internal/sessions/permission/preflight.go', '"denied by project policy"', 'denied by project policy'],
  ['a project policy replaces the client policy', 'cmd/relay/session_launch.go', 'fields["permissionPolicy"] = policyJSON', 'project && project.permissionPolicy'],
  // eve#238: the scoped start route and the tool_use stream the provenance check reads.
  ['the scoped start route', 'cmd/relay/session_routes.go', 'rr.Handle(control.ClassChiefOfStaff, "POST /api/chief-of-staff/sessions"', "p === '/api/chief-of-staff/sessions' && req.method === 'POST'"],
  ['the start door is in the scope reach', 'cmd/relay/session_routes.go', '"POST /api/chief-of-staff/sessions"', "const SCOPED_START = 'POST /api/chief-of-staff/sessions'"],
  ['a start without a project', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadRequest, "project_id_required", "projectId is required"', "coded(400, 'project_id_required', 'projectId is required')"],
  ['a start without a prompt', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadRequest, "prompt_required", "prompt is required"', "coded(400, 'prompt_required', 'prompt is required')"],
  ['a prompt over 8000', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadRequest, "prompt_too_long", "prompt is longer than 8000 characters"', "coded(400, 'prompt_too_long', 'prompt is longer than 8000 characters')"],
  ['a start without a model', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadRequest, "model_required", "model is required"', "coded(400, 'model_required', 'model is required')"],
  ['a mode outside headless and terminal', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadRequest, "mode_invalid", `mode must be "headless" or "terminal"`', "coded(400, 'mode_invalid', 'mode must be \"headless\" or \"terminal\"')"],
  ['an absolute or .. folder', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadRequest, "folder_invalid", "folder must be a relative path with no .. segment"', "coded(400, 'folder_invalid', 'folder must be a relative path with no .. segment')"],
  ['audit off refuses the start', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusServiceUnavailable, "audit_unavailable", "auditing is off; the Chief of Staff cannot start a session"', "coded(503, 'audit_unavailable', 'auditing is off; the Chief of Staff cannot start a session')"],
  ['a start in an unavailable project', 'cmd/relay/session_chief_of_staff_start.go', 'deny(http.StatusForbidden, "project_not_available", "project is not available for a session launch")', "coded(403, 'project_not_available', 'project is not available for a session launch')"],
  ['a start in a host project', 'cmd/relay/session_chief_of_staff_start.go', 'deny(http.StatusForbidden, "project_on_host", "the Chief of Staff cannot start a session in a project on an SSH host")', "coded(403, 'project_on_host', 'the Chief of Staff cannot start a session in a project on an SSH host')"],
  ['a folder that is not there', 'cmd/relay/session_chief_of_staff_start.go', '"folder_not_found", "folder does not exist in the project"', "coded(400, 'folder_not_found', 'folder does not exist in the project')"],
  ['a terminal start needs Claude', 'cmd/relay/session_chief_of_staff_start.go', 'deny(http.StatusBadRequest, "terminal_needs_claude", "a terminal start needs a Claude model")', "coded(400, 'terminal_needs_claude', 'a terminal start needs a Claude model')"],
  ['an undelivered prompt is a 502', 'cmd/relay/session_chief_of_staff_start.go', 'http.StatusBadGateway, "prompt_not_delivered", message', "failChiefOfStaffStart(502, 'prompt_not_delivered', 'the session started but the prompt could not be delivered; it was ended')", 'relay', 'integration/relay-fidelity.test.js'],
  ['a headless start is a headless agent', 'cmd/relay/session_chief_of_staff_start.go', 'req.ClientSettings = json.RawMessage(`{"headless":true,"agent":true}`)', "headless: true, agent: true, origin: 'chief-of-staff'"],
  ['a terminal start runs the claude-code template', 'cmd/relay/session_chief_of_staff_start.go', 'req.TemplateID = "claude-code"', "templateId: 'claude-code', name, directory, host: null, origin: 'chief-of-staff'"],
  ['the session name is cut at 60', 'cmd/relay/session_chief_of_staff_start.go', 'maxChiefOfStaffNameRunes   = 60', ".slice(0, 60)"],
  ['the default session name', 'cmd/relay/session_chief_of_staff_start.go', 'defaultChiefOfStaffName    = "Chief of Staff agent"', "'Chief of Staff agent'"],
  ['the 201 body carries kind', 'cmd/relay/session_chief_of_staff_start.go', 'json:"kind"', "kind: mode === 'headless' ? (claude ? 'claude' : 'chat') : 'pty'"],
  ['a list row carries the origin', 'internal/sessions/session/manager.go', 'Origin string `json:"origin,omitempty"`', 'if (sess.origin) out.origin = sess.origin'],
  ['a terminal list row carries the origin', 'internal/sessions/terminal/manager.go', 'Origin     string            `json:"origin,omitempty"`', "...(t.origin ? { origin: t.origin } : {})"],
  ['the terminal list is {terminals}', 'internal/sessions/api/http_terminal.go', '"terminals": mgr.ListSummary()', 'send(200, { terminals: [...terminals.values()]'],
  ['a tool_use block stop carries the resolved input', 'internal/sessions/events/events.go', 'json:"content_block_stop"', "content_block_stop: true, content_block: { type: 'tool_use'"],
  // S4-A1: the search-result shapes test/unit/sources.test.js builds (6th field: the file carrying the copy).
  ['an MCP result joins its text blocks with no separator', 'internal/sessions/mcp/mcp.go', 'sb.WriteString(v.Text)', "brave(R1) + brave(R2)", 'relay', 'unit/sources.test.js'],
  ['a chat tool result is cut at 8,192 bytes', 'internal/sessions/provider/chat_base.go', 'const maxToolResultLen = 8192', 'const MAX = 8192;', 'relay', 'unit/sources.test.js'],
  ['the cut ends with the truncation marker', 'internal/sessions/provider/chat_base.go', 'toolResult[:maxToolResultLen] + "\\n...(truncated)"', ".subarray(0, MAX).toString() + '\\n...(truncated)'", 'relay', 'unit/sources.test.js'],
];
const carrier = (p) => (p[5] ? fs.readFileSync(path.join(__dirname, '..', p[5]), 'utf8') : FAKE);

describe('fake relay carries what the pins say (no relay checkout needed)', () => {
  it.each(PINS.map((p) => [p[0], p[3], carrier(p)]))('%s', (_what, fakeNeedle, text) => {
    expect(text).toContain(fakeNeedle);
  });
});

const ROOTS = { relay: [relayRoot(), 'relay', '../relay', 'EVE_RELAY_SOURCE'], scheduler: [schedulerRoot(), 'relayScheduler', '../relayScheduler', 'EVE_SCHEDULER_SOURCE'] };
for (const [source, [root, label, where, env]] of Object.entries(ROOTS)) {
  const pins = PINS.filter((p) => (p[4] || 'relay') === source);
  if (!root) {
    test.todo(`${label} checkout not found at ${where} (set ${env}): ${label}-side pins not verified`);
    continue;
  }
  describe(`${label} source still says what the fake copies (${root})`, () => {
    it.each(pins.map((p) => [p[0], p[1], p[2]]))('%s', (_what, file, needle) => {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain(needle);
    });
  });
}
