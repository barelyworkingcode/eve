# Eve Workspace — AI Assistant Context

Browser-based LLM frontend that proxies all LLM concerns to [relayLLM](https://github.com/barelyworkingcode/relayLLM) through the `relay` orchestrator. Eve owns local concerns: UI, file browsing/editing, terminals (proxied), voice, and authentication.

**See also**: [docs/learned.md](docs/learned.md) (pitfalls/patterns) · [docs/api.md](docs/api.md) (HTTP/WS protocol) · [docs/authentication.md](docs/authentication.md) (security model).

> General engineering standards (DRY, error handling, naming, commit hygiene, etc.) follow the global guidelines — not repeated here. This file is **eve-specific**: architecture, contracts, and the non-obvious gotchas.

## Security (eve-specific rules)

- **Never read `Host` or `X-Forwarded-For` for authorization.** Both are attacker-controllable off-loopback. The only safe network-layer identity is `req.socket.remoteAddress`. An earlier "localhost bypass" trusted `req.headers.host` and was a full auth bypass — see [docs/security-review-auth-transport.md](docs/security-review-auth-transport.md) for the cautionary tale and the replacement.
- **All network-trust logic goes through `TrustedNetworkService`** (single responsibility, DI-injected from `server.js`). No ad-hoc IP/hostname checks in route handlers.
- **All egress goes through `RelayTransport`.** No raw `fetch()` / `new WebSocket()` to relay anywhere. `relayTransport.assertStartupConfig()` hard-fails on any insecure config — never add a "skip-verify"/downgrade flag.

### Security model (two boundaries)

Full design & verification: [docs/security-review-auth-transport.md](docs/security-review-auth-transport.md). Operator reference: [docs/authentication.md](docs/authentication.md).

1. **Browser ↔ Eve** — WebAuthn passkey + 256-bit session token (`X-Session-Token` header / `{type:'auth'}` WS frame); IP-based trusted-subnet bypass via `TrustedNetworkService` (`req.socket.remoteAddress` only).
2. **Eve ↔ relay** — Eve dials relay's **frontend** Unix socket (`RELAY_FRONTEND_SOCKET`, mode `0600`) with a bearer token (`RELAY_FRONTEND_TOKEN`), both injected by relay at spawn. Eve never reaches relayLLM directly: relay authenticates the frontend token, then reverse-proxies onward to relayLLM (sessions/models/permissions) or relayScheduler (tasks) over each service's own internal socket + token. TCP fallback (`RELAY_FRONTEND_URL`, optional internal CA via `RELAY_FRONTEND_CA`) requires `https://` + cert verification.

Per-project policy relayLLM can't see is enforced at relay: the `allowed_models` allowlist is checked on `POST /api/sessions` by `../relay/frontend_model_guard.go` (`allowed_mcp_ids` is enforced at the bridge — see `../relay/README.md`). Any change to the token contract must touch the cross-repo pieces in lockstep: Eve's `relay-transport.js`; relay's `frontend_server.go` + `frontend_dispatcher.go` + `enhanced_services.go`; relayLLM's `auth.go` + `main.go`; credential provisioning in `../relay/service_registry.go`.

**iOS native app (`../relayClient`)**: WKWebView blocks WebAuthn for local hostnames. Eve serves a Safari-based fallback passkey page at `/api/auth/safari-login`; the iOS `SafariAuthPlugin` opens it via `ASWebAuthenticationSession` and gets the token back via the `relayclient://auth-callback?token=...` scheme. See [docs/authentication.md](docs/authentication.md).

## Architecture

Eve is a relay proxy — it delegates all LLM concerns to relayLLM via HTTP/WS proxying and handles local concerns directly.

**Project management is dual-surface.** Eve's `project-dialog.js` and the relay tray's native Projects tab are co-equal — both call the same `Settings.*Project*` mutators in relay, and an edit from either propagates live (relay fans out `onProjectsChanged`). Eve's dialog owns chat templates and permission policy; the relay tray owns per-tool MCP scoping, token rotation, and Skill regen. No eve code change needed to coexist. See `../relay/docs/decisions/004-project-mgmt-in-relay.md`.

### Communication flow

```
Browser ──WS──►  Eve (ws-handler) ──WS──► relay ──► relayLLM       (sessions, messages, permissions, terminals)
Browser ──WS──►  Eve (ws-handler) ──local─► FileService            (file ops)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay ──► relayLLM           (models, sessions list, generated images)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay                        (projects, MCPs — served by relay)
Browser ──HTTP─► Eve (routes) ──HTTP─► relay ──► relayScheduler     (tasks)
Browser ──WS──►  Eve ──WS──► relay ──► relayScheduler               (task events, forwarded by relay-client.js)
```

### Core components (server)

- `server.js` — Express + WS setup, relay config, project cache, shutdown.
- `ws-handler.js` — WebSocket dispatch: relay ops → `RelayClient`; local ops → file/terminal/search/module/voice handlers. Terminal ops are proxied to relayLLM.
- `relay-client.js` — one WS bridge to relayLLM (via relay's frontend) per browser connection; `moduleSessions` registry intercepts module session frames. Also opens a second upstream to relayScheduler's `/ws/tasks` (`_connectScheduler`, capped-backoff reconnect) and forwards task lifecycle events to the browser.
- `relay-transport.js` — the single HTTP/WS egress to relay's frontend (socket or TCP, bearer auth). `fetch()` for JSON, `fetchRaw()` for binary.
- `routes/index.js` — HTTP proxy to relay's frontend (models, sessions, tasks, generated images; projects/MCPs served by relay) + filters `__module:` sessions out of `GET /api/sessions`.
- `routes/auth.js` — WebAuthn enrollment/login + Safari fallback page.
- `slash-command-handler.js` — local `/clear`, `/help`, `/zsh`, `/bash`, `/claude`.
- `auth.js` / `session-store.js` — WebAuthn service + session-token persistence.
- `file-service.js` / `file-handlers.js` / `file-watcher.js` — path-validated file CRUD, WS adapter, change events.

### Key patterns

- **Relay proxy.** One `RelayClient` per browser WS. It connects to relayLLM (via relay), forwards session/message/permission ops browser→relayLLM, forwards events relayLLM→browser, and caches the session directory for local slash commands.
- **Session lifecycle.** Client `create_session` → Eve POSTs relay `/api/sessions` → `session_created` to browser + join on relay WS → messages flow browser→Eve→relayLLM→provider.
- **Project cache.** Eve caches relayLLM project data in `projectCache` (Map) for file-handler path resolution; refreshed on project-list fetch and after mutations.

## Module architecture

Full reference: [docs/modules.md](docs/modules.md). Quick contract for AI work in this area.

**What a module is** — a folder `<project>/modules/<name>/` with `module.json` + static HTML/CSS/JS, loaded into Eve's document area in an iframe with `sandbox="allow-scripts"` (NO `allow-same-origin`; opaque origin). The page loads `/eve-module-sdk.js` exposing `window.eve` with `invokeAI`, `readFile`, `writeFile`, `getManifest`.

**Two independent trust boundaries**
- `permissions.files` — what the iframe SDK can read/write. Exact paths only, server-validated on every call.
- `permissions.tools` — what tools the LLM may call during `invokeAI` (default `[]`). When set, `ModuleInvoker._createHiddenSession()` passes `settings.useRelayTools: true` and `permissionPolicy: { allowedTools, defaultMode: 'bypassPermissions' }`. Eve passes **no** project token — relay brokers it (relayLLM resolves the project-scoped token just-in-time by `projectId`; Eve only references the project by id). Bypass mode is required because the orb has no UI to answer prompts. Tools see the whole project dir — no per-tool path scoping.

**Server-side files** — `module-service.js` (manifest schema/validation, `MODULE_NAME_RE`, `resolveModuleFile`, `isFilePermitted`); `module-invoker.js` (streaming AI invoke; owns `HIDDEN_SESSION_PREFIX`; creates the ephemeral `__module:` session, forwards events as `module_ai_event`, deletes it in `finally`); `routes/modules.js` (`GET /api/modules`, manifest, static serve — AI invoke is WS-only); `ws-handler.js` (`module_invoke_ai`, `module_ai_stop`, `module_read_file`/`module_write_file` — re-validates the manifest every call); `relay-client.js` (`moduleSessions` interception).

**Client-side files** — `public/modules/module-host.js` (iframe lifecycle + postMessage bridge; authenticates via `event.source === iframe.contentWindow` WeakMap; host injects scope, iframe never sends it); `public/modules/module-activity-orb.js` (orb + event-log dialog); `public/eve-module-sdk.js` (postMessage wrapper); `public/modules/module-store.js`; `public/sidebar/project-panel.js` (Modules section, `_renderModulesContent`); `public/app.js#_startModuleBuilder` (builder prompt from `public/modules/module-builder-prompt.md`).

**Load-bearing invariants**
1. **Scope is server-derived, never client-derived.** `projectId` + `moduleName` come from the host's WeakMap (browser) or the authenticated WS session re-validated against the manifest (server). An AI-authored iframe cannot lie about what it is.
2. **Manifest is re-read on every gated call** — it's a file an AI can rewrite between calls. Don't cache `permissions.files`.
3. **`__module:` session-name prefix is load-bearing** (`HIDDEN_SESSION_PREFIX` in `module-invoker.js`; imported by `routes/index.js` for the session-list filter; checked in `relay-client.js`). Any new module-session path must use this prefix AND `relayClient.registerModuleSession(...)` BEFORE joining, or events leak into the user's chat.
4. **Iframe sandbox is load-bearing.** Never add `allow-same-origin`.
5. **File MIME allowlist is load-bearing** — `SERVE_MIME` in `routes/modules.js` is the only set the static serve returns; dotfiles denied.
6. **Single-responsibility split** — AI invoke in `module-invoker.js`, file r/w in `ws-handler.js`, static serve in `routes/modules.js`. Don't add a third file-permission gate.

## Client architecture

Frontend is vanilla JS (no framework, no build step), mid-migration from a legacy orchestrator (`app.js`) to an EventBus + DI-container + StateStore core (`public/core/`). New code: `public/core/` (event-bus, container, state-store, api-client, constants, ui-utils), `public/sidebar/` (VS Code-style explorer), `public/dialogs/` (`DialogBase` + shell-launcher/task dialogs). Legacy still active: `app.js`, `ws-client.js`, `message-dispatcher.js`, `message-renderer.js`, `file-attachment-manager.js`, `modal-manager.js`, `tab-manager.js`, `file-browser.js`, `file-editor.js`, `terminal-manager.js`.

**localStorage keys:** `eve-open-sessions` and `eve-open-files` (24h expiry); `eve-tree-expand` (no TTL). Project expand state is read from the DOM at render time, not persisted.

### Local server restart (index.html is cached at startup)

`server.js` reads `public/index.html` into memory **once at startup** (`INDEX_HTML_RAW`) and serves a cache-busted copy; the CSP hashes for inline bootstrap scripts are also computed once. Therefore:

- **Editing existing JS/CSS** (`app.js`, a backend module, a stylesheet) needs **no restart** — `express.static` serves them fresh and the per-restart `?rnd=` token busts the browser cache.
- **Editing `index.html`** — adding/removing a `<script>`/`<link>` or changing an inline bootstrap script — **requires a restart**. Otherwise the browser runs fresh JS against the stale shell and a newly-referenced global is undefined (`ReferenceError`), even though the file serves 200. (This bit us adding `voice-crash-guard.js`.)

Eve runs as a Relay-managed service (`relay service list` → id `eve`). Restart with `npm run relay:restart`.

## Testing

```bash
npm test                  # unit (fast, hermetic, no external deps)
npm run test:integration  # integration tier
npm run test:e2e          # Playwright end-to-end
```

```
test/
  setup.js          - setupFilesAfterEach: force-restores real timers after every test
                      (works around a Jest 30 + Node bug where useRealTimers() leaves
                      setTimeout/clearTimeout undefined)
  unit/             - pure logic, no external deps
  integration/      - cross-module / transport
  e2e/              - Playwright (browser)
```

**Pre-commit hook** (`.githooks/pre-commit`; install once: `git config core.hooksPath .githooks`). On any commit staging `.js` / `jest.config.js` / `package.json`, it runs `node --check` on staged JS (the "build" gate — Eve has no bundler) then the unit suite (~5s, hermetic). Skip in emergencies with `--no-verify`.

When using `jest.useFakeTimers()`, you don't need to restore manually — `test/setup.js` does. Keep fire-and-forget timers `.unref()`'d (see `file-watcher.js`) so a leaked timer can't hang a worker on teardown. Full testing guide: [docs/test.md](docs/test.md).

## Gotchas

- **Data dir (`./data`).** `auth.json` (WebAuthn enrollment) and `sessions.json` (session tokens) are persisted; `settings.json` is optional and **read-only to Eve** — the operator creates it by hand to override the terminal `claude` path; Eve never writes it. All session/project/task data lives in relayLLM.
- **Reconnection.** The primary relayLLM session WS does **not** auto-reconnect — a browser reconnect spawns a fresh `RelayClient`. The secondary relayScheduler `/ws/tasks` connection **does** self-heal with capped backoff.
- **Permission auto-approval** is governed by the session/project permission mode (`bypassPermissions` = all tools, `acceptEdits` = file writes) — there is no per-connection `alwaysAllow` flag.
- **Relay disconnection** — file and terminal-UI ops keep working (local); session state lives in relayLLM, so the sidebar persists across a relay drop.
- **What lives where** — Eve: file browser, auth, UI serving, local slash commands, voice. relayLLM: providers, sessions, projects, tasks, permissions, model routing, the terminal PTYs.

## Ecosystem

- `../relay/` — orchestrator; runs Eve as a managed service and fronts all backend traffic.
- `../relayLLM/` — LLM engine; Eve's backend for session/model/permission ops and generated images (`/api/generated/`), reached through relay.
- `../relayScheduler/` — task scheduler; reached via relay's `/api/tasks` dispatch.
- `../relayComfy/` — ComfyUI service for image/video generation (relayLLM proxies generated images from it).
- `../relayClient/` — iOS native app (WKWebView) using the Safari passkey fallback above.
