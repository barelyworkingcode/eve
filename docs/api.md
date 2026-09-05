# API Reference

Eve exposes HTTP endpoints and a single WebSocket interface. Eve owns local concerns (auth, file ops, file watch, search, modules, TTS/STT); everything LLM-related is forwarded over relay's frontend socket — relay serves project/MCP routes itself, reverse-proxies sessions/models to relayLLM, and dispatches tasks to relayScheduler.

This file is a quick reference. The authoritative field lists live in `routes/index.js`, `routes/auth.js`, `routes/modules.js` (HTTP), and `ws-handler.js` (auth/dispatch) + `ws/*.js` (per-domain message descriptors) / `public/message-dispatcher.js` (WS) — check there when a field here looks stale.

## Authentication

Two ways a request is authorized (`requireAuth` in `routes/index.js`; WS in `ws-handler.js`):

- **Session token** — `X-Session-Token: <token>` header (HTTP) or a first `{type:'auth', token}` frame (WS). Obtained from the WebAuthn enroll/login flow below.
- **Bypass** — caller is on a trusted subnet (raw `req.socket.remoteAddress` only; never `Host`/`X-Forwarded-For`), `EVE_NO_AUTH=1` is set, or no passkey is enrolled yet (first-run bootstrap).

`/api/auth/*` never requires a token. An invalid WS auth frame closes the socket with code `4001`.

Full security model and trust boundaries: [docs/authentication.md](authentication.md) and README "Security Model".

## HTTP Endpoints

### Auth (local)

WebAuthn enrollment/login, rate-limited per IP (429 on excess).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/status` | Enrollment/auth state. Returns `trusted: true` for trusted-subnet callers (UI then skips the passkey). |
| POST | `/api/auth/enroll/start` | Begin enrollment. Returns `{ options, challengeId }`. 400 if already enrolled. |
| POST | `/api/auth/enroll/finish` | Body `{ response, challengeId }`. Returns `{ token }`. |
| POST | `/api/auth/login/start` | Begin login. Returns `{ options, challengeId }`. 400 if not enrolled. |
| POST | `/api/auth/login/finish` | Body `{ response, challengeId }`. Returns `{ token }`. |
| GET | `/api/auth/safari-login` | Standalone passkey page for the iOS app (WKWebView can't run WebAuthn). Returns the token via `relayclient://auth-callback?token=...`. |

### LLM / sessions / models (relay → relayLLM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List models. |
| GET | `/api/sessions` | List sessions. `__module:` / `__search:` ephemeral sessions are filtered out. |

Session create/message/delete happen over WebSocket, not HTTP.

### Projects & MCPs (relay-served)

