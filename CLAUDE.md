# Eve Workspace — AI Assistant Context

Browser-based LLM frontend that proxies all LLM concerns to [relayLLM](https://github.com/barelyworkingcode/relayLLM) through the `relay` orchestrator. Eve owns local concerns: UI, file browsing/editing, terminals (proxied), voice, and authentication.

Vanilla JS, **no bundler, no build step, no modules**: `public/index.html` loads plain `<script>` tags in dependency order and every class lands on `window`. Node/Express backend at the repo root.

**See also**: [docs/learned.md](docs/learned.md) (pitfalls/patterns) · [docs/api.md](docs/api.md) (HTTP/WS protocol) · [docs/authentication.md](docs/authentication.md) (security model).

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

**Project management is dual-surface.** Eve's `project-dialog.js` and the relay tray's native Projects tab both call the same `Settings.*Project*` mutators in relay, and an edit from either propagates live (relay fans out `onProjectsChanged`). Eve's dialog owns chat templates and permission policy; the relay tray owns per-tool MCP scoping, token rotation, and Skill regen.

### Communication flow

```
Browser ──WS──►  Eve (ws-handler) ──WS──► relay ──► relayLLM       (sessions, messages, permissions, terminals)
Browser ──WS──►  Eve (ws-handler) ──local─► FileService            (file ops)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay ──► relayLLM           (models, sessions list, generated images)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay                        (projects, MCPs — served by relay)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay ──► relayScheduler     (tasks)
Browser ──WS──►  Eve ──WS──► relay ──► relayScheduler               (task events, forwarded by relay-client.js)
```

Voice does not appear in this diagram — see the Security section above.

### SSH host projects

Design and cross-repo contract: [../relay/docs/ssh-hosts.md](../relay/docs/ssh-hosts.md) — read it first; this is a pointer, not a summary. A project either lives on the console or on one SSH host (`project.hostId`); `ssh_argv` (relay's ready-to-exec ssh prefix) is cached server-side only (`server.js`'s `hostCache`) and never crosses to the browser.

- **`ssh-command.js`** — the one Node implementation of relay's `RemoteCommand`/launcher derivation (`remoteCommand`, `nodeLauncher`), pinned byte-for-byte against the doc's Fixtures.
- **`remote-fs-agent.js`** — the file-plane agent that runs *on the host*, launched via `nodeLauncher`. Self-contained (Node core only, no `require` of any eve module) since it ships as raw source, not a module.
- **`ssh-host-pool.js`** — `HostPool`/`HostAgent`: spawns and reconnects the agent over `ssh_argv`, JSON-lines request/response, ref-counted `watch`/`unwatch`, emits `status` (`connecting|connected|unreachable`) fanned out to browsers as the WS `host_status` frame.
- **`remote-file-service.js`** — `RemoteFileService`, the same method surface as `FileService` but backed by a `HostAgent`. `FileHandlers#fileServiceFor(project)` picks local vs. remote; every file/search/watch call site goes through it.

## Module architecture

Full reference: [docs/modules.md](docs/modules.md). Quick contract for AI work in this area.

**What a module is** — a folder `<project>/modules/<name>/` with `module.json` + static HTML/CSS/JS, loaded into Eve's document area in an iframe with `sandbox="allow-scripts"` (NO `allow-same-origin`; opaque origin). The page loads `/eve-module-sdk.js` exposing `window.eve` with `invokeAI`, `readFile`, `writeFile`, `getManifest`.

**Two independent trust boundaries**
- `permissions.files` — what the iframe SDK can read/write. Exact paths only, server-validated on every call (`module-service.js#isFilePermitted`).
- `permissions.tools` — what tools the LLM may call during `invokeAI` (default `[]`). When set, `ModuleInvoker._createHiddenSession()` passes `settings.useRelayTools: true` and `permissionPolicy: { allowedTools, defaultMode: 'bypassPermissions' }`. Eve passes **no** project token — relay brokers it. Bypass mode is required because the orb has no UI to answer prompts. Tools see the whole project dir — no per-tool path scoping.

**Load-bearing invariants**
1. **Scope is server-derived, never client-derived.** `projectId` + `moduleName` come from the host's WeakMap (browser, `module-host.js`: `event.source === iframe.contentWindow`) or the authenticated WS session re-validated against the manifest (server). An AI-authored iframe cannot lie about what it is.
2. **Manifest is re-read on every gated call** — it's a file an AI can rewrite between calls. Don't cache `permissions.files`.
3. **`__module:` session-name prefix is load-bearing** (`HIDDEN_SESSION_PREFIX` in `module-invoker.js`; imported by `routes/index.js` for the session-list filter; checked in `relay-client.js`). Any new module-session path must use this prefix AND `relayClient.registerModuleSession(...)` BEFORE joining, or events leak into the user's chat.
4. **Iframe sandbox is load-bearing.** Never add `allow-same-origin`.
5. **File MIME allowlist is load-bearing** — `SERVE_MIME` in `routes/modules.js` is the only set the static serve returns; dotfiles denied.
6. **Single-responsibility split** — AI invoke in `module-invoker.js`, file r/w in `ws/module-messages.js`, static serve in `routes/modules.js`. Don't add a third file-permission gate.

## Client architecture

Frontend is vanilla JS (no framework, no build step), mid-migration from a legacy orchestrator (`app.js`) to an EventBus + DI-container + StateStore core (`public/core/`). New code: `public/core/`, `public/sidebar/` (VS Code-style explorer), `public/dialogs/` (`DialogBase` + shell-launcher/task dialogs). Legacy still active: `app.js`, `ws-client.js`, `message-dispatcher.js`, `message-renderer.js`, `file-attachment-manager.js`, `modal-manager.js`, `tab-manager.js`, `file-browser.js`, `file-editor.js`, `terminal-manager.js`.

**localStorage keys:** `eve-open-sessions` and `eve-open-files` (24h expiry); `eve-tree-expand` (no TTL); `eve-session-recents` (`core/session-recents.js` — per-session `{title, lastOpenedAt}` learned from the first user turn and each open; outlives the tab, pruned to 80). Project expand state is read from the DOM at render time, not persisted.

**Orientation surfaces** (design rationale: [docs/design-home-and-palette.md](docs/design-home-and-palette.md)): `home-screen.js` renders behind `#welcomeScreen`; `dialogs/command-palette.js` is ⌘K. Session labels everywhere go through `sessionDisplayName()` in `core/ui-utils.js`; project avatar colours through `StateStore.projectColor(id)` (rank-based, not hashed).

**Local server restart**: `server.js` reads `public/index.html` into memory **once at startup**, so an `index.html` edit needs a restart. Other `public/` files reload live. Eve runs as a Relay-managed service (`relay service list` → id `eve`); restart with `npm run relay:restart`.

## Testing

```bash
node --check <file.js>    # THE build gate. There is no compiler.
npm test                  # unit (hermetic, no external deps). Must stay green.
npm run test:integration  # integration tier
npm run test:e2e          # Playwright end-to-end. Must stay green.
```

```
test/
  setup.js          - setupFilesAfterEach: force-restores real timers after every test
                      (works around a Jest 30 + Node bug where useRealTimers() leaves
                      setTimeout/clearTimeout undefined)
  unit/             - pure logic, no external deps
  integration/      - cross-module / transport
  e2e/              - Playwright (browser)
  visual/           - pixel-diff baselines (pre-push only, not in test:e2e)
```

**Local gates** (`.githooks/`; install once: `git config core.hooksPath .githooks`). `--no-verify` is for the operator in an emergency, never the agent.

- **pre-commit** — on any commit staging `.js` / `jest.config.js` / `package.json`, runs `node --check` on staged JS then the unit suite.
- **pre-push** — on any push whose range touches `.js` / `.css` / `.html` / test config, runs unit, integration, e2e and visual. The unit tier alone cannot see the frozen behavioural gates — the chat input row, the voice drawer, the pane characterisation suite, two-connection WebSocket isolation, the pixel baselines — which is the tier where regressions in this codebase actually surface. `test:voice` is excluded from both gates: it needs the live voice daemons, so it would fail whenever they are down.

When using `jest.useFakeTimers()`, you don't need to restore manually — `test/setup.js` does. Keep fire-and-forget timers `.unref()`'d (see `file-watcher.js`) so a leaked timer can't hang a worker on teardown. Full testing guide: [docs/test.md](docs/test.md).

## Patch rules

Rules that make an otherwise-correct patch wrong here.

- **Script order in `index.html` is load-bearing** (globals, not modules). If you delete a `<script>` tag, make sure nothing later still references its class.
- **Never weaken or skip a test to go green.** If a test covers code you removed, say so and tighten it rather than deleting the assertion.
- **Don't reformat or restyle code you aren't otherwise changing.**
- **CRLF files.** `package-lock.json` and five source files are committed with CRLF: `public/tab-manager.js`, `public/file-editor.js`, `public/sidebar-renderer.js`, `routes/index.js`, `ws-handler.js`. `npm install` rewrites the lockfile as LF, and a tool that rewrites a whole file (rather than patching in place) silently converts it to LF. Either one turns a small change into a whole-file diff. Check with `grep -c $'\r' <file>`, and restore with `perl -pi -e 's/\r?\n/\r\n/' <file>`.

## Gotchas

- **Data dir (`./data`).** `auth.json` (WebAuthn enrollment) and `sessions.json` (session tokens) are persisted; `settings.json` is optional and **read-only to Eve** — the operator creates it by hand to override the terminal `claude` path; Eve never writes it. All session/project/task data lives in relayLLM.
- **Voice bypasses relay entirely.** `tts-service.js` / `stt-service.js` are raw TCP clients to `127.0.0.1:TTS_PORT`/`STT_PORT` (relayTTS/relaySTT daemons) — no `RelayTransport`, no bearer token, no cert verification. They are loopback-only by construction (hardcoded `127.0.0.1`), which is what makes the lack of auth acceptable; don't parameterize the host without adding auth.
- **Reconnection.** A browser reconnect spawns a fresh `RelayClient`, with a fresh upstream connection — relayLLM's per-connection subscription state (joined sessions, etc.) starts empty either way. But the upstream leg of an *existing* `RelayClient` also self-heals on its own, with capped backoff (`relay-client.js#_scheduleUpstreamReconnect`), independent of the browser socket — relay's own pong timeout or a relayLLM restart behind it can drop and restore it without the browser ever seeing a close; see `relay_status` in docs/api.md. The secondary relayScheduler `/ws/tasks` connection (`relay-client.js#_connectScheduler`) self-heals the same way.
- **Permission auto-approval** is governed by the session/project permission mode (`bypassPermissions` = all tools, `acceptEdits` = file writes) — there is no per-connection `alwaysAllow` flag.
- **Relay disconnection** — file and terminal-UI ops keep working (local); session state lives in relayLLM, so the sidebar persists across a relay drop.

## Ecosystem

- `../relay/` — orchestrator; runs Eve as a managed service and fronts all relay-proxied backend traffic.
- `../relayLLM/` — LLM engine; Eve's backend for session/model/permission ops and generated images (`/api/generated/`), reached through relay.
- `../relayScheduler/` — task scheduler; reached via relay's `/api/tasks` HTTP dispatch and relay's `/ws/tasks` WS route (both still through `RelayTransport`, not a separate egress).
- `../relayComfy/` — ComfyUI service for image/video generation (relayLLM proxies generated images from it; see `public/message-renderer.js`).
- `../relayClient/` — iOS native app (WKWebView) using the Safari passkey fallback above.
- `../relayTTS/` — local TTS daemon; `tts-service.js` talks to it directly over loopback TCP (`TTS_PORT`, default 9997), not through relay.
- `../relaySTT/` — local STT daemon; `stt-service.js` talks to it the same way (`STT_PORT`, default 9998).
