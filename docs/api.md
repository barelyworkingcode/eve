# API Reference

Eve exposes HTTP endpoints and a single WebSocket interface. Eve owns local concerns: the page and its static files, auth, TTS/STT, terminal paste and the Chief of Staff. Everything else goes over relay's frontend socket: file operations, file watching and search are relay file routes (`relay-file-client.js`), relay serves project, host and MCP routes itself, reverse-proxies sessions and models to relayLLM, and dispatches tasks to relayScheduler.

This file lists every route and WebSocket frame the browser uses, with its success body and each error body. A frame "with no fields" carries only `type`. The authoritative sources are `server.js` (pages, gates, internal routes), `routes/index.js`, `routes/auth.js` (HTTP), and `ws-handler.js` (auth/dispatch) + `ws/*.js` (client frame descriptors) / `public/message-dispatcher.js` (server frames). Check there when a field here looks stale.

## Authentication

Two ways a request is authorized (`requireAuth` in `routes/index.js`; WS in `ws-handler.js`):

- **Session token** — `X-Session-Token: <token>` header (HTTP) or a first `{type:'auth', token}` frame (WS). Obtained from the WebAuthn enroll/login flow below.
- **Bypass** — caller is on a trusted subnet (raw `req.socket.remoteAddress` only; never `Host`/`X-Forwarded-For`), `EVE_NO_AUTH=1` is set, or no passkey is enrolled yet (first-run bootstrap).

`/api/auth/*` never requires a token. An invalid WS auth frame closes the socket with code `4001`.

Full security model and trust boundaries: [docs/authentication.md](authentication.md) and README "Security Model".

## Pages, gates and shared answers

