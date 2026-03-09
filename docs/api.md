# API Reference

Eve exposes HTTP endpoints and a WebSocket interface for real-time communication.

## Authentication

All endpoints (except `/api/auth/*`) require authentication when WebAuthn is enrolled.

| Method | Details |
|--------|---------|
| Header token | `X-Session-Token: <token>` |
| Localhost bypass | Requests from `localhost`/`127.0.0.1` skip auth |
| Env bypass | `EVE_NO_AUTH=1` disables auth entirely |

Get a token via the WebAuthn enrollment or login flow below.

## HTTP Endpoints

### Auth

[WebAuthn](https://webauthn.io/) enrollment and login. Rate-limited per IP (429 on excess). These endpoints do **not** require the `X-Session-Token` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/status` | Check enrollment and authentication state. Returns `localhost: true` for local connections (always authenticated). |
| POST | `/api/auth/enroll/start` | Begin passkey enrollment. Returns WebAuthn `options` for `navigator.credentials.create()`. 400 if already enrolled. |
| POST | `/api/auth/enroll/finish` | Complete enrollment. Body: `{ response, challengeId }`. Returns `{ token }` for subsequent requests. |
| POST | `/api/auth/login/start` | Begin login. Returns WebAuthn `options` for `navigator.credentials.get()`. 400 if not enrolled. |
| POST | `/api/auth/login/finish` | Complete login. Body: `{ response, challengeId }`. Returns `{ token }`. |

### Models

Both return the full merged model list from all enabled providers.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List all available models. Each entry has `label` (display name), `value` (model ID), and `provider`. |
| POST | `/api/models/refresh` | Re-fetch models from LM Studio, then return the updated full list. No-op for CLI-based providers. |

### Projects

`allowedTools` is an array of tool name strings passed to the CLI. `disabled` is computed from provider settings (not stored). Invalid `model` values fall back to `haiku`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects. Each includes `id`, `name`, `path`, `model`, `allowedTools`, and `disabled` (true if the project's provider is turned off). |
| POST | `/api/projects` | Create a project. Body: `{ name, path, model?, allowedTools? }`. `name` and `path` required. Returns the created project with generated `id` and `createdAt`. |
| PUT | `/api/projects/:id` | Update a project. Body: any subset of `{ name, path, model, allowedTools }`. Omitted fields are unchanged. Returns the updated project. 404 if not found. |
| DELETE | `/api/projects/:id` | Delete a project. Sessions in the project become ungrouped (not deleted). 404 if not found. |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List all sessions. Each includes `id`, `directory`, `projectId`, `name`, `model`, and `active` (true if provider process is running). |
| POST | `/api/sessions` | Create a session. Body: `{ projectId, name?, model? }`. `projectId` required (404 if project not found). `model` overrides the project default. Returns `{ sessionId, projectId, model }`. |
| POST | `/api/sessions/:id/message` | Send a message to an LLM session. Body: `{ text, files? }`. **Synchronous** -- holds the connection open until the LLM finishes. Returns `{ response, stats }`. 404 if session not found (tries disk recovery first). 409 if session is already processing another message. 504 on provider timeout. Auto-restarts the provider if the process died. |

### Tasks

`schedule.type` must be one of: `daily`, `hourly`, `interval`, `weekly`, `cron`. See [tasks.md](tasks.md) for schedule format details.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List all tasks grouped by project. Returns `[{ projectId, tasks: [...] }]`. |
| POST | `/api/tasks/:projectId` | Create a task. Body: `{ name, prompt, schedule, model?, args?, enabled? }`. `name`, `prompt`, and `schedule` required. `args` is an optional array of CLI arguments. Returns the created task. |
| PUT | `/api/tasks/:projectId/:taskId` | Update a task. Body: partial task fields (any of `name`, `prompt`, `schedule`, `model`, `args`, `enabled`). Returns the updated task. |
| DELETE | `/api/tasks/:projectId/:taskId` | Delete a task permanently. |
| POST | `/api/tasks/:projectId/:taskId/run` | Trigger immediate execution of a task (ignores schedule). Returns `{ success, message }`. The task runs asynchronously; subscribe to `task_started`/`task_completed`/`task_failed` WebSocket events for results. |
| GET | `/api/tasks/:projectId/:taskId/history` | Get execution history for a task. Returns `[{ taskId, startedAt, completedAt, status, response? }]` ordered by most recent. |

### Permissions

Called by the Claude CLI PreToolUse hook (`scripts/permission-hook.js`), not by the browser client directly.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/permission` | Request permission for a tool use. Body: `{ sessionId, toolName, toolInput, toolUseId? }`. Only `Edit`, `Write`, `Bash`, `NotebookEdit` are prompted -- all other tools return `{ decision: 'allow' }` immediately. For prompted tools, the server forwards a `permission_request` to the browser via WebSocket and **holds the HTTP response open** until the user responds or the 60s timeout fires (auto-deny). If the session has `alwaysAllow` enabled, returns allow immediately. Returns `{ decision, reason }` where decision is `allow` or `deny`. |

## WebSocket

Connect to `ws://<host>:<port>`. First message must be `auth` if WebAuthn is enrolled.

### Client → Server

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `token` | Authenticate the WebSocket connection |
| `create_session` | `directory, projectId?, model?` | Create a new LLM session |
| `join_session` | `sessionId` | Resume an existing session |
| `user_input` | `text, files?` | Send a message to the active session |
| `end_session` | - | End the current session (kills provider) |
| `delete_session` | `sessionId` | Delete a session permanently |
| `rename_session` | `sessionId, name` | Rename a session |
| `list_directory` | `projectId, path` | List files in a directory |
| `read_file` | `projectId, path` | Read file contents |
| `write_file` | `projectId, path, content` | Write file contents |
| `rename_file` | `projectId, oldPath, newPath` | Rename a file |
| `move_file` | `projectId, oldPath, newPath` | Move a file |
| `delete_file` | `projectId, path` | Delete a file |
| `upload_file` | `projectId, destDirectory, fileName, content` | Upload a file (base64) |
| `create_directory` | `projectId, path, name` | Create a directory |
| `terminal_create` | `directory, command?, args?, sessionId?` | Spawn a terminal |
| `terminal_input` | `terminalId, data` | Send input to a terminal |
| `terminal_resize` | `terminalId, cols, rows` | Resize a terminal |
| `terminal_close` | `terminalId` | Close a terminal |
| `terminal_list` | - | List all terminals |
| `terminal_reconnect` | `terminalId` | Reattach to an existing terminal |
| `permission_response` | `permissionId, approved, reason?, alwaysAllow?` | Respond to a permission request |

### Server → Client

| Type | Fields | Description |
|------|--------|-------------|
| `auth_success` | - | WebSocket auth succeeded |
| `auth_failed` | `message` | WebSocket auth failed (connection closed) |
| `session_created` | `sessionId, directory, projectId, model, name, metadata` | New session ready |
| `session_joined` | `sessionId, directory, model, name, metadata, history` | Resumed existing session |
| `session_renamed` | `sessionId, name` | Session name changed |
| `session_ended` | `sessionId` | Session deleted |
| `llm_event` | `sessionId, event` | Streamed LLM output (text, tool_use, thinking, result) |
| `message_complete` | `sessionId` | LLM finished responding |
| `stats_update` | `sessionId, stats` | Token/cost stats update |
| `raw_output` | `sessionId, text` | Unparsed CLI stdout |
| `stderr` | `sessionId, text` | Provider stderr output |
| `system_message` | `sessionId, message` | System status or slash command output |
| `warning` | `sessionId, message` | Non-fatal warning |
| `error` | `message, sessionId?` | Error message |
| `process_exited` | `sessionId` | Provider process crashed/exited |
| `clear_messages` | `sessionId` | Clear chat display |
| `plan_mode_exit` | `sessionId` | Show plan approval UI |
| `permission_request` | `sessionId, permissionId, toolName, toolInput` | Tool needs user approval |
| `terminal_request` | `sessionId, directory, command, args?` | Server requests client open a terminal |
| `directory_listing` | `projectId, path, entries` | File listing response |
| `file_content` | `projectId, path, content, size` | File read response |
| `file_saved` | `projectId, path` | File write confirmation |
| `file_renamed` | `projectId, oldPath, newPath` | File rename confirmation |
| `file_moved` | `projectId, oldPath, newPath` | File move confirmation |
| `file_deleted` | `projectId, path` | File delete confirmation |
| `file_uploaded` | `projectId, destDirectory, fileName` | File upload confirmation |
| `directory_created` | `projectId, path, name` | Directory create confirmation |
| `file_error` | `projectId, path, error` | File operation error |
| `terminal_created` | `terminalId, directory, command` | Terminal spawned |
| `terminal_output` | `terminalId, data` | Terminal stdout data |
| `terminal_exit` | `terminalId, exitCode` | Terminal exited |
| `terminal_list` | `terminals` | List of active terminals |
| `task_started` | Execution fields | Scheduled task began running |
| `task_completed` | Execution fields | Scheduled task finished |
| `task_failed` | Execution fields | Scheduled task errored |
| `tasks_updated` | Task data | Task list modified |

### Stats Object

Returned in `stats_update` and session message responses:

```json
{
  "inputTokens": 1234,
  "outputTokens": 567,
  "cacheReadTokens": 890,
  "cacheCreationTokens": 0,
  "costUsd": 0.0042
}
```

### LLM Event Types

The `event` field in `llm_event` messages contains provider-specific data. Common shapes:

| Event type | Key fields |
|------------|------------|
| `assistant` | `message.content` (text blocks, tool_use blocks, thinking blocks) |
| `result` | `result`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `num_turns` |
