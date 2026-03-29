# Code Review Log

## 2026-03-28 — Idle timeout + badge review (exp branch)

### Files reviewed
terminal-manager.js (allTerminals, getDetachedCountForPath), sidebar/project-tree-item.js (badge)

### No HIGH issues found

### MEDIUM: Case-sensitive path match in `getDetachedCountForPath`
**Bug**: `startsWith(projectPath)` is case-sensitive. macOS filesystem is case-insensitive, so paths like `/Users/Jonathan` vs `/users/Jonathan` wouldn't match.

**Fix**: Lowercased both sides before comparison.

## 2026-03-28 — Full UI rewrite review (exp branch)

### Files reviewed
All new and modified files: core/*.js (5), sidebar/*.js (4), dialogs/*.js (3), layout/mobile-bar.js, app.js, tab-manager.js, message-dispatcher.js, ws-handler.js, index.html, styles.css. Cross-checked against prior reviews — no flip-flopping.

### HIGH: `api-client.js` — `response.json()` throws on empty/204 responses
**Bug**: Success path called `response.json()` without `.catch()`. DELETE endpoints returning 204 or empty body would throw SyntaxError. Error path already had `.catch(() => ({}))`.

**Fix**: Added `.catch(() => ({}))` to success path.

### HIGH: `mobile-bar.js` — Chat button handler broken
**Bug**: Used `window.client` global lookup with nonsensical guard (`document.querySelector ? ...`), dead `ws` variable assignment. Fragile, inconsistent with bus/container pattern.

**Fix**: Replaced with `this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId })` — opens shell launcher which has Web Chat. Consistent with shell button pattern.

### MEDIUM: `file-tree-node.js` — Missing `FileReader.onerror` handler
**Bug**: `_handleExternalDrop` set `reader.onload` but never `reader.onerror`. Failed file reads silently dropped.

**Fix**: Added `reader.onerror` handler with console.error.

### Noted (not fixed — deferred to incremental migration)
- DRY: model select dropdown built in 3 places (shell-launcher, task-dialog, app.js)
- DRY: context menu pattern duplicated between FileTreeNode and ProjectTreeItem
- DRY: icon SVGs duplicated across 3 modules
- Dual state maps in app.js (this.sessions vs this.state.sessions) — migration artifact
- Tight coupling via `container.get('app')` in dialogs — acceptable during migration

## 2026-03-28 — Terminal provider proxy review, second pass (exp branch)

### Files reviewed
All modified Eve files (terminal-manager.js, message-dispatcher.js, app.js, ws-handler.js, relay-client.js, server.js, index.html, styles.css). Verified prior XSS fix in place. No flip-flopping.

### No issues found
All prior fixes verified. DOM API used correctly for user data. Base64 encode/decode correct. Proxy forwarding clean. No dead code, no DRY violations, no new security issues.

## 2026-03-28 — Terminal provider proxy review (exp branch)

### Files reviewed
public/terminal-manager.js, public/message-dispatcher.js, public/app.js, public/index.html, public/styles.css, ws-handler.js, relay-client.js, server.js

### HIGH: XSS via template name/description in picker
**Bug**: `_showPickerUI` used innerHTML with unescaped `t.name` and `t.description` from relayLLM API. Custom templates could inject arbitrary HTML/JS. Same class as modal-manager.js fix (pass 3).

**Fix**: Replaced innerHTML template interpolation with DOM API (`createElement`/`textContent`). SVG icons remain as innerHTML but are hardcoded literals, not user data.

### No other HIGH issues found
- Terminal message proxying in `ws-handler.js` correctly forwards all fields without transformation.
- `relay-client.js` `send()` method is a clean refactor of `_send()`.
- `server.js` correctly removed local `TerminalManager` dependency.
- Base64 encode/decode in `terminal-manager.js` handles binary correctly.
- Template picker lifecycle (create/remove overlay) is clean.

## 2026-03-26 — Review of uncommitted changes on `newArchitecture`

### Files reviewed
CLAUDE.md, README.md, auth.js, docs/test.md, docs/testindex.md, public/app.js, public/index.html, public/modal-manager.js, public/task-manager.js, relay-client.js, routes/auth.js, terminal-manager.js

### HIGH: `task-manager.js` — Missing `response.ok` checks on all fetch calls

**Bug**: `fetch()` only throws on network errors, not HTTP 4xx/5xx. All 7 methods in `TaskManager` proceeded without checking response status. Worst impact: `deleteTask` and `deleteByProject` removed local task entries even when the server rejected the delete, causing client/server state divergence.

**Fix**: Added `if (!response.ok) throw new Error(...)` before parsing/mutating in all methods: `loadTasks`, `createTask`, `updateTask`, `deleteTask`, `deleteByProject`, `runTask`, `loadHistory`.

### No issues found (good changes)
- `routes/auth.js` — DRY extraction of rate-limit, enrollment, and body validation into middleware. Clean.
- `auth.js` — `consumeChallenge()` DRY helper wrapping get + null-throw. Fine.
- `relay-client.js`, `terminal-manager.js` — Magic number `1` replaced with `WebSocket.OPEN`. Good.
- `modal-manager.js` — Delegated `escapeHtml` to `messageRenderer` to avoid duplication.
- `public/app.js`, `index.html` — `catchUp` field plumbing for task modal. Straightforward.
- README.md, docs — Updated to reflect current file structure and removed stale references.

## 2026-03-26 — Full codebase review (second pass)

### Files reviewed
All server and client JS files (~20 files). Checked against prior review to avoid flip-flopping.

### HIGH: `app.js` — Missing `response.ok` checks on all fetch calls (5 locations)

**Bug**: Same class of bug fixed in `task-manager.js` above, but not applied to `app.js`. `loadModels`, `loadProjects`, `loadSessions` silently swallowed HTTP errors. `handleNewProject` and `deleteProject` mutated local state (added project to Map, deleted project from Map) even when the server rejected the request, causing client/server state divergence.

**Fix**: Added `if (!response.ok) throw new Error(...)` before parsing/mutating in `loadModels`, `loadProjects`, `loadSessions`, `handleNewProject`, `deleteProject`.

### HIGH: `server.js:refreshProjectCache` — Relay error wipes the project cache

**Bug**: If relayLLM returned a non-200 response, `response.json()` returned an error object, `projectCache.clear()` ran unconditionally, and `Array.isArray()` failed the check — so the cache was left empty. All file operations depend on the project cache to resolve paths, so a transient relay error broke file browsing/editing until the next successful refresh.

**Fix**: Added `response.ok` check. Moved `Array.isArray` check before `clear()` so the cache is only replaced when we have valid data.

### HIGH: `terminal-manager.js` (server) — Writing to dead PTY

**Bug**: `handleInput` and `handleResize` didn't check `terminal.exited` before calling `pty.write()` / `pty.resize()`. If a user typed into a terminal after the process exited, node-pty could throw an unhandled error.

**Fix**: Added `&& !terminal.exited` guard to both methods (matches pattern already used in client-side terminal manager).

### DRY: `message-dispatcher.js:handleSchedulerTaskEvent` — Duplicate reload blocks

The `loadTasks(data.projectId).then(renderProjectList)` pattern was copy-pasted for both `task_completed` and `task_error`. Consolidated into a single shared block that runs for either event type.

## 2026-03-26 — Full codebase review (third pass)

### Files reviewed
All 27 JS source files (server + client). No HIGH issues found — previous passes already fixed the crash/security bugs. Moved to MEDIUM.

### MEDIUM: `file-editor.js` — 10+ debug `console.log` statements in production code

Violated "No temporary debugging code" standard. Removed all debug logging from `loadMonaco`, `createEditor`, `openFile`, `loadContentIntoEditor`, and `showFile`. Reduced file from 440 to 413 lines.

### MEDIUM: `modal-manager.js:326` — Unescaped `last.status` in innerHTML

`renderTaskLastResult` correctly escaped `last.error` and `last.response` with `this.escapeHtml()` but passed `last.status` (from relayScheduler API) raw into innerHTML. Inconsistent with the escaping pattern used 3 lines later. Fixed.

### MEDIUM: `routes/index.js:105` — Query parameter not URL-encoded

`req.query.projectId` was interpolated directly into the relay URL without `encodeURIComponent()`. Added encoding.

### Cleanup: `file-browser.js:527-528` — Unused variable

`projectName` was declared but never referenced in the error message. Removed.

## 2026-03-26 — Full codebase review (fourth pass)

### Files reviewed
All server and client JS files (~25 files). Checked against prior reviews — no flip-flopping.

### HIGH: `ws-handler.js` — `stop_generation` message silently dropped

**Bug**: The client stop button (`app.js:448`) sends `{ type: 'stop_generation', sessionId }` over WebSocket, but `ws-handler.js` had no case for this message type. The message was silently dropped. The UI would reset (hide thinking indicator, finish assistant message, hide stop button) but the LLM continued generating on relayLLM, wasting tokens. Subsequent streaming events from the still-running generation would arrive and corrupt the message state.

**Fix**: Added `stop_generation` case in `ws-handler.js` that forwards to `relayClient.stopGeneration()`. Added `stopGeneration(sessionId)` method to `relay-client.js`.

## 2026-03-26 — Full codebase review (fifth pass)

### Files reviewed
All server and client JS files (~25 files). Checked against prior reviews — no flip-flopping.

### HIGH: `message-dispatcher.js:handleSchedulerTaskEvent` — Auto-join closes wrong session (data loss)

**Bug**: When a user-triggered task completed, the auto-join logic closed whatever session the user was *currently viewing* (`this.client.currentSessionId`) instead of the task's previous session. If the user navigated to a different session while the task ran, that unrelated session was destroyed — its tab closed, session data deleted, and history wiped. Additionally, `handleTaskEvent(data)` was called before the auto-join block and already overwrote `task.lastSessionId` with the new session ID, so the old session ID was lost.

**Fix**: Captured `task.lastSessionId` before `handleTaskEvent()` overwrites it. Used this captured ID to close only the old task session, not the user's current session.

### Cleanup: `terminal-manager.js` — Unused destructured variables

`id` in `killAll()` and `terminalId` in `detachAll()` were destructured but never referenced. Replaced with `[, terminal]`.

## 2026-03-26 — Full codebase review (sixth pass)

### Files reviewed
All 27 JS source files (server + client). Checked against prior reviews — no flip-flopping.

### MEDIUM: `sidebar-renderer.js:170` — Ungrouped toggle shows literal HTML entities after click

**Bug**: The ungrouped section's initial render used HTML entities (`&#9662;`/`&#9656;`) via `innerHTML`, which renders correctly. But the click handler updated the toggle via `textContent`, which does NOT interpret HTML entities. After one click, users saw the literal string `&#9656;` instead of ▶. The project group toggle worked correctly because it used Unicode characters (`▼`/`▶`) instead of entities.

**Fix**: Replaced HTML entities with Unicode characters `▼`/`▶` in both the `innerHTML` template and the `textContent` handler, matching the project group pattern.

### MEDIUM: `task-manager.js:15` — Missing `encodeURIComponent` on `projectId` query parameter

**Bug**: Same class of issue fixed server-side in pass 3 (`routes/index.js:105`), but the client-side `loadTasks()` call was missed. `projectId` was interpolated directly into the URL query string without encoding.

**Fix**: Added `encodeURIComponent(projectId)`.

### No further issues found
Remaining codebase is clean. All prior fixes verified in place.
