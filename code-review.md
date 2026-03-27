# Code Review Log

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
