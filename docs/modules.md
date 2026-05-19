# Modules

A **module** is a small, AI-backed mini-app that lives inside a project at `<project>/modules/<name>/` and runs as a sandboxed page in Eve's document area. Modules are static HTML/CSS/JS plus a manifest; they get access to Claude (and to a whitelist of project files) through a tiny `window.eve` SDK.

Modules are intended to be **authored by Claude on request**. The user clicks **+ New Module** in a project's Modules section, describes what they want, and Claude scaffolds the files. Once created, modules render in the sidebar under that project and open as tabs in the document area.

## Directory layout

```
<project-root>/
  modules/
    <module-name>/
      module.json          ← manifest (required)
      index.html           ← entry page (required by default)
      style.css            ← optional, served from same folder
      app.js               ← optional
      ...                  ← any other assets the page uses
```

Module folder names must match `^[a-z0-9][a-z0-9_-]*$` (lowercase letters/digits, `_`, `-`; cannot start with `_`/`-`/dot). The folder name is the canonical module name — `module.json#name` is ignored and overwritten on load.

If a module has a broken or missing manifest, it still appears in the sidebar tagged as broken so it's discoverable rather than silently dropped.

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
| `model` | no | Preferred model for `invokeAI`. Falls back to the project's default. |
| `permissions.files` | no | Array of **project-relative** file paths. Must not contain `..` or start with `/`. The exact list of files the iframe SDK (`eve.readFile` / `eve.writeFile`) is allowed to touch — no globs. |
| `permissions.tools` | no | Array of tool names the LLM is allowed to call (e.g. `["Read", "Grep", "Glob"]`). Default `[]` (no LLM tools). See the **trust boundaries** section below. |
| `name` | — | Do not set; the folder name always wins. |

### Two trust boundaries

Modules have **two independent permission lists** that gate two different actors:

- **`permissions.files`** — what the **iframe SDK** can read/write. Bounded to the listed files, project-relative. The iframe JS is AI-authored; this is the security boundary that keeps a misbehaving module from touching arbitrary files.
- **`permissions.tools`** — what tools the **LLM** can call during `invokeAI`. Tools like `Read`/`Grep`/`Glob` see the **whole project directory**, not just `permissions.files`. There is no per-tool path scoping — once you grant `Read`, the model can read any file in the project.

Recommended tool sets:

| Risk | Tools | Use case |
|---|---|---|
| Low | `["Read", "Grep", "Glob"]` | Read-only modules that may need to explore the project before answering. |
| Medium | `["Read", "Write", "Edit", "Grep", "Glob"]` | Modules that need to modify project files beyond the iframe SDK's whitelist. |
| **Avoid** | `["Bash", "Task", "WebFetch"]` | These execute commands / spawn sub-agents / make network calls. Only add if you trust the module manifest as much as your own code. |

If a module only needs to manipulate a fixed set of files (the typical case), leave `permissions.tools` unset and use `eve.readFile` / `eve.writeFile` with `permissions.files` — that gives the iframe a tightly scoped sandbox and the LLM stays tool-less.

**Why both backends differ here:**

- For Claude Code, `permissions.tools` is passed as `--allowedTools` to the Claude CLI. Claude only sees the whitelisted tools.
- For llama-cpp / pi / OpenAI-compatible backends, relayLLM injects its full MCP tool list into the chat request regardless of `allowedTools` (a relayLLM limitation). The system prompt explicitly names the permitted tools so the model knows which ones to use; the relay's permission gate would normally block unlisted calls, but module sessions run in `bypassPermissions` mode (the orb has no UI to answer prompts), so for these backends the whitelist is advisory at the protocol layer. Treat `permissions.tools` as the **honest contract** of what the module needs; relying on it as a hard sandbox for non-Claude backends is unsafe.

## The `window.eve` SDK

Every module entry page must load:

```html
<script src="/eve-module-sdk.js"></script>
```

This exposes a small async API:

```js
// Invoke an AI prompt. Returns parsed JSON if `schema` is set, else raw text.
await window.eve.invokeAI({
  prompt: "Parse todo.md as a JSON array of {id, text, complete}.",
  files: ["todo.md"],                       // inlined server-side; must be in permissions.files
  schema: { type: "array", items: { ... } }, // optional; forces JSON-only output
  model: "claude-haiku-4-5",                // optional; overrides manifest.model
  timeoutMs: 5 * 60 * 1000,                 // optional; defaults to 5 min
});

// Direct file I/O (no AI). Path must be in permissions.files.
const text = await window.eve.readFile("todo.md");
await window.eve.writeFile("todo.md", newText);

// Read the module's own manifest (public projection).
const manifest = await window.eve.getManifest();
```