Projects are returned camelCase-normalized and cached for file-handler path resolution.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects; refreshes Eve's project cache. |
| GET | `/api/projects/:id` | Get one project. |
| POST | `/api/projects` | Create. |
| PUT | `/api/projects/:id` | Update. |
| DELETE | `/api/projects/:id` | Delete (sessions become ungrouped, not deleted). |
| GET | `/api/mcps` | List MCPs (populates the project dialog's allowed-MCPs picker). |

### SSH hosts (relay-served; see [ssh-hosts.md](../../relay/docs/ssh-hosts.md))

A project either lives on the console (as today) or on one SSH host (`project.hostId`, `project.host: {id, name, status} | null`). `ssh_argv` — the ready-to-exec ssh prefix relay derives — is never sent to the browser; every response below has it stripped even though relay's own `hostView` carries it.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hosts` | List hosts; refreshes Eve's host cache. |
| POST | `/api/hosts` | Create `{name, target, port?, identity_file?}`; relay probes synchronously. |
| PUT | `/api/hosts/:id` | Update; relay re-probes if `target`/`port`/`identity_file` changed. |
| DELETE | `/api/hosts/:id` | Delete; 409 `{error, projects:[names]}` if a project still references it. Also disconnects Eve's own file-agent connection for that host, if any. |
| POST | `/api/hosts/:id/probe` | Re-probe (checks for `node`/`claude` on the host); 30 s cap. |
| POST | `/api/hosts/:id/disconnect` | `ssh -O exit` on relay's side, and tears down Eve's HostAgent for it. |

### Tasks (relay → relayScheduler)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (optional `?projectId=`). |
| POST | `/api/tasks` | Create a task. |
| GET | `/api/tasks/:taskId` | Get a task. |
| PUT | `/api/tasks/:taskId` | Update a task. |
| DELETE | `/api/tasks/:taskId` | Delete a task. |
| DELETE | `/api/tasks/by-project/:projectId` | Delete all tasks for a project. |
| GET | `/api/tasks/:taskId/history` | Execution history. |
| POST | `/api/tasks/:taskId/run` | Run a task now. |

### Terminals (relay → relayLLM)

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/terminal/templates` | List / create terminal templates. |
| PUT/DELETE | `/api/terminal/templates/:id` | Update / delete a template. |
| GET | `/api/terminals/:id/log` | Raw PTY byte stream for a completed task (binary, `no-store`). |

### TTS / STT (local)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tts/voices` | Available voices (5-min cache; serves stale on error). |
| GET | `/api/stt/status` | `{ available }`. |
| POST | `/api/transcribe` | Body `{ audio, language? }` → `{ text, language }`. |

### Files & images (local serving)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:projectId/*` | Serve a project file. Path-traversal checked; `nosniff` + locked-down CSP on every file; HTML/SVG/XML are sandboxed and forced to download (`?preview=1` renders HTML inline in a sandboxed opaque origin). On a host project this streams through the SSH host agent's `stream` op in 64 KiB chunks (chunked transfer, no `Content-Length`) instead of `res.sendFile`; same CSP/disposition rules by extension. |
| GET | `/api/generated/:filename` | Generated image (binary, proxied from relayLLM, immutable cache). |
| GET | `/api/modules` · `/api/modules/:projectId/:moduleName` · `/api/modules/serve/.../*` | Module list, manifest, static asset serving. AI invocation is WS-only. See [docs/modules.md](modules.md). |

## WebSocket

Connect to `ws://<host>:<port>`. When auth is required, send `{type:'auth', token}` first; all other frames are blocked until it succeeds. High-frequency server frames are coalesced into a `__batch {msgs:[...]}` envelope the client unwraps and dispatches in order.

**Reconnects re-subscribe from scratch.** A browser reconnect builds a whole new chain — new browser socket, new `RelayClient`, new upstream socket to relay — so relayLLM's per-connection subscription state starts empty. The upstream leg alone can also drop and reconnect without the browser socket ever closing — relay's own pong timeout, or relayLLM restarting behind it — and lands in the same empty state; `relay-client.js` retries it with capped backoff and tells the browser with `relay_status {connected}`. Either path — a fresh `RelayClient` or a `relay_status:true` on the existing one — must re-join anything the old upstream connection had joined: `join_session` per open session tab, `terminal_reconnect` per live terminal (`public/app.js#resubscribeAfterReconnect`, called from both `onWebSocketReady` and the `relay_status` handler). Terminals are the sharp edge, because `terminal_input` is routed to the PTY by id from any connection while `terminal_output` goes only to registered viewers — skip the re-join and the pane silently becomes write-only. See [learned.md](learned.md).

### Client → Server

Connection: `ping` (app-level heartbeat, answered before auth and rate-limiting — see `public/ws-client.js` `_heartbeat()`).

Sessions: `create_session` (`{directory?, projectId?, name?, model?, settings?, systemPrompt?, appendClaudeMd?, sessionType?, voice?}` — `sessionType`/`voice` are echoed back unvalidated on `session_created`, used client-side to mark a voice-mode session), `join_session`, `leave_session`, `end_session`, `delete_session`, `rename_session`, `set_session_folder`, `user_input` (`{text, files?, sessionId?, dictated?}`), `stop_generation`, `permission_response` (`{permissionId, approved, reason?}`), `set_permission_mode` (`{sessionId, mode}`).

Files: `list_directory`, `read_file`, `write_file`, `rename_file`, `move_file`, `delete_file`, `upload_file`, `create_directory`, `watch_file`, `unwatch_file`, `read_plan_file`.

Search: `search_project`, `search_cancel`, `search_ai_summarize`, `search_ai_stop`.

Terminals (proxied to relayLLM): `terminal_create` (`{templateId?, name?, directory, projectId?, cols?, rows?}`), `terminal_input`, `terminal_resize`, `terminal_close`, `terminal_list`, `terminal_reconnect`, `join_terminal`, `leave_terminal`, `terminal_templates`.

Modules: `module_read_file`, `module_write_file`, `module_invoke_ai`, `module_ai_stop`. See [docs/modules.md](modules.md).

Voice/TTS/STT: `voice_mode` (`{enabled, voice?, speed?}`), `tts_speak`, `tts_speak_cancel`, `transcribe_audio`.

Diagnostics: `device_log` (`{lines: [...]}` — appended to a server-side log with timestamp and source IP; no reply frame).

### Server → Client

Connection: `pong` (reply to `ping`).

Sessions: `session_created`, `session_joined`, `session_renamed`, `session_folder_changed`, `session_ended`, `user_message`, `llm_event`, `message_complete`, `stats_update`, `raw_output`, `stderr`, `system_message`, `warning`, `error`, `process_exited`, `clear_messages`, `mode_changed`, `permission_request`, `terminal_request` (`{sessionId, directory, command}` — from local slash commands), `plan_file_content`.

Files: `directory_listing`, `file_content`, `file_saved`, `file_renamed`, `file_moved`, `file_deleted`, `file_uploaded`, `directory_created`, `file_error`, `file_changed`, `dir_changed`.

Search: `search_results`, `search_error`, `search_ai_started`, `search_ai_event`, `search_ai_completed`, `search_ai_failed`.

Terminals: `terminal_created` (`{terminalId, templateId, name, directory}`), `terminal_joined`, `terminal_output`, `terminal_exit`, `terminal_closed`, `terminal_list`, `terminal_templates`.

Modules: `module_file_response`, `module_ai_started`, `module_ai_event`, `module_ai_completed`, `module_ai_failed`.

Tasks (forwarded from relayScheduler): `task_started`, `task_completed`, `task_error`, `task_status`.

Voice/TTS/STT: `tts_done`, `tts_error`, `transcription_result`, `transcription_error`.

UI: `ui_command` (LLM-initiated tab control via the eve-control MCP), `auth_success`, `auth_failed`, `relay_status` (`{connected}` — the upstream relayLLM leg, not the browser↔eve link `#connectionStatus` already tracks; see reconnect semantics above).

SSH hosts: `host_status` (`{hostId, name, status:'connecting'|'connected'|'unreachable', error?}`) — Eve's own SSH-host file-agent connectivity (`ssh-host-pool.js`), distinct from relay's ssh `ControlMaster`/`hostView.status`. Sent on every pool status change, plus once per authenticated connection for every host the pool has already spawned an agent for (not necessarily every host relay knows about). See [ssh-hosts.md](../../relay/docs/ssh-hosts.md).

### Stats object

`stats_update` carries relayLLM's stats struct: `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }`. Canonical definition: relayLLM `provider.go`.

### LLM events

`llm_event.event` is a raw relayLLM frame (assistant text/tool_use/thinking blocks as deltas or full blocks; `result` summary). Eve forwards it unchanged — see relayLLM `docs/event-protocol.md` for the full shape.