Every HTTP request and WebSocket upgrade passes these in order, before any route: trace ID, security headers (`nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, HSTS on TLS), the pre-enrolment gate, the bare-IP guard. Then compression (HTML, CSS, JS and SVG only), pages and static files, the JSON body parser (50 MB limit), and the routes below.

**Pre-enrolment gate.** With no passkey enrolled (and `EVE_NO_AUTH` not set), a request or upgrade from an address that may not bootstrap answers `404` with `Content-Type: text/plain`, `Cache-Control: no-store` and the body `Not found`. A public address never bootstraps, even with `EVE_ALLOW_ENROLLMENT=1`. Any other address bootstraps if it is inside the trusted range (loopback and the machine's own subnets, or `EVE_TRUSTED_SUBNETS` when set, even with `EVE_DISABLE_SUBNET_BYPASS=1`) or `EVE_ALLOW_ENROLLMENT=1` is set. Once a passkey exists the gate is off.

**Bare-IP guard.** With `EVE_PUBLIC_ORIGIN` set, a request whose `Host` is a non-loopback IP address answers `421` with an HTML page titled "Use the hostname" that links to the configured origin. It runs after the gate, so a blocked remote address sees the `404` instead. WebSocket upgrades are guarded by their `Origin` check instead (see WebSocket, Connection).

**Shared answers.**

| Status | Body | When |
|--------|------|------|
| 401 | `{"error":"Unauthorized"}` | A route that requires auth gets no valid `X-Session-Token` (see Authentication). |
| 502 | `{"error":"Service unavailable"}` | A route that calls relay cannot reach it. Otherwise relay's status and body pass through unchanged. An empty relay body is answered as `{}` on the project, host and persistent-session routes. |
| 400 / 413 | Express's default HTML error page | A malformed JSON body, or a body over the limit. No JSON error handler is registered. |

### Pages and static files

None of these needs a token; the page loads signed out and authenticates over the WebSocket.

| Method | Path | Answer |
|--------|------|--------|
| GET | `/`, `/index.html` | 200 `text/html`, the app shell. `Cache-Control: no-store`, and a strict `Content-Security-Policy` unless `EVE_DISABLE_CSP=1`. Script and stylesheet URLs carry `?rnd=<token>`, new on each server start. `public/index.html` is read once at startup, so an edit needs a restart. |
| GET | `/<slug>/` | Any single path segment with an optional trailing slash (a project URL such as `/acme/`): the same page as `/`, with the same headers. It is registered after the static mounts and the `/internal/*` routes, so `/api/*` and any path with two or more segments never match. A single segment no static file matches gets the page with 200, not a 404. |
| GET | `/*` (static) | `public/` is served at `/`. These mounts serve library files from `node_modules`: `/monaco`, `/xterm`, `/xterm-addon-fit`, `/xterm-addon-web-links`, `/xterm-addon-clipboard`, `/marked`, `/dompurify`, `/mermaid`, `/vad-onnx`, `/vad-web`, `/three`. A file that exists answers 200 with its type. A missing file in a multi-segment path answers Express's HTML 404 (`Cannot GET <path>`). |

## HTTP Endpoints

### Auth (local)

WebAuthn enrollment/login. The four POST routes are rate-limited per client address: 10 attempts per 15 minutes, then `429 {"error":"Too many attempts. Try again later."}` before anything else is checked. Checks run in this order: rate limit, enrollment state, body shape, then the ceremony. A failed ceremony answers 400 or 500 with `{"error": <message>}`, never a stack.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/status` | Never needs a token, never rate-limited. 200 `{enrolled, authenticated}`. Added when `enrolled && !authenticated`: `enrollmentOpen` (whether relay's second-browser enrolment window is open) and, only when open, `enrollmentExpires`. A trusted-subnet caller, or `EVE_NO_AUTH=1`, gets `{enrolled:false, authenticated:true, trusted:true}`: `enrolled` reads false there whatever the truth, and the UI skips the passkey. See [docs/authentication.md](authentication.md) "Adding another browser". |
| POST | `/api/auth/enroll/start` | Begin enrollment. 200 `{ options, challengeId }`. 429. 403 ``{"error":"Enrollment is not open. Open it from the Relay tray or with `relay eve enrol`."}`` if already enrolled and no enrolment window is open (eve logs the refusal). 500 `{error}` if the options cannot be made. |
| POST | `/api/auth/enroll/finish` | Body `{ response, challengeId }`. 200 `{ token }`. 429. The same 403 as `enroll/start` if enrolled and closed; for an open-window (additional) enrolment, a 403 also means the window was consumed by someone else between `start` and `finish` (nothing is saved either way). 400 `{"error":"Invalid request body"}` if `response` is not an object or `challengeId` is not a string. 400 `{error}` when verification fails (`Challenge expired or invalid`, `Verification failed`) or relay's window check errors. |
| POST | `/api/auth/login/start` | Begin login. 200 `{ options, challengeId }`. 429. 400 `{"error":"Not enrolled"}`. 500 `{error}` (for example `No credentials enrolled`). |
| POST | `/api/auth/login/finish` | Body `{ response, challengeId }`. 200 `{ token }`. 429. 400 `{"error":"Not enrolled"}`. 400 `{"error":"Invalid request body"}` as for `enroll/finish`. 401 `{"error":"This passkey has been revoked."}` if relay reports the asserted credential as pending revocation, checked before the WebAuthn ceremony runs (see [docs/authentication.md](authentication.md) "Revoking a browser"). 400 `{error}` when the ceremony fails (`Challenge expired or invalid`, `Unknown credential`, `Verification failed`). |
| GET | `/api/auth/safari-login` | No token, not rate-limited. 200 `text/html`: a standalone passkey page for the iOS app (WKWebView can't run WebAuthn). On success it navigates to `relayclient://auth-callback?token=...`; on failure it shows the error in the page. |

### LLM / sessions / models (relay → relayLLM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List models. Relay's status and body pass through; 401 and 502 as in Pages, gates and shared answers. |
| GET | `/api/sessions` | List sessions. relay answers `{ sessions: [...] }` (object-wrapped); eve unwraps it and returns a bare, filtered array to the browser: `__search:` ephemeral sessions are filtered out here, not by relay. A non-2xx relay answer, or a body that is neither shape, passes through unchanged; 502 when relay is unreachable. A live Claude or pi row can carry `attention: {state, since}` (same values and time format as `session_state`); the field is absent otherwise, and eve passes it through unchanged. |
| POST | `/api/sessions/:id/drop-in` | Drop in to a headless Claude session. Body `{cols, rows}`, each a whole number from 1 to 500, else `400 {"error":"cols and rows must be whole numbers from 1 to 500"}` and relay is not called. eve forwards to relay (`session.drop_in`) and returns relay's status and body unchanged: `201 {sessionId, claudeSessionId, host?, terminal}` (`terminal` has the shape of `POST /api/terminals`; the browser opens it with `terminal_created` handling plus `join_terminal`), or a refusal `{error, message}` (`message` is shown to the person), with relay's status. 502 `{"error":"Service unavailable"}` if relay is unreachable. No timeout: relay bounds the wait. Closing the terminal is the ordinary `terminal_close`. |
| POST | `/api/sessions/:id/resume` | Not an eve route: it is the relay route eve calls, and no browser sends it. Resume a dormant session. Called automatically by eve, at most once per user turn, when relay answers a `send_message` with the `resume_required` error below, never host-driven (SH-6). |

Session creation is HTTP (`POST /api/sessions`, triggered by the WS `create_session` frame, see below); messages and the rest of the session lifecycle stay on WebSocket.

### Projects & MCPs (relay-served)

Projects are returned camelCase-normalized and cached for file-handler path resolution.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects; refreshes Eve's project cache. 200 a bare array of normalized projects. Any other relay answer passes through; 502 when relay is unreachable. |
| GET | `/api/projects/:id` | Get one project. 200 the normalized project. A relay answer without an `id` (for example its 404 `{error}`) passes through with relay's status; 502. |
| POST | `/api/projects` | Create. The body goes to relay unchanged. Relay's 2xx with an `id` returns the normalized project with relay's status (201). Any other relay answer passes through with its status and body (`{}` if empty), for example a 400 `{error}` for invalid input; 502. |
| PUT | `/api/projects/:id` | Update. The body goes to relay unchanged. 200 the normalized project; any other relay answer passes through with its status and body (`{}` if empty); 502. |
| DELETE | `/api/projects/:id` | Delete (sessions become ungrouped, not deleted). Relay's status and body (`{}` if empty); the project leaves Eve's cache on 2xx. 502. |
| GET | `/api/projects/:id/audit` | The project's Relay tool calls (`call_tool` events, newest 50, from relay's audit). Body `{ recording, records }`; `recording` is false when relay's audit is off. Each record has only `ts`, `tool`, `outcome`, `allowed` (`denied`, `unauthorized` and `throttled` read as not allowed). 404 `{"error":"Project not found"}` for a project not in Eve's cache, 502 `{"error":"Service unavailable"}` when relay is unreachable or answers with an error. |
| GET | `/api/mcps` | List MCPs (populates the project dialog's allowed-MCPs picker). Relay's status and body pass through; 502. |

Chat templates ride inside `chat_templates` on `POST` and `PUT`: `{ id, name, model, mode, voice, system_prompt[, preset_for] }`. `preset_for` lists `home` or `work`, the modes the template is the preset for: a `voice` template is that mode's voice preset, any other its Ask preset. It is a label, never a grant. Eve sends it only when non-empty and reads it back as `presetFor`; relay answers 400 `{ "error" }` for a second Ask or voice preset in one mode. A `PUT` without `chat_templates` leaves it as stored. See [design-mode-presets.md](design-mode-presets.md).

### SSH hosts (relay-served; see [ssh-hosts.md](../../relay/docs/ssh-hosts.md))

A project either lives on the console (as today) or on one SSH host (`project.hostId`, `project.host: {id, name, status} | null`). `ssh_argv` — the ready-to-exec ssh prefix relay derives — is never sent to the browser; every response below has it stripped even though relay's own `hostView` carries it.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hosts` | List hosts; refreshes Eve's host cache. 200 a bare array of host views. Any other relay answer passes through; 502 when relay is unreachable. |
| POST | `/api/hosts` | Create `{name, target, port?, identity_file?}`; relay probes synchronously. Relay's status and host view, `ssh_argv` removed; a relay refusal passes through as `{error}` with its status. 502. |
| PUT | `/api/hosts/:id` | Update; relay re-probes if `target`/`port`/`identity_file` changed. 200 the host view, `ssh_argv` removed; a relay refusal passes through as `{error}` with its status; 502. |
| DELETE | `/api/hosts/:id` | Delete; relay's status and body (`{}` if empty). 409 `{error, projects:[names]}` if a project still references it. Eve only drops the host from its own host cache on 2xx; it holds no connection of its own. 502. |
| POST | `/api/hosts/:id/probe` | Re-probe (checks for `node`/`claude` on the host); 30 s cap. 200 the host view, `ssh_argv` removed; a relay refusal passes through as `{error}` with its status; 502. |
| POST | `/api/hosts/:id/disconnect` | Relay runs `ssh -O exit` for the host. Eve only refreshes its host cache from the returned host view (`ssh_argv` removed); it tears nothing down. Relay's status and body; 502. |

### Tasks (relay → relayScheduler)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (optional `?projectId=`). 200 the task array (`[]` when none), 500 `{error}`. |
| POST | `/api/tasks` | Create a task. Optional `useRelayTools` (bool): a headless run then gets Relay's tools (`settings.useRelayTools`); PTY tasks ignore it. The Morning brief sets it. Optional `outputFile` (a bare file name in the project folder): the routine becomes a Today card. Without a passkey session (`X-Session-Token`), unless `EVE_NO_AUTH=1`, the answer is `403 {"error":"Only a browser signed in with a passkey can set up a Today card."}`. Otherwise 201 the created task; 400 `{error}` (`invalid JSON: ...` or the validation message); 500 `{error}`. |
| GET | `/api/tasks/:taskId` | Get a task. 200 the task; 404 `{"error":"task not found"}`; 500 `{error}`. |
| PUT | `/api/tasks/:taskId` | Update a task. Replaces the whole task, so send `useRelayTools` again or it is lost (the task dialog carries it on save). The same `outputFile` rule as POST. 200 the task; 400 `{error}` as for POST; 404 `{"error":"task not found"}`; 500 `{error}`. |
| DELETE | `/api/tasks/:taskId` | Delete a task. 200 `{"deleted":true}`; 404 `{"error":"task not found"}`; 500 `{error}`. |
| DELETE | `/api/tasks/by-project/:projectId` | Delete all tasks for a project. 200 `{"deleted":<count>}`; 500 `{error}`. |
| GET | `/api/tasks/:taskId/history` | Execution history. 200 the run records (an array); 404 `{"error":"task not found"}`; 500 `{error}`. |
| POST | `/api/tasks/:taskId/run` | Run a task now. 200 `{"success":true,"message":"Task execution started"}`; 409 `{"error":"task is already running"}`; 404 `{"error":"task not found"}`; 500 `{error}`. |

Every task route returns relay's status and body unchanged (relayScheduler's task JSON, or `{error}` on failure) and 502 `{"error":"Service unavailable"}` when relay is unreachable. The only answer Eve adds is the 403 above.

### Terminals (relay → relayLLM)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/terminals` | Not an eve route: it is the relay route eve calls, and no browser sends it. Create a terminal. Triggered by the WS `terminal_create` frame (below), not sent by the browser directly. 201 body is relay's own WS `terminal_created` frame minus `type` (`{terminalId, templateId, name, directory, host}`); non-2xx becomes a WS `error` to the browser. On success eve joins it over WS (`join_terminal`). The old WS `terminal_create`-to-relay path is retired. |
| GET | `/api/terminal/templates?project=<id>` | List the templates a project may use, from relay's settings. Relay's status and body pass through: 200 an array. With no `project`, or an unknown one, the array is empty; a host project gets its host's templates. 502. |
| POST | `/api/terminal/templates` | Create a template; the body goes to relay unchanged. Relay's status and body: 201 the template, 400 `{error}` invalid, 409 `{error}` the id exists. 502. |
| PUT | `/api/terminal/templates/:id` | Update a template. Relay's status and body: 200 the template, 400 or 404 `{error}`. 502. |
| DELETE | `/api/terminal/templates/:id` | Delete a template. Relay's status: 204 with no body, 404 `{error}`. 502. |
| GET | `/api/projects/:id/persistent-sessions` | Host project's persistent (tmux) sessions, proxied from relay: `[{name, template_id, n, created, attached, attached_here}]`. 404 not a host project, 409 host has no tmux, 502 ssh failure (relay's `{error}`), and Eve's own 502 `{"error":"Service unavailable"}` when relay is unreachable. |
| DELETE | `/api/projects/:id/persistent-sessions/:name` | Kill one persistent session. 204 with no body. Any other relay status passes through with its `{error}` (`{}` if empty); 502 `{"error":"Service unavailable"}` when relay is unreachable. |
| GET | `/api/terminals/:id/log` | Raw PTY byte stream of any terminal relay still has a log for, not only a completed task's: the agent board reads a live terminal's last line from it. 200 binary, `Content-Type` from relay (default `application/octet-stream`), `Cache-Control: no-store`. Any relay status other than 200 is returned with that status and `{"error":"Terminal log not found"}`. 502 `{"error":"Terminal log unavailable"}` when relay is unreachable. The id is forwarded without shape checks. |
| POST | `/api/terminal/paste-image?host=` | Raw image body (png/jpeg/gif/webp, ≤10MB) pasted into a terminal pane. Saved owner-only to eve's tmpdir, or to `/tmp` on the SSH host when `host` is set (agent op `pastetmp`); returns 200 `{path}`, which the pane pastes as text. Errors are `{error}`: 415 `Unsupported image type: <type>` (the `Content-Type` must be `image/png`, `image/jpeg`, `image/gif` or `image/webp`), 400 `Empty image`, 413 `Image exceeds 10MB limit`, 404 `Unknown host: <id>`, 502 `Host write failed: <reason>`, 500 `Failed to save image`. A body over 10 MB is stopped by the body parser first and answers Express's HTML 413 page instead. |

### TTS / STT (local)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tts/voices` | Available voices: 200 the array relayTTS lists (5-min cache; a stale cache is served if the daemon errors). 503 `{"error":"TTS service unavailable"}` when it errors and nothing is cached. |
| GET | `/api/stt/status` | 200 `{ available }` (boolean; false when the relaySTT daemon does not answer). |
| POST | `/api/transcribe` | Body `{ audio, language? }` (`audio` base64) gives 200 `{ text, language }`. 400 `{"error":"No audio data provided"}` when `audio` is empty. 503 `{"error":"STT service unavailable"}` for any failure. |

### Files & images (local serving)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:projectId/*` | Serve a project file as bytes. Eve has no local file access: every project, console or SSH host, is read through relay's file stream, which is the source of the image, PDF, video and audio viewers and the HTML preview iframe. Errors are `{error}`: 404 `Project not found` (id not in Eve's project cache), 400 `Path required` (nothing after the project id), 403 `Path traversal not allowed`, and then relay's code for the stream: 404 `File not found`, 403 `Symbolic links are not opened` or `Permission denied`, 400 `Path is a directory` or `Not a directory`, and 503 for anything else with the `file_error` text (for example `Relay is not reachable` or `Host "<name>" is not connected`). A console project answers `Range` with 206 and the requested bytes; a host project always answers 200 with the whole file, chunked and without `Content-Length`. An unsatisfiable range answers 416 with relay's `Content-Range` and no body. `Content-Type` comes from the file extension (unknown: `application/octet-stream`); `Accept-Ranges`, `Content-Length` and `Content-Range` are copied from relay. Every file carries `nosniff` and a locked-down CSP (`default-src 'none'`). HTML, SVG and XML (`.html .htm .xhtml .svg .xml`) are sandboxed and forced to download; `?preview=1` on `.html` or `.htm` renders inline in a sandboxed opaque origin (`Content-Security-Policy: sandbox allow-scripts`) instead. The `v` query (for example `?v=3` or `?preview=1&v=3`) is ignored by the server: the browser adds it to change the URL when a file changes, so viewers and the preview refetch. |
| GET | `/api/generated/:filename` | Generated image: 200 binary, `Content-Type` from relayLLM, `Cache-Control: public, max-age=31536000, immutable`. Any relay status other than 200 is returned with that status and `{"error":"Image not found"}`. 502 `{"error":"Image not available"}` when relay is unreachable. |

### Internal (loopback only)

Not called by the browser. Both need a loopback peer and the header `x-eve-internal: <EVE_INTERNAL_SECRET>`, and both answer a non-loopback peer 403 and a bad secret 401.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/ui-command` | Used by the eve-control MCP to open, refresh or close an image tab. Body `{action, project_id, tab_kind?, tab_ref?, image_url?, title?}`, `action` one of `open_tab` (needs `image_url`; Eve mints the `tab_ref`), `refresh_tab`, `close_tab` (both need `tab_ref`). 200 `{status:'ok'\|'no_client', tab_ref, delivered}` (`delivered` counts the browser connections viewing that project; `no_client` when it is 0). Errors: 403 `{"error":"forbidden"}`, 401 `{"error":"unauthorized"}`, 400 `{"error":"image_url required"}`, `{"error":"tab_ref required"}` or `{"error":"unknown action: <action>"}`. Each delivery is a `ui_command` frame. |
| POST | `/internal/cos` | The `eve-cos` MCP's calls; described under Chief of Staff actions in Server to Client. 403 and 401 here are `{ok:false, error:'forbidden'\|'unauthorized', message}`. |

## WebSocket

Connect to `ws://<host>:<port>`. When auth is required, send `{type:'auth', token}` first; all other frames are blocked until it succeeds. High-frequency server frames are coalesced into a `__batch {msgs:[...]}` envelope the client unwraps and dispatches in order.

**Reconnects re-subscribe from scratch.** A browser reconnect builds a whole new chain — new browser socket, new `RelayClient`, new upstream socket to relay — so relayLLM's per-connection subscription state starts empty. The upstream leg alone can also drop and reconnect without the browser socket ever closing — relay's own pong timeout, or relayLLM restarting behind it — and lands in the same empty state; `relay-client.js` retries it with capped backoff and tells the browser with `relay_status {connected}`. Either path — a fresh `RelayClient` or a `relay_status:true` on the existing one — must re-join anything the old upstream connection had joined: `join_session` per open session tab, `terminal_reconnect` per live terminal (`public/app.js#resubscribeAfterReconnect`, called from both `onWebSocketReady` and the `relay_status` handler). Terminals are the sharp edge, because `terminal_input` is routed to the PTY by id from any connection while `terminal_output` goes only to registered viewers — skip the re-join and the pane silently becomes write-only. See [learned.md](learned.md).

### Connection, auth and limits

**Connect.** Open `ws://<host>:<port>` (`wss://` under TLS) on the same host as the page, on any path: the path is not read. The upgrade is refused before the socket opens: `404` (bare status line, no body) under the pre-enrolment gate, then `403` for a cross-site `Origin`. A request with no `Origin` header (not a browser) is allowed. A loopback `Origin` is allowed. With `EVE_PUBLIC_ORIGIN` set the `Origin` must equal it exactly; otherwise its host must equal the `Host` header. A malformed `Origin` is refused.

**Before auth.** Auth is required when a passkey is enrolled, `EVE_NO_AUTH` is not set and the caller is not on a trusted subnet; otherwise the socket starts authenticated and an `auth` frame is answered `auth_success` at once. When auth is required:

| Frame | Answer |
|-------|--------|
| `auth` `{token}` with a valid session token | `{type:'auth_success'}` (no fields). The socket is then authenticated and receives the latest `host_status` of each host. |
| `auth` with a missing or bad token | `{type:'auth_failed', message:'Invalid or expired token'}`, then the socket closes with code `4001`. |
| `ping` | `{type:'pong'}` (no fields), also before auth. |
| any other frame | `{type:'error', message:'Authentication required'}`. |

**Any state.** A frame that is not valid JSON, or a handler that throws, answers `{type:'error', message:<the error's text>}`. A frame with an unknown `type` is ignored without an answer. Any frame that carries `projectId` also binds the connection to that project, so `ui_command` pushes for the project reach it. If the upstream socket to relay cannot open, Eve sends `{type:'error', message:'Cannot connect to relay service'}`.

**Rate limit.** Seven client types are expensive: `create_session`, `search_project`, `search_ai_summarize`, `transcribe_audio`, `tts_speak`, `git_changes` and `cos_message`. They share one budget per connection: 30 per 10 seconds by default (`EVE_RATELIMIT_MAX`, `EVE_RATELIMIT_WINDOW_MS`). Past it the frame is not run and the answer is `{type:'error', message, requestId}`. `message` is `Rate limit exceeded`, then a space, an em dash (U+2014) and a space, then `too many requests, please slow down.`. `requestId` echoes the request's own `requestId` and is absent when the request had none (as for `create_session`). No other client type is limited.

### Client → Server

Each row lists the fields Eve reads. `projectId` is a relay project id. A reply named in the last column is the frame the browser waits for; a failure is a `file_error`, `search_error`, `git_error` or a plain `error` as noted.

| Frame | Fields | Effect and reply |
|-------|--------|------------------|
| `ping` | no fields | `pong`. App-level heartbeat, answered before auth and rate limiting (`public/ws-client.js` `_heartbeat()`). |
| `auth` | `{token}` | See Connection, auth and limits. |
| `create_session` | `{directory?, projectId?, name?, model?, settings?, systemPrompt?, appendClaudeMd?, sessionType?, voice?}` | Expensive. Eve POSTs relay `/api/sessions`, then sends `session_created` and joins the session. `sessionType`/`voice` are echoed back unvalidated on `session_created`, used client-side to mark a voice-mode session. The browser sets the chat defaults itself in `applyChatDefaults` (`public/core/ui-utils.js`): for a model whose `provider` in `GET /api/models` is anything but `claude`, it sends `settings.useRelayTools: true` and `appendClaudeMd: true`; for Claude, or a model not in the list, it sends neither. The server forwards both to relay, adding the project's `permissionPolicy` beside `useRelayTools` and sending `appendClaudeMd: false` when absent. A relay refusal answers `error {message}` with relay's `error` text (default `Failed to create session`); an unreachable relay answers `error` `Failed to create session: relay unavailable`. |
| `join_session` | `{sessionId}` | Relay answers `session_joined` with the history. |
| `leave_session` | `{sessionId}` | Stops this connection's subscription and turns its voice mode off. No reply. |
| `end_session` | `{sessionId?}` (defaults to the connection's current session) | Relay ends the provider process; `process_exited` follows. The session stays listed. |
| `delete_session` | `{sessionId}` | Relay deletes the session and sends `session_ended` to every connection. |
| `rename_session` | `{sessionId, name}` | Relay answers `session_renamed`. |
| `set_session_folder` | `{sessionId, folder}` | Relay answers `session_folder_changed`. |
| `user_input` | `{text, files?, urls?, sessionId?, dictated?, trace_id?}` | Sends one chat turn. A text starting `/clear`, `/help`, `/zsh`, `/bash`, `/claude` or `/rh` is a local slash command: Eve answers with `system_message`, `message_complete` or `terminal_request` and sends nothing to relay. `urls` are pasted-link chips: eve keeps up to five distinct `http:`/`https:` URLs of at most 2,048 characters that parse, and appends one "Sources to read" block after the typed text, before any file blocks; the browser strips it again on replay. `files` are `{name, type, content, mediaType?}`; image files travel as attachments, any other file is inlined into the text. `trace_id` is kept only if it matches the trace ID pattern (see Trace IDs). |
| `stop_generation` | `{sessionId}` | Relay stops the turn and answers `message_complete`. |
| `permission_response` | `{permissionId, approved, reason?}` | Answers a `permission_request`. No reply. |
| `set_permission_mode` | `{sessionId, mode}` | Relay answers `mode_changed`. |
| `list_directory` | `{projectId, path?, showHidden?}` (`path` defaults to `/`) | `directory_listing`, or `file_error`. Also starts the project's recursive file watcher. |
| `read_file` | `{projectId, path}` | `file_content`, or `file_error` (`File type not allowed for editing` for an extension off the editor allowlist on a console project). |
| `write_file` | `{projectId, path, content}` | `file_saved`, or `file_error`. Content over 10 MB: `Content too large (max 10MB)`. |
| `rename_file` | `{projectId, path, newName}` | `file_renamed`, or `file_error` (`Name cannot contain path separators`). |
| `move_file` | `{projectId, sourcePath, destDirectory}` | `file_moved`, or `file_error` (`Cannot move a directory into itself`). |
| `delete_file` | `{projectId, path}` | `file_deleted`, or `file_error` (`Cannot delete project root`). |
| `upload_file` | `{projectId, destDirectory, fileName, content, encoding?}` (`encoding` `'base64'`, otherwise UTF-8) | `file_uploaded`, or `file_error`. An existing file is refused; over 10 MB: `File too large (max 10MB)`. |
| `create_directory` | `{projectId, path, name}` (`path` is the parent) | `directory_created`, or `file_error`. |
| `watch_file` | `{projectId, path, binary?}` | No reply. Later changes arrive as `file_changed`. `binary` files send the notice without content. |
| `unwatch_file` | `{projectId, path}` | No reply. |
| `read_plan_file` | `{path}` (an absolute `.md` path inside the server user's Claude plans folder) | `plan_file_content`, or `error` `Invalid plan file path`, `Plan file path not allowed` or `Failed to read plan file: <reason>`. |
| `search_project` | `{requestId, projectId, query, options?}` (`options`: `{regex?, word?, caseSensitive?, globs?, maxMatches?}`) | Expensive. `search_results`, or `search_error`. A cancelled search sends nothing. |
| `search_cancel` | `{requestId}` | Cancels a running search. No reply. |
| `search_ai_summarize` | `{requestId, projectId, query, matches, model?}` | Expensive. `search_ai_started`, any number of `search_ai_event`, then `search_ai_completed`; or `search_ai_failed` (`requestId required`, `Search summarizer not initialized`, `No model available`, a timeout after 60 s, or the session's own error). A missing `projectId` or `query`, an unknown project, or a failed hidden-session create is only logged: no frame is sent. |
| `search_ai_stop` | `{requestId}` | Stops the summary. No reply of its own. |
| `git_changes` | `{projectId, scope?, repo?}` (`scope` is `'uncommitted'` (default) or `'base'`; without `repo`, every repo under the project root) | Expensive. `git_changes` frames, or `git_error`. Also starts the project's recursive watcher, like `list_directory`. |
| `git_file_versions` | `{projectId, repo, path, scope?}` (`repo` is root-relative with a leading slash, `path` repo-relative) | `git_file_versions`, or `git_error`. Read-only ([design-git-changes.md](design-git-changes.md)). |
| `terminal_create` | `{templateId?, name?, directory, projectId, cols?, rows?, persistSession?}` | `terminal_created` then Eve joins it. `persistSession` reattaches to a named persistent session and is forwarded to relay as `persist_session`. Eve answers this over HTTP via `POST /api/terminals` (a relay route), not by forwarding the frame to relay. Without `projectId`: `error` `terminal create failed: a terminal needs a project`. A relay refusal: `error {context:'terminal_create', message:'terminal create failed: <relay error>' or 'terminal create failed (<status>)', code?}`. An unreachable relay: `error` `terminal create failed: relay unavailable`. Templates are fetched over HTTP (`GET /api/terminal/templates`), not this frame. |
| `terminal_input` | `{terminalId, data}` (`data` is the typed text) | Forwarded to relay. No reply. |
| `terminal_resize` | `{terminalId, cols, rows}` | Forwarded to relay. No reply. |
| `terminal_close` | `{terminalId}` | Relay closes the terminal and sends `terminal_closed` to every connection. |
| `terminal_list` | no fields | Relay answers `terminal_list`. |
| `terminal_reconnect` | `{terminalId, cols, rows}` | Forwarded to relay: it resizes the terminal to `cols` x `rows` if they differ, registers this connection as a viewer and answers `terminal_joined`. An unknown id answers `error` `terminal not found: <id>`. |
| `join_terminal` | `{terminalId}` | Relay answers `terminal_joined`, and `terminal_exit` if the terminal has stopped. An unknown id answers `error` `terminal not found: <id>`. |
| `leave_terminal` | `{terminalId}` | Forwarded to relay. No reply. |
| `voice_mode` | `{enabled, voice?, speed?}` | Turns server-side speech of chat replies on or off for this connection. No reply. |
| `tts_speak` | `{text, voice?, speed?, trace_id?}` (`text` at most 10,000 characters) | Expensive. Binary audio frames, then `tts_done`; or `tts_error`. A newer `tts_speak` or a `tts_speak_cancel` stops the one in flight. |
| `tts_speak_cancel` | no fields | Stops the speech in flight. No reply. |
| `transcribe_audio` | `{audio, language?, trace_id?}` (`audio` base64) | Expensive. `transcription_result`, or `transcription_error`. |
| `device_log` | `{lines: [...]}` or `{line}` | Appended to a server-side log with timestamp and source IP. No reply frame. |
| `cos_subscribe` | no fields | Chief of Staff (server-wide thread, all projects; authenticated sockets only). Answered with `cos_snapshot`; the socket then receives `cos_post` and `cos_status`. `error` `Chief of Staff is not available` when it is off. |
| `cos_message` | `{text}` (1 to 2000 characters after trim) | Expensive. No reply on success; the post arrives as `cos_post`. Otherwise `error` `Message must be 1 to 2000 characters`. |
| `cos_card_action` | `{postId, action, edits?}` (`action` is `'start'` or `'cancel'`) | Only a `pending` start or send card accepts it. Start-card `edits` are `{prompt?, folder?, model?, mode?}`, send-card `edits` are `{text?}`, validated like the tool arguments; one action per card at a time. The result arrives as `cos_post_update`. Failures answer `error`: `A card action needs a postId and an action`, `Unknown card action`, `That card is gone`, `This card is <state>`, the field error from validation, or `The card action failed`. |

### Server → Client

Every frame is JSON with a `type`, except TTS audio, which is a binary frame (the only binary frame; no `type`). `sessionId` frames from relay are forwarded untouched. Frames relay owns are marked (relay); Eve adds nothing to them. These bypass batching and are sent at once: `permission_request`, `error`, `session_created`, `session_joined`, `tts_done`, `tts_error`, `mode_changed`, `relay_status`.

| Frame | Fields |
|-------|--------|
| `pong` | no fields. Reply to `ping`. |
| `auth_success` | no fields. |
| `auth_failed` | `{message}`, then the socket closes with code 4001. The browser clears its stored token and reloads. |
| `__batch` | `{msgs: [frame, ...]}`: coalesced high-frequency frames, dispatched in order. |
| `relay_status` | `{connected}`: the upstream relayLLM leg, not the browser↔eve link `#connectionStatus` already tracks; see reconnect semantics above. |
| `error` | `{message, sessionId?, context?, code?, requestId?}`. `sessionId` is present on a session's own error (relay); `context:'terminal_create'` and `code` on a failed terminal create; `requestId` on a rate-limit refusal. `code:'resume_required'` from relay is described below and never reaches the browser. |
| `session_created` | `{sessionId, directory, projectId, model, name, metadata, sessionType, voice, host}`. `projectId`, `name`, `sessionType`, `voice` and `host` are `null` when absent; `metadata` repeats `directory`; `host` is relay's host chip for an SSH-host session. Sent by Eve after `create_session`. |
| `session_joined` | (relay) `{sessionId, projectId, directory, model, name, folder, history, stats, headless, protocolVersion, host, live}`. `live` is false for a dormant session. Not sent for the join Eve itself makes right after `session_created`. |
| `session_renamed` | (relay) `{sessionId, name}`. |
| `session_folder_changed` | (relay) `{sessionId, folder}`. |
| `session_ended` | (relay) `{sessionId}`. |
| `session_state` | (relay) `{sessionId, state, since}`. Described below. |
| `user_message` | (relay) `{sessionId, text, origin?}`. The echo of a user turn; `origin` names a non-person sender such as `chief-of-staff`. |
| `llm_event` | (relay) `{sessionId, event}`. `event` is relayLLM's raw frame (see LLM events). |
| `message_complete` | (relay) `{sessionId, isError?, apiErrorStatus?}`. Ends a turn. Also sent by Eve alone, as `{sessionId}`, to finish a local slash command. |
| `stats_update` | (relay) `{sessionId, stats}`; see Stats object. |
| `raw_output` | (relay) `{sessionId, text}`. A `text` that is a JSON object with a string `type` is an untranslated provider event, and the browser drops it. |
| `stderr` | `{sessionId, text}`. Rendered as an error line. Current relay does not send it. |
| `system_message` | `{sessionId, message}`. Relay sends one after `/clear`; Eve sends it for local slash commands. |
| `warning` | `{message}`. Rendered as a warning line. Current relay does not send it. |
| `process_exited` | (relay) `{sessionId}`. The provider process ended; it restarts on the next message. |
| `clear_messages` | (relay) `{sessionId}`. Clears the thread. |
| `mode_changed` | (relay) `{sessionId, mode}`. The permission mode now in force. |
| `permission_request` | (relay) `{sessionId, permissionId, toolName, toolInput, toolUseId}`. `toolInput` is a JSON string. Answer with `permission_response`. |
| `terminal_request` | `{sessionId, directory, projectId, command}`. From the local slash commands: `command` is `shell` (`/zsh`, `/bash`), `claude-code` (`/claude`) or `rh` (`/rh`). The browser then opens a terminal for `projectId`. |
| `plan_file_content` | `{path, content}`. Answer to `read_plan_file`. |
| `directory_listing` | `{projectId, path, entries: [{name, type: 'file'\|'directory', size, mtime}]}`. Directories first, then by name; a link shows as `file`. |
| `file_content` | `{projectId, path, content, size}`. |
| `file_saved` | `{projectId, path}`. |
| `file_renamed` | `{projectId, oldPath, newPath}`. `newPath` has a leading slash. |
| `file_moved` | `{projectId, oldPath, newPath}`. `newPath` has a leading slash. |
| `file_deleted` | `{projectId, path}`. |
| `file_uploaded` | `{projectId, destDirectory, fileName}`. |
| `directory_created` | `{projectId, path, name}`. `path` is the new directory, with a leading slash. |
| `file_error` | `{projectId, path, error}`. `path` is the request's own path (`sourcePath` for a move, `destDirectory` for an upload, the parent for `create_directory`); `error` is one of the texts in file_error texts below. |
| `file_changed` | `{projectId, path, content?, size?}`. A watched file changed outside the editor. `content` and `size` are absent for a `binary` watch. |
| `dir_changed` | `{projectId, path}`. A directory listing changed; the browser re-lists it. |
| `watch_error` | `{projectId, reason}`: the project's file watcher could not start or died, `reason` is the errno code such as `ENOSPC` (`UNKNOWN` without one); sent once per project until a later start succeeds, after which the tree and open files no longer update on their own. |
| `search_results` | `{requestId, projectId, matches: [{file, lineNumber, lineText, submatches: [{start, end}]}], truncated, durationMs}`. |
| `search_error` | `{requestId, projectId, error}`. `Project not found`, `Search query is empty`, `Query too long (max 1000 chars)`, a glob error (`Glob too long (max 200 chars)`, `Invalid glob: <glob>`, `Too many globs (max 5)`), or the file error text. |
| `search_ai_started` | `{requestId, projectId, sessionId, model}`. |
| `search_ai_event` | `{requestId, sessionId, event}`. `event` is the hidden session's relay frame, unchanged. |
| `search_ai_completed` | `{requestId, sessionId, model, durationMs}`. |
| `search_ai_failed` | `{requestId, sessionId, error}`. `requestId` and `sessionId` are `null` when unknown. |
| `git_changes` | `{projectId, scope, repo?, repos: [{path, name, branch, head, detached, upstream, ahead, behind, defaultBranch, pending, files, base, truncated, error?}]}`. Details in the Git paragraph below. |
| `git_file_versions` | `{projectId, repo, path, scope, original, modified, binary, tooLarge, originalSize, modifiedSize}`. |
| `git_error` | `{projectId, repo?, path?, code, error}`. |
| `git_changed` | `{projectId, repo}`. Pushed by the file watcher; clients re-request `git_changes`. |
| `terminal_created` | `{terminalId, templateId, name, directory, host}`. `host` is `{id, name}` for a terminal on an SSH host, else absent. Sent by Eve after `terminal_create`. |
| `terminal_joined` | (relay) `{terminalId, templateId, name, directory, state, cols, rows, scrollback, host}`. `scrollback` is base64. |
| `terminal_output` | (relay) `{terminalId, data}`. `data` is base64. |
| `terminal_exit` | (relay) `{terminalId, exitCode}`. |
| `terminal_closed` | (relay) `{terminalId}`. Sent to every connection. |
| `terminal_list` | (relay) `{terminals: [{id, templateId, name, directory, state, exitCode?, host?, origin?}]}`. |
| `task_started` | (relayScheduler) `{taskId, projectId, taskName, view}`. `view` is `{kind: 'interactive'\|'readonly', runId?, hasLastRun?}`. |
| `task_completed` | (relayScheduler) `{taskId, projectId, taskName, view, status, exitCode?}`. `exitCode` is present for a terminal run. |
| `task_error` | (relayScheduler) `{taskId, projectId, taskName, view, error, status?, exitCode?}`. A failure before the run starts carries no `status`. |
| `task_status` | (relayScheduler) `{running: [{taskId, projectId, taskName, view}]}`. Sent when the task socket connects. |
| `tts_done` | no fields from a `tts_speak`. After a spoken chat reply (voice mode) it carries `{sessionId}`. |
| `tts_error` | `{message}`. `TTS unavailable`, `Text too long (max 10000 characters)` or `Speech synthesis failed`. |
| `transcription_result` | `{text, language, duration}`. |
| `transcription_error` | `{error}`. `No audio data`, `Audio recording too short`, `Failed to process audio. The recording may be too short or corrupted.`, or the STT service's own message. |
| `ui_command` | `{command, actor:'llm', projectId}`. `command` is `{action:'open_tab', tab_kind, tab_ref, image_url, title}`, `{action:'refresh_tab', tab_kind, tab_ref, image_url}` or `{action:'close_tab', tab_ref}`. LLM-initiated tab control via the eve-control MCP (`POST /internal/ui-command`); the browser trims it to tabs the LLM opened. |
| `cos_snapshot` | `{posts, status, rowNotes}`. Details in the Chief of Staff paragraph below. |
| `cos_post` | `{post}`. |
| `cos_post_update` | `{post}`. Replaces the post with that id. |
| `cos_status` | `{status}`. |
| `cos_row_note` | `{sessionId, text, kind, source, at}`. |
| `host_status` | `{hostId, name, status, error?}`. Details below. |

`session_state` (from relay, forwarded untouched; reaches every browser, joined or not): `{type:'session_state', sessionId, state, since}`. `state` is one of `starting`, `running`, `idle`, `asking`, `errored`, `stalled`, `ended`; the browser ignores any other value. `since` is an RFC 3339 time with milliseconds. relay sends each session's frames in order. The agent board (`AgentAttention`) keeps the latest per session and shows a session only once `GET /api/sessions` or `session_created` names it. `turn_done` and other unknown types are dropped.

`error` from relay can carry `code:'resume_required'` (`{type:'error', code:'resume_required', sessionId}`, no `message`) when a `send_message` targets a dormant session. eve never forwards this frame as-is: it calls `POST /api/sessions/:id/resume` and, on success, re-sends the driving user turn's `send_message` exactly once; the browser only ever sees the eventual outcome — a normal reply, or a plain `error` if the resume call itself fails or nothing was actually pending. Never host-driven (SH-6) — a `resume_required` with no matching pending user turn is reported as an error too, not retried.

Git: `git_changes` (`{projectId, scope, repo?, repos: [{path, name, branch, head, detached, upstream, ahead, behind, defaultBranch, pending, files: [{path, status, oldPath?, staged}], base, truncated, error?}]}` — `repo` is set on a single-repo frame and absent on a full-list frame, so a client replaces its list on a frame without `repo` and merges on one with it; `status` ∈ `M A D R U ?`; a failure in one repo sets that entry's `error: {code, message}` instead of failing the frame). A full request (no `repo`) is answered in two phases: first, at once, one full-list frame with every repo's meta and `pending: true, files: [], base: null, truncated: false`; then one single-repo frame per repo, in completion order, carrying `upstream`, `ahead`, `behind`, `files`, `base`, `truncated` and `pending: false` (or `error`). A project with no repos gets only the empty full-list frame. A request with `repo` gets exactly one single-repo frame. `upstream`/`ahead`/`behind` are only meaningful once a repo is no longer pending, `git_file_versions` (`{projectId, repo, path, scope, original, modified, binary, tooLarge, originalSize, modifiedSize}` — `original`/`modified` are `null` when the file is absent on that side, and both `null` when `binary` or `tooLarge`), `git_error` (`{projectId, repo?, path?, code, error}` — `code` ∈ `NOT_A_REPO GIT_MISSING TOO_LARGE TIMEOUT FAILED`, plus `INVALID` for a bad `scope`/`repo`/`path` and `NOT_FOUND` for an unknown project; `error` never carries the server-side absolute path), `git_changed` (`{projectId, repo}` — pushed by the file watcher when a watched repo's status may have changed; clients re-request `git_changes`).

Chief of Staff: `cos_snapshot` (`{posts, status, rowNotes}` — the last 200 posts, the current `CosStatus` and the current row notes), `cos_post` (`{post}`), `cos_post_update` (`{post}`, replaces the post with that id; sent when a card changes state), `cos_status` (`{status}`, sent when it changes). `cos_row_note` (`{sessionId, text, kind: 'summary'|'alert', source: 'pending'|'model'|'template', at}`, flattened; sent when a session's one-line row note for the agent rail changes; `text` is one line of 1 to 160 characters derived from agent output, so clients render it as text only; a `CosRowNote` in `rowNotes` has the same fields; notes are memory only and a row note never adds a post). eve keeps its daily model-call counters in `data/chief-of-staff-state.json`: `calls` (all model calls) and `rowCalls` (row summaries only, an additive key, reset with `calls` each local day). `status` is `{busy, watching, needYou, model, calls: {used, max}, off}`; `off` is null or `{reason, detail}`. A post is `{v:1, id, at, kind: alert|person|reply|sent|send_failed|notice|start_card|send_card|started|start_failed|finished, byModel, ...}`; an `alert` carries one `card` built by eve from relay data. See the Chief of Staff design doc.

Relay scope: eve reads attention and sends for the Chief of Staff over relay's frontend socket with the per-request header `X-Relay-Scope: chief-of-staff` (`RelayTransport` option `scope`; any other value throws `RelayConfigError`). Only scoped `GET /api/sessions`, scoped listen-only `GET /ws` and `POST /api/chief-of-staff/messages` (`{sessionId, text}`, never `origin`; 202 on success) use it. The model session is unscoped. The scope names no credential.

Chief of Staff actions. The `start_card` post carries `card:{state: pending|starting|started|failed|cancelled, project:{id,name}, folder, model, mode, prompt, why, turnId, result: null|{sessionId,name}, error}`; the `send_card` post carries `card:{state: pending|sending|sent|failed|cancelled, sessionId, label, text, why, turnId, error}`. `why` is `read_not_verbatim` or `read_target_not_named`. A `started` post is `{sessionId, name, projectId, projectName, mode, origin:'chief-of-staff'}` and `start_failed` is `{projectName, error}`. A `finished` post (an agent the thread started or sent to ended its turn) is `{sessionId, label, projectId, projectName, summary, source: model|template}`: `label` is at most 80 characters, `projectName` may be `''`, `summary` is at most 300 characters and 2 lines joined by `\n`, and `source` is `template` when the daily limit or a bad reply meant no model summary. A card never expires; `failed` is final. Posts persist with their card state. Starts use the scoped `POST /api/chief-of-staff/sessions` (`{projectId, folder?, prompt, model, mode?}`; 201 `{sessionId, name, projectId, directory, mode, kind, origin, at}`; refusals are `{error, message}` and surface as `relay_<code>`); eve never starts a session through the unscoped create. Rows of `GET /api/sessions` and `GET /api/terminals` carry `origin` when set.

`POST /internal/cos` (loopback only, header `x-eve-internal: <secret>`, body `{tool, args, meta:{project_id}}`; called by the `eve-cos` MCP, `mcp/cos.js`, registered by `npm run register:mcp` as `relay-eve-cos`). Tools: `cos_list_sessions`, `cos_session_status {sessionId}`, `cos_propose_start {project, prompt, folder?, model?, mode?: headless|terminal}`, `cos_propose_send {sessionId, text}`. Answer: 200 `{ok:true, result}` (a start or send result is `{status:'started'|'sent', ...}` or `{status:'card', cardId}`) or `{ok:false, error, message}`. Checks in order: not loopback 403 `forbidden`; bad secret 401 `unauthorized`; 400 `unknown_tool`; 409 `off`; `meta.project_id` not the person model's project 403 `not_cos_session`; no person turn in flight 409 `no_turn`; the call not seen as a `tool_use` of this turn 403 `unverified_call`; bad arguments 400 `invalid_args` (names the field), 404 `unknown_project`, 409 `ambiguous_project`, 404 `unknown_session`, 502 `roster_unavailable`; a relay refusal 502 `relay_<code>`. `cos_propose_start` accepts a project on an SSH host (headless only; a terminal start there is relay's 400 `terminal_on_host`, answered 502 `relay_terminal_on_host`).

SSH hosts: `host_status` (`{hostId, name, status:'connecting'|'connected'|'unreachable', error?}`) — the connectivity of relay's file agent on each SSH host, as relay reports it on `/ws/files` (`relay-file-client.js`), distinct from relay's ssh `ControlMaster`/`hostView.status`. Sent on every status change, plus once per authenticated connection with the latest status of each host relay holds an agent for (not necessarily every host relay knows about). See [ssh-hosts.md](../../relay/docs/ssh-hosts.md).

### file_error texts

`file_error.error` (and the `error` of a failed `GET /api/files/...`) is one text, chosen from relay's error code. Operation-specific texts win over the generic one.

| Relay code | Text |
|------------|------|
| `ENOENT` | `File not found`. For `list_directory` and `write_file`: `Directory not found`. For `move_file`: `Source file not found`. For `upload_file`: `Destination directory not found`. For `create_directory`: `Parent directory not found`. |
| `EACCES` | `Permission denied` |
| `EISDIR` | `Path is a directory` |
| `ENOTDIR` | `Not a directory`. For `move_file`: `Destination must be a directory`. |
| `EEXIST` | `Already exists`. For `rename_file`: `A file or directory with that name already exists`. For `move_file`: `A file or directory with that name already exists at destination`. For `upload_file`: `A file with that name already exists`. For `create_directory`: `Directory already exists`. |
| `TRAVERSAL` | `Path traversal not allowed` |
| `SYMLINK` | `Symbolic links are not opened` |
| `READ_ONLY` | `This project is read-only` |
| `TOO_LARGE` | `File too large (max 10MB)` |
| `TIMEOUT` | `Request timed out` |
| `RELAY_DOWN` | `Relay is not reachable` |
| `PROJECT_NOT_FOUND` | `Project not found` |
| `HOST_UNREACHABLE` | `Host "<host name>" is not connected` |
| any other code | Relay's own message, else the code, else `File operation failed`. |

Eve adds these before relay is asked: `Project not found` (the id is not in Eve's project cache), `File type not allowed for editing` (read or write on a console project, extension off the editor allowlist; extensionless names pass), `File type not allowed` (renaming a file to a name off the allowlist), `Name cannot contain path separators`, `File name cannot contain path separators`, `Invalid file name`, `Cannot move a directory into itself`, `Cannot delete project root`, `Content too large (max 10MB)`, `File too large (max 10MB)`.

### Trace IDs

Every action carries one trace ID (see `relay/docs/logging-standard.md`). HTTP: eve reads `X-Trace-Id` (kept only if it matches `[A-Za-z0-9_-]{8,64}`, else a new one is made) and passes it to relay on the same header. Eve sends the header only to a relay on the same machine (the frontend socket, or a loopback host), never to a remote one. WebSocket: a `user_input` frame may carry `trace_id`; eve validates it the same way and forwards it to relay as `send_message.trace_id`. The upgrade request carries no ID from the browser.

### Stats object

`stats_update` carries relayLLM's stats struct: `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }`. Canonical definition: relayLLM `provider.go`.

### LLM events

`llm_event.event` is a raw relayLLM frame (assistant text/tool_use/thinking blocks as deltas or full blocks; `result` summary). Eve forwards it unchanged — see relayLLM `docs/event-protocol.md` for the full shape.

`result` events with `subtype: 'tool_result'` carry `tool_use_id`, `tool_name`, `content`, `is_error` and, only when macMCP's scope check refused the call, `scope_violation: true`. A Claude `tool_result` block carries `is_error` and no `scope_violation`. Eve reads a refusal from these: `scope_violation === true`, or `is_error === true` with `access denied: ` in the text (`public/core/refusal.js`).
