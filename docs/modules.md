# Modules

A **module** is a small, AI-backed mini-app that lives in a project at `<project>/modules/<name>/` and runs as a sandboxed page in Eve's document area. Modules are static HTML/CSS/JS plus a manifest; they reach Claude (and a whitelist of project files) through a tiny `window.eve` SDK.

Modules are intended to be **authored by Claude on request**. The user clicks **+ New Module** in a project's Modules section, describes what they want, and Claude scaffolds the files. They then render in the sidebar under that project and open as tabs.

## Directory layout

```
<project-root>/
  modules/
    <module-name>/
      module.json          ← manifest (required)
      index.html           ← entry page (default)
      ...                  ← any other assets the page uses
```

Folder names must match `^[a-z0-9][a-z0-9_-]*$` (`MODULE_NAME_RE` in `module-service.js`). The folder name is the canonical module name — `module.json#name` is ignored and overwritten on load; if present it must equal the folder name or validation fails.

A module with a broken or missing manifest still appears in the sidebar tagged `broken: true` so it's discoverable rather than silently dropped (`ModuleService.listModules`).

## Manifest format (`module.json`)

```json
{
  "displayName": "Todo List",
  "entry": "index.html",
  "model": "claude-haiku-4-5",
  "permissions": {
    "files": ["todo.md", "todo.cache.json"],
    "tools": ["Read", "Grep", "Glob"]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `displayName` | yes | Non-empty string. Shown in the sidebar. |
| `entry` | no | Defaults to `index.html`. Must end in `.html`, no `..`, no leading `/`. |
| `model` | no | Preferred model for `invokeAI`. Falls back to manifest-less default. |
| `permissions.files` | no | Exact **project-relative** paths the iframe SDK may read/write. No `..`, no leading `/`, no globs. |
| `permissions.tools` | no | Tool names the LLM may call during `invokeAI`. Default `[]` (tool-less). See trust boundaries. |
| `name` | — | Do not set; the folder name always wins. |

### Two trust boundaries

Modules gate two different actors with two independent lists:

- **`permissions.files`** — what the **iframe SDK** (`eve.readFile`/`eve.writeFile`) may touch. Bounded to the listed paths. The iframe JS is AI-authored; this is the boundary that keeps a misbehaving module off arbitrary files.
- **`permissions.tools`** — what tools the **LLM** may call during `invokeAI`. Tools like `Read`/`Grep`/`Glob` see the **whole project directory**, not just `permissions.files` — there is no per-tool path scoping. Once you grant `Read`, the model can read any file in the project.

For the typical case — a module that manipulates a fixed set of files — leave `permissions.tools` unset and use `eve.readFile`/`eve.writeFile` with `permissions.files`. That keeps the LLM tool-less and the iframe tightly scoped. Grant `Bash`/`Task`/`WebFetch` only if you trust the (AI-authored) manifest as much as your own code.

**Backend asymmetry for `permissions.tools`:**

- For Claude Code, relay filters tool visibility by `allowedTools` — the model only sees the whitelisted tools.
- For llama-cpp / pi / OpenAI-compatible backends, relayLLM injects its full MCP tool list regardless of `allowedTools`. The system prompt names the permitted tools so the model knows which to use, but module sessions run `defaultMode: 'bypassPermissions'` (the orb has no UI to answer prompts), so the whitelist is advisory at the protocol layer for these backends. Treat `permissions.tools` as the **honest contract** of what the module needs; do not rely on it as a hard sandbox for non-Claude backends.

## The `window.eve` SDK

Every module entry page loads:

```html
<script src="/eve-module-sdk.js"></script>
```

```js
// Invoke an AI prompt. Returns parsed JSON if `schema` is set, else raw text.
await window.eve.invokeAI({
  prompt: "Parse todo.md as a JSON array of {id, text, complete}.",
  files: ["todo.md"],        // inlined server-side; must be in permissions.files
  schema: { type: "array", items: { /* ... */ } }, // optional; forces JSON-only output
  model: "claude-haiku-4-5", // optional; overrides manifest.model
  timeoutMs: 5 * 60 * 1000,  // optional; default 5 min
});

