# API Reference

Eve exposes HTTP endpoints and a WebSocket interface for real-time communication. Most HTTP endpoints are proxied to relayLLM; file and terminal operations are handled locally.

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

### Models (proxied to relayLLM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List all available models. Proxied to relayLLM. |

### Projects (proxied to relayLLM)

Eve proxies project CRUD to relayLLM and caches the results for file handler path resolution.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects. Refreshes Eve's project cache. |
| POST | `/api/projects` | Create a project. Body: `{ name, path, model?, allowedTools? }`. |
| GET | `/api/projects/:id` | Get a single project. |
| PUT | `/api/projects/:id` | Update a project. |
| DELETE | `/api/projects/:id` | Delete a project. Sessions become ungrouped (not deleted). |

### Sessions (proxied to relayLLM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List all sessions. |

Session creation and messaging happen over WebSocket (see below), not HTTP.

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
