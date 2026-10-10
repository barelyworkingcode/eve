# Eve Workspace — AI Assistant Context

Browser-based LLM frontend that proxies all LLM concerns to [relayLLM](https://github.com/barelyworkingcode/relayLLM) through the `relay` orchestrator. Eve owns local concerns: UI, file browsing/editing, terminals (proxied), voice, and authentication.

Vanilla JS, **no bundler, no build step, no modules**: `public/index.html` loads plain `<script>` tags in dependency order and every class lands on `window`. Node/Express backend at the repo root.

**See also**: [docs/learned.md](docs/learned.md) (pitfalls/patterns) · [docs/api.md](docs/api.md) (HTTP/WS protocol) · [docs/authentication.md](docs/authentication.md) (security model).

Conventions the global rules name: the **feature map** is
[`docs/FEATURES.md`](docs/FEATURES.md), and the **verify harness** is
`devboxverify`. A PR that adds or changes a feature updates the feature map.

## Security (eve-specific rules)

- **Never read `Host` or `X-Forwarded-For` for authorization.** Both are attacker-controllable off-loopback. The only safe network-layer identity is `req.socket.remoteAddress`. See [docs/security-review-auth-transport.md](docs/security-review-auth-transport.md).
- **All network-trust logic goes through `TrustedNetworkService`** (`trusted-network.js`, DI-injected from `server.js`). No ad-hoc IP/hostname checks in route handlers.
- **All egress to relay goes through `RelayTransport`** (`relay-transport.js`). No raw `fetch()` / `new WebSocket()` to relay anywhere. `relayTransport.assertStartupConfig()` hard-fails on any insecure config — never add a "skip-verify"/downgrade flag.
- **Voice is the one exception to "all egress goes through relay."** `tts-service.js` / `stt-service.js` open their own raw, unauthenticated loopback TCP sockets (`TTS_PORT`/`STT_PORT`, default 9997/9998) straight to the local relayTTS/relaySTT daemons — never through `RelayTransport`, no bearer token. Treat these as a separate trust boundary when reasoning about "single egress" claims elsewhere in this doc.

### Security model (two boundaries)

Full design & verification: [docs/security-review-auth-transport.md](docs/security-review-auth-transport.md). Operator reference: [docs/authentication.md](docs/authentication.md).

1. **Browser ↔ Eve** — WebAuthn passkey + session token (`X-Session-Token` header / `{type:'auth'}` WS frame); IP-based trusted-subnet bypass via `TrustedNetworkService` (`req.socket.remoteAddress` only).
2. **Eve ↔ relay** — Eve holds no relay credential in its environment. relay passes a one-shot secret on fd 3 (`RELAY_LAUNCH_FD`); `server.js` spends it on a bridge `Hello` (`launch-identity.js`) before any child spawn or frontend call, and relay thereafter authenticates Eve's connections to the **frontend** Unix socket (`RELAY_FRONTEND_SOCKET`) by the kernel peer identity of Eve's process — no `Authorization` header. Any launch-identity failure exits non-zero. Relay then reverse-proxies onward to relayLLM (sessions/models/permissions) or relayScheduler (tasks) over each service's own internal socket + token. TCP fallback (`RELAY_FRONTEND_URL`, optional internal CA via `RELAY_FRONTEND_CA`) requires `https://` + cert verification.

Per-project policy relayLLM can't see is enforced at relay: `allowed_models` is checked on `POST /api/sessions` by `relay/cmd/relay/frontend_model_guard.go`. Any change to the token contract must touch the cross-repo pieces in lockstep: Eve's `relay-transport.js`; relay's `cmd/relay/frontend_server.go` + `cmd/relay/frontend_dispatcher.go` + `cmd/relay/enhanced_services.go` + `internal/service/service_registry.go`; relayLLM's `auth.go` + `main.go`.

**iOS native app (relayClient)**: WKWebView blocks WebAuthn for local hostnames. Eve serves a Safari-based fallback passkey page at `/api/auth/safari-login` (`routes/auth.js`); the iOS app opens it via `ASWebAuthenticationSession` and gets the token back via the `relayclient://auth-callback?token=...` scheme.

**Adding a second browser**: a relay-owned, presence-gated, five-minute window (`enrollment-window.js` asks relay's frontend socket; `routes/auth.js`'s `requireEnrollable`). **Listing/revoking eve passkeys**: eve reports its credential list to relay and pulls pending revocations (`passkey-sync.js`), checked on every login attempt before the ceremony runs, failing open if relay is unreachable. Design and wire contract for both: [../relay/docs/eve-passkey-enrolment.md](../relay/docs/eve-passkey-enrolment.md).

## Architecture

Eve is a relay proxy — it delegates all LLM concerns to relayLLM via HTTP/WS proxying and handles local concerns directly.

**Project management is dual-surface.** Eve's `project-dialog.js` and the relay tray's native Projects tab both call the same `Settings.*Project*` mutators in relay, and an edit from either propagates live (relay fans out `onProjectsChanged`). Eve's dialog owns chat templates and project mode; Relay owns models, MCPs (per-tool scoping included), permission policy, hosts, token rotation and Skill regen.

### Communication flow

```
Browser ──WS──►  Eve (ws-handler) ──WS──► relay ──► relay-sessions (sessions, messages, permissions, terminals)
Browser ──WS──►  Eve (ws-handler) ──HTTP─► relay (file routes)      (file ops: console and SSH-host projects)
Eve (relay-file-client.js) ◄──WS /ws/files── relay                  (change events, host status)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay ──► relayLLM           (models, sessions list, generated images)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay                        (projects, MCPs — served by relay)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay ──► relayScheduler     (tasks)
Browser ──WS──►  Eve ──WS──► relay ──► relayScheduler               (task events, forwarded by relay-client.js)
```

Voice does not appear in this diagram — see the Security section above.

### SSH host projects

Design and cross-repo contract: [../relay/docs/ssh-hosts.md](../relay/docs/ssh-hosts.md) — read it first; this is a pointer, not a summary. A project either lives on the console or on one SSH host (`project.hostId`); `ssh_argv` (relay's ready-to-exec ssh prefix) is cached server-side only (`server.js`'s `hostCache`) and never crosses to the browser.

Relay owns the host connection and the file agent that runs on the host; eve never spawns ssh or an agent itself. Eve's whole file plane is one client:

- **`relay-file-client.js`** — `RelayFileClient` and `ProjectFiles`. `ProjectFiles` has `FileService`'s old method surface and return shapes (list, read, write, rename, move, delete, upload, mkdir, stat, search, `openStream`, git) and sends each as a relay file route through `RelayTransport`, for console and host projects alike; relay picks the backend. `RelayFileClient` also holds the one `/ws/files` socket (capped 2–30 s reconnect, ref-counted `watch`/`unwatch`, latest `host_status` per host) and `pasteToHost`. Relay's error codes become the `file_error` texts in one table there. `FileHandlers#fileServiceFor(project)` is `files.forProject(project)`; every file/search/watch call site goes through it.
- **`file-watcher.js`** — fed by the client's `fs_event`/`watch_ok`/`watch_error`: git-change check, ignore list, debounce, then `file_changed`/`dir_changed`/`git_changed`.

Eve has no `fs`, `child_process`, ripgrep or trash call on a project file. Only modules that handle eve's own state (data dir, fd 3, CA file, OS temp dir, plans folder, device log) may require one; epic #310 restates this as a lint rule. Relay enforces containment (`..` refused, symlinks never followed), read-only projects and the `file_op` audit.

### Git changes (Changes tab + diff pane)

Design and pinned contract: [docs/design-git-changes.md](docs/design-git-changes.md). **`git-service.js`** is the one implementation of repo/worktree discovery, porcelain parsing and file versions; its injected `run` is relay's read-only `git` op (`ProjectFiles#_gitRun`), so eve never runs git. Read-only by design. Relay runs git with argv arrays only, `-c core.fsmonitor=false`, scrubbed `GIT_*` env; `repo`/`path` from the browser are untrusted and refs are always server-derived. `file-watcher.js` pushes debounced `git_changed` frames (it lets `.git/index`/`HEAD` through for this purpose only).

### Hidden sessions and iframes

The `__search:` prefix (`HIDDEN_SEARCH_PREFIX` in `search-summarizer.js`) is load-bearing: `routes/index.js` filters it out of `GET /api/sessions`. Any server path that creates a background relay session must use a filtered prefix. It must also call `relayClient.registerHiddenSession(sessionId, handler)` before `joinSession`, or its frames leak into the user's chat.

Project-content iframes (`html-preview-pane.js`, `file-editor.js`) get `sandbox="allow-scripts"` only. Never add `allow-same-origin`; epic #310 restates this as a lint rule.

## Client architecture

Frontend is vanilla JS (no framework, no build step), mid-migration from a legacy orchestrator (`app.js`) to an EventBus + DI-container + StateStore core (`public/core/`). New code: `public/core/` (incl. `layout.js`: wide/regular/compact, push navigation and history, the only writer of tab history), `public/sidebar/` (VS Code-style explorer, incl. `changes-panel.js`), `public/diff-viewer.js` + `panes/diff-pane.js` (Monaco diff pane), `public/dialogs/` (`DialogBase` + shell-launcher/task dialogs). Research answers show their sources through `public/core/sources.js` (pure parser of `brave_web_search` results and 2xx `web_fetch` pages) and `public/citations.js` (source row, citation chips, popover), hooked from `message-renderer.js` ([docs/design-research.md](docs/design-research.md)). Pasted URLs become chips through `public/url-chips.js` (`UrlChips`, on Today's Ask and the chat input) and travel as `urls` through `public/core/source-urls.js`. Legacy still active: `app.js`, `ws-client.js`, `message-dispatcher.js`, `message-renderer.js`, `file-attachment-manager.js`, `modal-manager.js`, `tab-manager.js`, `file-browser.js`, `file-editor.js`, `terminal-manager.js`.

**localStorage keys:** `eve-open-sessions` and `eve-open-files` (24h expiry); `eve-tree-expand` (no TTL); `eve-changes-scope` / `eve-changes-collapsed` / `eve-diff-mode` (Changes tab + diff pane, no TTL); `eve-mode` (Home | Work, `core/mode.js`, no TTL); `eve-ask-model` / `eve-ask-project` (Today's Ask, last model and remembered project pick, no TTL); `eve-last-active` (front door, `core/front-door.js`: epoch ms of the last activity on this device; 60 minutes or more away opens Today, no TTL); `eve-routines-seen` (`today/parts/routines-part.js` — routine runs already seen on this device, so Today marks only unseen ones, no TTL); `eve-session-recents` (`core/session-recents.js` — per-session `{title, lastOpenedAt}` learned from the first user turn and each open; outlives the tab, pruned to 80). Project expand state is read from the DOM at render time, not persisted.

**On the go** (routine-failure notifier and Listen): [docs/design-on-the-go.md](docs/design-on-the-go.md).

**Orientation surfaces** (design rationale: [docs/design-home-and-palette.md](docs/design-home-and-palette.md)): `home-screen.js` renders behind `#welcomeScreen` and is Today's host: the page is independent parts in `public/today/` ([docs/design-today-s1.md](docs/design-today-s1.md)), never one re-render; `dialogs/command-palette.js` is ⌘K. `project-page.js` (a `#project/<id>` main-area tab via `panes/project-pane.js`) holds a project's threads, agents and routines, `routines-page.js` (a `#routines` main-area tab via `panes/routines-pane.js`) lists them across projects with a sheet per routine, `routine-panel.js` turns the active thread into one ([docs/design-routines.md](docs/design-routines.md)), and `agent-board.js` lists live terminals with their last line on Today and on that page ([docs/design-workbench.md](docs/design-workbench.md)); "Ask about this" (`today/ask-about.js`) hands a file, diff or search result to Today's Ask. The Morning brief is `today/brief.js` (pure prompt and parser) plus the `brief` part, a headless routine named `Morning brief` ([docs/design-brief.md](docs/design-brief.md)). A terminal routine with an output file is a custom card: `today/custom-output.js` (pure parser) plus `CustomParts`/`CustomPart` in `today/parts/custom-part.js`, one part per routine ([docs/design-today-custom.md](docs/design-today-custom.md)). Each mode's Ask and voice presets (a `presetFor` label on a chat template of the mode's project) are resolved by `core/mode-presets.js`, which Ask, Settings, the template editor and the `#/voice-chat` Action Button route share ([docs/design-mode-presets.md](docs/design-mode-presets.md)). Session labels everywhere go through `sessionDisplayName()` in `core/ui-utils.js`; project avatar colours through `StateStore.projectColor(id)` (rank-based, not hashed).

**Local server restart**: `server.js` reads `public/index.html` into memory **once at startup**, so an `index.html` edit needs a restart. Other `public/` files reload live. Eve runs as a Relay-managed service (`relay service list` → id `eve`); restart with `npm run relay:restart`.

## Testing

```bash
node --check <file.js>      # THE build gate. There is no compiler.
npm run -s verify:devbox    # devbox world journeys, test machine only (devboxverify/README.md)
```

**No hermetic suite yet.** The Jest unit, integration and visual suites, the Playwright specs and the JS fake relay were removed. Epic #310 replaces them with Playwright specs that each start their own `fakerelay` (relay's repo) and eve, and drive eve only through what a person sees. Until that harness lands, CI runs `node --check` and the PR guards. Devbox world (`devboxverify/`, the `devbox/verify` status check) is unchanged and is the only end-to-end proof.

**Browser-test lock.** `verify:devbox` holds one machine-wide lock (`scripts/browser-lock.js`); a second run waits for it. Don't check for other runs with `pgrep`.

**Local gates** (`.githooks/`, run by the machine's global hooks dispatcher; never set a repo-local `core.hooksPath`, which skips the push guard). `--no-verify` is for the operator in an emergency, never the agent.

- **pre-commit**: on any commit staging `.js`, `.cjs` or `.mjs` files, runs `node --check` on them.
- **pre-push**: on any push whose range touches `.js`, `.cjs` or `.mjs` files, runs `node --check` on them.

Keep fire-and-forget timers `.unref()`'d (see `file-watcher.js`) so a leaked timer can't hold the process open. Full testing guide: [docs/test.md](docs/test.md).

## Patch rules

Rules that make an otherwise-correct patch wrong here.

- **A new call to relay or relayScheduler needs relay's `fakerelay` to serve it.** Epic #310's specs run eve against `fakerelay`, built from the relay commit eve pins. Until that harness lands, the devbox world journeys are the only check that eve and relay agree.

- **Script order in `index.html` is load-bearing** (globals, not modules). If you delete a `<script>` tag, make sure nothing later still references its class.
- **Never weaken or skip a test to go green.** If a test covers code you removed, say so and tighten it rather than deleting the assertion.
- **Don't reformat or restyle code you aren't otherwise changing.**
- **Keep the feature map current.** A change a user would notice in a file matched by a `code` glob in `docs/areas.jsonc` updates the feature map `docs/FEATURES.md` (feature row, journey) in the same PR. Separately, a new tracked file must be added to an area or to `quiet` in `docs/areas.jsonc`; devboxverify runs every journey for a file in neither. Reviewers check it.
- **CRLF files.** `package-lock.json` and five source files are committed with CRLF: `public/tab-manager.js`, `public/file-editor.js`, `public/sidebar-renderer.js`, `routes/index.js`, `ws-handler.js`. `npm install` rewrites the lockfile as LF, and a tool that rewrites a whole file (rather than patching in place) silently converts it to LF. Either one turns a small change into a whole-file diff. Check with `grep -c $'\r' <file>`, and restore with `perl -pi -e 's/\r?\n/\r\n/' <file>`.

## Gotchas

- **Data dir (`./data`).** `auth.json` (WebAuthn enrollment) and `sessions.json` (session tokens) are persisted; `settings.json` is optional and **read-only to Eve** — the operator creates it by hand to override the terminal `claude` path; Eve never writes it. `notifications.jsonl` (routine-failure notifications, 0600, last 200 lines, written by `notifier.js`) is Eve's own. Session data lives in relay-sessions, projects in relay, tasks in relayScheduler.
  `EVE_DATA_DIR` names an isolated instance: every path derives from it or its own env name, and `PORT`, `TTS_PORT`, `STT_PORT` and a relay socket or URL must be set, or eve refuses to start. `--data` keeps the old defaults.
- **Ready file.** Once listening, and after the launch Hello, eve writes `<data dir>/eve-ready.json` (`pid`, `url`, `port`, `httpUrl`, `httpPort`, `dataDir`) by tmp + rename, and removes it on a clean exit. `PORT=0` binds a free port, and the file holds the bound one. Wait on the file, never on a port poll.
- **Voice bypasses relay entirely.** `tts-service.js` / `stt-service.js` are raw TCP clients to `127.0.0.1:TTS_PORT`/`STT_PORT` (relayTTS/relaySTT daemons) — no `RelayTransport`, no bearer token, no cert verification. They are loopback-only by construction (hardcoded `127.0.0.1`), which is what makes the lack of auth acceptable; don't parameterize the host without adding auth.
- **Reconnection.** A browser reconnect spawns a fresh `RelayClient`, with a fresh upstream connection — relayLLM's per-connection subscription state (joined sessions, etc.) starts empty either way. But the upstream leg of an *existing* `RelayClient` also self-heals on its own, with capped backoff (`relay-client.js#_scheduleUpstreamReconnect`), independent of the browser socket — relay's own pong timeout or a relayLLM restart behind it can drop and restore it without the browser ever seeing a close; see `relay_status` in docs/api.md. The secondary relayScheduler `/ws/tasks` connection (`relay-client.js#_connectScheduler`) self-heals the same way.
- **Permission auto-approval** is governed by the session/project permission mode (`bypassPermissions` = all tools, `acceptEdits` = file writes) — there is no per-connection `alwaysAllow` flag.
- **Chat defaults are client-side and per provider.** Every web/voice chat launch (form, template, a mode's voice preset) goes through `ShellLauncherDialog#_launchSession`, which applies `applyChatDefaults`: non-Claude models get `settings.useRelayTools` + `appendClaudeMd`, Claude and unknown models get neither. There is no per-chat or per-template toggle. Hidden sessions (search summarizer, module invoker) never pass through it.
- **Relay disconnection** — every project file operation goes through relay, so file ops fail with "Relay is not reachable" while relay is down (the `/ws/files` socket reconnects by itself, re-sending `watch` for each watched project, with no catch-up for changes missed). Terminal-UI ops are local; session state lives in relay-sessions, so the sidebar persists across a relay drop.

## Ecosystem

- `../relay/` — orchestrator; runs Eve as a managed service and fronts all relay-proxied backend traffic.
- `../relayLLM/` — model host (llama.cpp / MLX / OpenAI-compatible routing), reached through relay. Sessions, terminals and the permission hook live in relay-sessions (`../relay/cmd/relaysessions`, see `../relay/docs/session-host.md`).
- `../relayScheduler/` — task scheduler; reached via relay's `/api/tasks` HTTP dispatch and relay's `/ws/tasks` WS route (both still through `RelayTransport`, not a separate egress).
- `../relayComfy/` — ComfyUI service for image/video generation (relayLLM proxies generated images from it; see `public/message-renderer.js`).
- `../relayClient/` — iOS native app (WKWebView) using the Safari passkey fallback above.
- `../relayTTS/` — local TTS daemon; `tts-service.js` talks to it directly over loopback TCP (`TTS_PORT`, default 9997), not through relay.
- `../relaySTT/` — local STT daemon; `stt-service.js` talks to it the same way (`STT_PORT`, default 9998).