All four return promises. They reject with a clear `Error` on permission denial, missing file, AI timeout, or schema-parse failure.

The SDK never sends `projectId` or `moduleName` over the wire — the parent (`ModuleHost`) authenticates each call by matching `event.source` against the iframe's `Window`, then looks up scope from a `WeakMap`. An AI-authored module **cannot** lie about which project or module it is.

## Sandbox & security model

The iframe is created with `sandbox="allow-scripts"` only — **no `allow-same-origin`**. Consequences:

- The iframe runs in an **opaque origin** (`null`). `postMessage` origin checks therefore use `*`; trust is established by `event.source === iframe.contentWindow`, which can't be spoofed.
- No access to Eve's cookies, `localStorage`, IndexedDB, or DOM.
- No outbound `fetch()` to arbitrary URLs. All I/O goes through `window.eve`.
- No framing of other origins; no being framed outside Eve (`X-Content-Type-Options: nosniff`).

File serving (`GET /api/modules/serve/:projectId/:moduleName/*`) is hardened against:

- **Path traversal** — resolved paths must remain inside the module folder.
- **Symlink escape** — `fs.realpath` is run on both the candidate and module root.
- **Disallowed MIME types** — only HTML/CSS/JS/JSON/images/fonts/text are served; anything else 415s.
- **Dotfiles** — explicit `dotfiles: 'deny'` on `sendFile`.

The list of permitted extensions lives in `SERVE_MIME` in `routes/modules.js`.

## AI invocation flow

`window.eve.invokeAI(...)` is **WebSocket-driven and streaming**. The SDK postMessages the parent (`ModuleHost`), which authenticates the call and sends a `module_invoke_ai` frame over Eve's existing browser↔server WS. The server (`ModuleInvoker`) then:

