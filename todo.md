# Test backlog — integration layer (and adjacent)

Status (2026-06-14): **unit 486 · integration 64 (1 skipped) · e2e 3 — all green.**

Integration tests live in `test/integration/` (`npm run test:integration`). They spawn the
real `node server.js` against the in-process fake relay (`fake-relay.js`) on an ephemeral
loopback port — no real relay / relayLLM / LLM / passkey. The fake plays the project +
session store and scripts the relay→eve WS stream from the contract in `protocol.js`.

Already covered: auth status, project list + CRUD, file list/read/write, path-traversal
reject, `dir_changed` watcher, session create + default/scripted/error streams, module-AI
invocation (`__module:` interception + cleanup), resilience (dead-relay error, local ops
survive relay-down, reconnect), and the protocol contract (fake-frame validity).

---

## Integration tests still to write

### Sessions / relay forwarding
- [x] Lifecycle ops forward the correct frame to relay — assert the fake **receives**
      leave / end / delete / rename / set_session_folder / stop_generation /
      set_permission_mode. _(session-forwarding.test.js)_
- [ ] `stop_generation` mid-stream halts rendering and resets TTS state. _(forwarding
      covered above; the TTS-state reset is internal — better as a relay-client unit test)_
- [x] All three assistant-text shapes stream through (`assistantMessage` +
      `assistantContentBlock` added). _(session-forwarding.test.js)_

### Permissions
- [x] `permission_request` (relay→browser) → `permission_response` (browser→relay) round-trip.
      _(permissions.test.js)_
- [x] "Allow All" per-session bypass (the auto-approve the relay can't see — it's a *client*
      decision in `ModalManager`, keyed on `currentSessionId`, matched against each request's
      `sessionId`; per-session, drains the queue, cleared by `clearSessionBypass`).
      _(unit: permission-bypass.test.js — the todo previously mislabeled this "alwaysAllow"
      and filed it under integration; it is only testable client-side.)_