const text = await window.eve.readFile("todo.md");   // path must be in permissions.files
await window.eve.writeFile("todo.md", newText);
const manifest = await window.eve.getManifest();      // public projection
```

All four return promises and reject with a clear `Error` on permission denial, missing file, AI timeout, or schema-parse failure.

The SDK never sends `projectId`/`moduleName` over the wire. The parent (`ModuleHost`) authenticates each call by matching `event.source` against the iframe's `contentWindow`, then looks up scope from a `WeakMap` (`public/modules/module-host.js`). An AI-authored module **cannot** lie about which project or module it is.

## Sandbox & security model

The iframe is created with `sandbox="allow-scripts"` only — **no `allow-same-origin`** (`module-host.js`). Consequences:

- Opaque origin (`null`). `postMessage` origin checks therefore use `*`; trust is `event.source === iframe.contentWindow`, which can't be spoofed.
- No access to Eve's cookies, `localStorage`, IndexedDB, or DOM.
- No outbound `fetch()` to arbitrary URLs. All I/O goes through `window.eve`.

Static serving (`GET /api/modules/serve/:projectId/:moduleName/*`, `routes/modules.js`) is hardened against:

- **Path traversal** — resolved paths must stay inside the module folder (`resolveModuleFile`).
- **Symlink escape** — `fs.realpath` on both candidate and module root.
- **Disallowed MIME types** — only the extensions in `SERVE_MIME` (HTML/CSS/JS/JSON/images/fonts/text) are served; anything else 415s.
- **Dotfiles** — explicit `dotfiles: 'deny'` on `sendFile`.

The serve route sets `X-Content-Type-Options: nosniff` so the browser won't MIME-sniff AI-authored assets. **Framing** is denied by `X-Frame-Options: SAMEORIGIN`, set globally by `security-headers.js`; `frame-ancestors 'none'` is part of the app-shell CSP (applied only to the main HTML document, not to module-served files).

## AI invocation flow

`invokeAI` is **WebSocket-driven and streaming**. The SDK postMessages `ModuleHost`, which authenticates the call and sends a `module_invoke_ai` frame over Eve's existing browser↔server WS. The server (`ModuleInvoker.invoke`) then:

1. Reloads and re-validates the manifest from disk; denies any `files` entry not in `permissions.files`.
2. Reads the requested files server-side and inlines them in the system prompt (so plain reads need no tool access).
3. Resolves the model: explicit `model` arg → manifest `model` → `project.allowedModels[0]`.
4. Creates an **ephemeral hidden relayLLM session** named `__module:<moduleName>:<random-hex>` (`POST /api/sessions`). If `permissions.tools` is non-empty, the session is created with `settings: { useRelayTools: true, permissionPolicy: { allowedTools, defaultMode: 'bypassPermissions' } }`. **Eve passes no MCP token** — it references the project by id; relay/relayLLM resolve the project-scoped token just-in-time. Eve never handles the secret. (If `permissions.tools` is set but the project has no id, the invocation throws before session creation.)
5. Registers a handler on the per-connection `RelayClient` (`registerModuleSession`) so relay frames tagged with the hidden sessionId are intercepted before the regular dispatch can treat them as an unknown background session and buffer them.
6. `joinSession` + `sendMessage` over the relay WS. As frames arrive, the handler forwards each to the browser as `module_ai_event`, accumulates assistant text, and on `message_complete` resolves with the full text + (if `schema` was set) parsed JSON.
7. Deletes the ephemeral session in a `finally` block (best-effort) regardless of outcome.

A failed `message_complete`, a relay `error`, or the 5-minute wall-clock cap (`RELAY_TIMEOUT_MS`) rejects the invocation; the WS wrapper emits `module_ai_failed` instead of leaking a session.

### Browser ↔ Eve WS protocol

| Direction | Type | Payload |
|---|---|---|
| client→server | `module_invoke_ai` | `{ requestId, projectId, moduleName, prompt, files?, schema?, model? }` |
| client→server | `module_ai_stop` | `{ requestId }` — cancels via `stop_generation` on the hidden session |
| server→client | `module_ai_started` | `{ requestId, projectId, moduleName, sessionId, model }` |
| server→client | `module_ai_event` | `{ requestId, sessionId, event }` — `event` is the raw relayLLM frame |
| server→client | `module_ai_completed` | `{ requestId, sessionId, result, rawText, model }` |
| server→client | `module_ai_failed` | `{ requestId, error, deniedFiles? }` |

`requestId` is generated browser-side by `ModuleHost` and is unique per in-flight invocation. `ModuleHost`'s client timeout is 6 minutes — just past the server's 5-minute cap — so the structured server-side failure surfaces first.

### Activity orb

A pulsing orb (`public/modules/module-activity-orb.js`) appears lower-right whenever any module invocation is in flight, with a count badge for two or more. Clicking it opens a read-only event-log dialog (per-invocation: module, model, hidden session id, elapsed time, a live `llm_event` summary list, a Stop button, and the final result once `module_ai_completed` lands).

### Hidden session contract

Hidden module sessions are filtered out at two places:

- `GET /api/sessions` (`routes/index.js`) drops anything whose `name` starts with `__module:` before returning to the browser.
- `RelayClient` intercepts every relay-WS message whose `sessionId` is in its `moduleSessions` map — it never reaches the browser as a regular `llm_event`/`message_complete`.

The prefix `HIDDEN_SESSION_PREFIX` is defined in `module-invoker.js`; `routes/index.js` imports it. Both move in lockstep.

## Server-side file ops (`readFile`/`writeFile`)

The SDK's `readFile`/`writeFile` go over the **browser WebSocket**, piggybacking on the existing connection:

```
iframe ──postMessage──► ModuleHost ──WS──► ws-handler ──FileService──► disk
```

`ws-handler.js#handleModuleFileOp`:

1. Resolves the project from `projectId` (server-side, never from the iframe).
2. Re-loads the manifest from disk.
3. Verifies `path` is in `permissions.files` (`isFilePermitted`).
4. Delegates to `FileService` with the project root as the boundary (independent `../` defense).

Host requests time out after 30s. The host also marks self-writes against the `FileWatcher` (`markSelfWrite`) so the in-Eve editor doesn't reload its own write as an external change.

## The "+ New Module" builder flow

**+ New Module** opens a **normal, visible** chat session (no `__module:` prefix — the build conversation belongs in the sidebar), with two tweaks in `public/app.js#_startModuleBuilder`:

1. The system prompt is fetched from `/modules/module-builder-prompt.md` and injected into the session.
2. The textarea is pre-filled with `"I want a module that ..."`.

## Where the code lives

| Concern | File |
|---|---|
| Manifest schema + path validation | `module-service.js` |
| Streaming AI invocation (session lifecycle, accumulation) | `module-invoker.js` |
| HTTP routes (list, manifest, static serve) | `routes/modules.js` |
| WS routes (`module_invoke_ai`, `module_ai_stop`, file ops) | `ws-handler.js` |
| Relay-side filter for hidden sessions | `relay-client.js` (`moduleSessions`) |
| Hidden-session list filter | `routes/index.js` |
| Iframe lifecycle + postMessage bridge | `public/modules/module-host.js` |
| Activity orb + event log dialog | `public/modules/module-activity-orb.js` |
| Client-side SDK (loaded inside iframe) | `public/eve-module-sdk.js` |
| Module list / state | `public/modules/module-store.js`, `public/core/state-store.js` |
| Sidebar Modules section + `+ New Module` row | `public/sidebar/project-panel.js` (`_renderModulesContent`) |
| Module tab opening | `public/tab-manager.js` (`openModule`) |
| Builder prompt | `public/modules/module-builder-prompt.md` |
| Builder session creation | `public/app.js` (`_startModuleBuilder`) |

## Invariants when extending the module system

1. **Never trust client-supplied scope.** `projectId`/`moduleName` come from the `WeakMap` lookup (browser) or the authenticated WS session re-validated against the manifest (server) — never from the postMessage payload.
2. **Re-validate the manifest on every gated call.** It's a file on disk an AI agent can rewrite between calls. Don't cache `permissions.files`.
3. **The `__module:` prefix is load-bearing.** Any new server path that creates relayLLM sessions for a module must use the prefix **and** register the sessionId with `relayClient.registerModuleSession(...)` before joining — otherwise events leak into the user's visible chat.
4. **The iframe sandbox is load-bearing.** Never add `allow-same-origin`; the entire trust model depends on the opaque origin.
5. **Single-responsibility split.** AI invocation in `module-invoker.js`; file reads/writes in `ws-handler.js`; static serve in `routes/modules.js`. Don't add a third file-permission gate.