1. Loads and re-validates the manifest from disk.
2. Verifies every entry in `files` is in `permissions.files` — denies the call otherwise.
3. Reads the requested files server-side and inlines them in a system prompt (so simple modules don't need tool access for plain reads).
4. Resolves the model: explicit `model` arg → manifest `model` → first allowed model on the project.
5. If `manifest.permissions.tools` is non-empty, attaches the project's MCP token + `useRelayTools: true` and sets a `permissionPolicy` with `defaultMode: 'bypassPermissions'` (the orb has no UI to answer permission prompts). The tool names are also injected into the system prompt so llama/openai backends know which tools to use. If `permissions.tools` is unset, the session runs tool-less.
6. Creates an **ephemeral hidden relayLLM session** named `__module:<moduleName>:<random-hex>` (HTTP `POST /api/sessions`).
7. Registers a handler on the per-connection `RelayClient` that intercepts every relay message tagged with the hidden sessionId BEFORE it can reach the browser's regular dispatch. (Without this, the dispatcher would treat the events as belonging to an unknown background session and start buffering them.)
8. `join_session` + `send_message` over the relay WS. As `llm_event`/`message_complete` frames arrive, the handler:
   - Forwards each one to the browser as `module_ai_event { requestId, sessionId, event }`.
   - Accumulates assistant `text_delta`/`content_block` text server-side.
   - On `message_complete`, resolves a promise with the full text + parsed result.
9. Sends a single `module_ai_completed { requestId, result, rawText, model }` (or `module_ai_failed { requestId, error, deniedFiles? }`) to the browser. `ModuleHost`'s pending-invoke entry resolves the SDK's outer Promise.
10. **Deletes** the ephemeral session in a `finally` block, regardless of outcome.

### Browser ↔ Eve WS protocol

| Direction | Type | Payload |
|---|---|---|
| client→server | `module_invoke_ai` | `{ requestId, projectId, moduleName, prompt, files?, schema?, model? }` |
| client→server | `module_ai_stop` | `{ requestId }` — cancels; calls `stop_generation` on the hidden session |
| server→client | `module_ai_started` | `{ requestId, projectId, moduleName, sessionId, model }` |
| server→client | `module_ai_event` | `{ requestId, sessionId, event }` — `event` is the raw relayLLM frame |
| server→client | `module_ai_completed` | `{ requestId, sessionId, result, rawText, model }` |
| server→client | `module_ai_failed` | `{ requestId, error, deniedFiles? }` |

`requestId` is generated by `ModuleHost` (browser-side) and is unique per in-flight invocation. The orb keys its UI on it.

### Activity orb

A small pulsing orb appears in the lower-right whenever ANY module invocation is in flight, with a count badge if there are two or more. Clicking it opens a read-only event log dialog showing per-invocation:

- Module name, model, hidden session id (first 12 chars), elapsed time.
- A live, scrolling list of `llm_event` summaries (text deltas, thinking, tool_use, tool_result, system messages).
- A **Stop** button while the invocation is running.
- The final result once `module_ai_completed` lands (so the user can verify what the module actually received).

The orb hides on `module_ai_completed`/`failed`. The dialog stays open if the user opened it — they may still want to inspect the final transcript. Closing the dialog drops terminal invocations from the in-memory log; running ones are preserved.

Server-side, `ModuleInvoker` enforces a 5-minute wall-clock cap per invocation. If the relay/model hangs the invocation fails with a structured `module_ai_failed` rather than leaking an ephemeral session forever. `ModuleHost`'s client-side timeout is set just past that (6 minutes) so the server-side failure always surfaces first.

### Hidden session contract

Hidden module sessions are filtered out at two places:

- `GET /api/sessions` (the proxy in `routes/index.js`) drops anything whose `name` starts with `__module:` before returning to the browser.
- `RelayClient` intercepts EVERY relay-WS message whose `sessionId` is registered in `moduleSessions` — it never reaches the browser as a regular `llm_event` or `message_complete`. Without this the dispatcher would treat them as a background session and buffer them.
- They're created with a random suffix so concurrent invocations don't collide.

The prefix is defined in `module-invoker.js` (`HIDDEN_SESSION_PREFIX`). `routes/index.js` imports it from there; both move in lockstep.

## Server-side file ops (`readFile`/`writeFile`)

The SDK's `readFile` and `writeFile` go over the **browser WebSocket** rather than HTTP (they piggyback on the existing connection rather than spinning up new requests):

```
iframe ──postMessage──► ModuleHost ──WS──► Eve ws-handler ──FileService──► disk
```

Path checks happen in `ws-handler.js#handleModuleFileOp`:

1. Resolve the project from `projectId` (server-side, never from the iframe).
2. Re-load the manifest from disk.
3. Verify the requested `path` is in `permissions.files`.
4. Delegate to `FileService` with the project root as the boundary (defeats `../` traversal independently).

Requests are correlated by a `requestId` and time out after 30 seconds at the host. The host also marks self-writes against the `FileWatcher` so the in-Eve file editor doesn't reload its own write as an external change.

## The "+ New Module" builder flow

Clicking **+ New Module** in a project's sidebar opens a regular chat session, but with two differences:

1. The system prompt is fetched from `/modules/module-builder-prompt.md` and injected into the session. That prompt tells Claude what a module is, what files to write, and the design principles to follow.
2. The textarea is pre-filled with `"I want a module that ..."` to nudge the user into the right framing.

The builder session is a **normal visible session** — it doesn't use the `__module:` prefix. The module-building conversation is something the user wants to see in their sidebar.

## Where the code lives

| Concern | File |
|---|---|
| Manifest schema + path validation | `module-service.js` |
| Streaming AI invocation (session lifecycle, event accumulation) | `module-invoker.js` |
| HTTP routes (list, manifest, static serve) | `routes/modules.js` |
| WS routes (`module_invoke_ai`, `module_ai_stop`, file ops) | `ws-handler.js` |
| Relay-side filter for hidden sessions | `relay-client.js` (`moduleSessions` map) |
| Hidden-session list filter | `routes/index.js` (sessions proxy) |
| Iframe lifecycle + postMessage bridge | `public/modules/module-host.js` |
| Activity orb + read-only event log dialog | `public/modules/module-activity-orb.js` |
| Client-side SDK (loaded inside iframe) | `public/eve-module-sdk.js` |
| Module list / state | `public/modules/module-store.js`, `public/core/state-store.js` |
| Sidebar entry | `public/sidebar/project-tree-item.js` |
| Module tab opening | `public/tab-manager.js` (`openModule`) |
| Builder prompt (fed into the create-session flow) | `public/modules/module-builder-prompt.md` |
| Builder session creation | `public/app.js` (`_startModuleBuilder`) |

## Adding to the module system

When extending modules, keep these invariants intact:

1. **Never trust client-supplied scope.** `projectId` and `moduleName` come from the `WeakMap`-backed context lookup, not from the postMessage payload.
2. **Re-validate the manifest on every server call** that gates behaviour on it. The manifest is a file on disk that an AI agent can rewrite between calls.
3. **The hidden-session prefix is load-bearing.** If you add a new way to create relayLLM sessions on the server, audit whether the result needs the `__module:` prefix.
4. **The iframe sandbox is load-bearing.** Don't add `allow-same-origin` to make some feature easier — the entire trust model depends on the iframe having no ambient authority.
5. **Single-responsibility routes.** AI invocation lives in `routes/modules.js`. File reads/writes live in `ws-handler.js`. Don't duplicate file-permission logic in a third place.