### Security invariants (source guards)
- [x] No iframe under `public/` is granted `allow-same-origin` (module trust model invariant #4);
      the 3 project-content iframe sites (module-host / html-preview-pane / file-editor) are locked
      to exactly `allow-scripts`. Fails-closed, scans all sites. _(unit: iframe-sandbox-guard.test.js)_
      Note found while writing it: `viewers/pdf-viewer.js` creates an iframe with **no** sandbox
      attribute (renders a same-origin generated PDF). Deliberate today; flag if that iframe ever
      loads untrusted HTML.

### Terminals
- [x] `terminal_create` → relay; relay `terminal_output` → browser; input/resize/close forward.
      _(terminals.test.js)_
- [ ] `terminal_list` / `terminal_templates` proxy.

### Tasks / scheduler WS (second upstream `/ws/tasks`)
- [x] task events (`task_started/completed`) forwarded to the browser
      (`relay-client._connectScheduler`). _(tasks.test.js)_ — reconnect-after-drop still TODO.
- [x] `GET /api/tasks` proxy. _(tasks.test.js)_ — create / run / delete still TODO.

### Search (local ripgrep — no fake relay involved)
- [x] `search_project` over a real project with content → `search_results` (real rg);
      empty result set; unknown-project error. _(search.test.js)_
- [ ] `search_cancel` cancels an in-flight search; truncation/cap behavior.
- [x] `search_ai_summarize` — `__search:` hidden session intercepted (no llm_event leak),
      `search_ai_*` frames surfaced, session DELETEd afterward. _(search-ai.test.js)_

### File ops (extend local-surface)
- [x] `rename_file` / `move_file` / `upload_file` over WS. _(file-ops.test.js)_
- [x] `watch_file` → external content edit → `file_changed` (with content). _(file-ops.test.js)_
- [x] `module_read_file` / `module_write_file` — server-side `permissions.files` gate over WS
      (permitted path succeeds, denied path is refused). _(file-ops.test.js)_

### UI command bus (eve-control MCP)
- [x] `POST /internal/ui-command` with `EVE_INTERNAL_SECRET` + a viewing browser → `ui_command`
      reaches the right browser; wrong secret → 401; no viewer → no_client. _(ui-command.test.js)_

### Binary proxies
- [x] `GET /api/generated/:filename` and `/api/terminals/:id/log` (`fetchRaw`) — content-type
      + cache headers. _(binary-proxy.test.js)_

---

## Adjacent follow-ups (not strictly integration)

### Contract — record & verify
- [x] **DONE** — `contract-live.test.js` (run `EVE_CONTRACT=1 npm run test:integration`) drives the
      live eve, captures real relay→eve frames, validates each against `protocol.js`, and asserts
      ≥1 `llm_event` yields text. **It immediately caught real drift**: the live relay also streams
      `delta.thinking_delta` and `content_block_stop` assistant events, which the fake never emitted
      and the validator wrongly rejected. Fixed `protocol.js` to model them; record-and-verify now
      passes against the real relay → the mock layer is confirmed faithful for the modeled frames.

### E2E (Playwright, `test/e2e/`, `npm run test:e2e`)
- [ ] Passkey enroll/login via the CDP **virtual authenticator** (the only flow not on the
      loopback bypass).
- [ ] File editor: open a file (Monaco), edit, save → `file_saved` + on disk.
- [ ] Reconnect banner: drop/restart the WS → `ws-client` auto-reconnect UX.
- [ ] Permission prompt modal: `permission_request` → modal → allow / deny.

### CI
- [ ] Run integration + e2e as separate CI jobs (keep the pre-commit hook unit-only).
- [ ] Decide cadence for the `EVE_CONTRACT=1` live-relay job (needs the real stack).

---

## Fake-relay fidelity (audited vs `../relay` + `../relayLLM` source, 2026-06-14)
Checking the fake against the REAL relay source caught **false-confidence bugs** (fake passed but the
real contract differs). Fixed:
- [x] `permission_request` fields are `toolName` / `toolInput` (string) / `toolUseId`
      (relayLLM/api.go:344, events.go:245) — were fabricated as `tool`/`input`.
- [x] `terminal_output.data` is **base64** (relayLLM/main.go:150; browser `_decodeBase64`s it) — was raw text.
- [x] fake now stamps `v:2` on any scripted `llm_event` (real browser drops version-less events).
- [x] `GET /api/tasks` tightened to exact match so `/api/tasks/:id` 404s instead of returning the wrong shape.
- [x] project snake_case→camelCase normalization now pinned (projects.test.js) — incl. token-never-leaks.

Still to fix for full fidelity (no active false-confidence today, but the double is incomplete):
- [ ] Fake 404s task mutations + terminal templates eve proxies (`POST/PUT/DELETE /api/tasks/:id`,
      `/run`, `by-project`, `/history`; `/api/terminal/templates*`). Add real shapes when those get tests.
- [ ] Task event frames lack the real `taskName` / `view` fields (relayScheduler `broadcastTaskEvent`).
- [ ] `POST /api/sessions` echoes the requested model instead of returning a relay-selected one, and
      never returns the model-allowlist 400/403 (eve's create-rejection path is only unit/resilience-tested).
- [ ] Scheduler upstream (`/ws/tasks`) failure/reconnect not tested (resilience covers only the main socket).

## Duplicate review (2026-06-14)
Audited all 3 layers for redundancy. The suite is disciplined — cross-layer overlap is deliberate
defense-in-depth (unit logic + integration wiring + e2e render each catch a distinct drift class).
Only 2 genuine trims applied: merged the duplicate `file-watcher` "ignores unknown projectId" blocks,
and removed the subsumed `sessions.test.js` "scripted custom stream" delta test. Resisted further trimming.

## Notes / gotchas (learned building this)
- **Loopback is a trusted subnet** → no passkey for harness tests; passkey stays manual / CDP.
- **Projects are relay-owned** (eve only caches them); the fake must supply the project→path
  mapping even for "local" file tests.
- **Browser-bound frames are coalesced** into a `__batch` (24 ms); the harness WS client unwraps it.
- **`llm_event` inner events MUST carry `v: 2`** or the client drops them (encoded in `protocol.js`).
- **Verify the fake against `../relay` + `../relayLLM` source, not guesses** — `permission_request`
  fields and base64 `terminal_output` were both wrong until checked against the Go source.
