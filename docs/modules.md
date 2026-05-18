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
    "files": ["todo.md", "todo.cache.json"]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `displayName` | yes | Non-empty string. Shown in the sidebar. |
| `entry` | no | Defaults to `index.html`. Must end in `.html`, no `..`, no leading `/`. |
| `model` | no | Preferred model for `invokeAI`. Falls back to the project's default. |
| `permissions.files` | no | Array of **project-relative** file paths. Must not contain `..` or start with `/`. The exact list of files the module can read/write — no globs. |
| `name` | — | Do not set; the folder name always wins. |

The `permissions.files` list is the **only** authority on what files a module can touch. It's checked server-side on every read, write, and AI-invocation; client-side checks are advisory.

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

`window.eve.invokeAI(...)` ultimately resolves to a single `POST /api/modules/invoke` on the server. The server:

1. Loads and re-validates the manifest from disk.
2. Verifies every entry in `files` is in `permissions.files` — denies the call otherwise.
3. Reads the requested files server-side and inlines them in a system prompt (modules never need tool-use access for plain reads).
4. Resolves the model: explicit `model` arg → manifest `model` → first allowed model on the project.
5. Creates an **ephemeral hidden relayLLM session** named `__module:<moduleName>:<random-hex>`.
6. Sends the (system + user) prompt via relayLLM's **synchronous** `/api/sessions/:id/message` endpoint and awaits the full response.
7. If a `schema` was passed, parses the reply as JSON (stripping `` ```json `` fences if present); otherwise returns the raw text.
8. **Deletes** the ephemeral session in a `finally` block, regardless of outcome.

> ⚠️ Today this path is **non-streaming**: the model thinks and uses tools internally, but the iframe only sees the final aggregated text. There is no thinking/tool-use visibility for the user. A streaming variant (with an AI activity orb) is on the roadmap.

### Hidden session contract

Hidden module sessions are filtered out at two places:

- `GET /api/sessions` (the proxy in `routes/index.js`) drops anything whose `name` starts with `__module:` before returning to the browser.
- They're created with a random suffix so concurrent invocations don't collide.

If you change the prefix, update both `routes/modules.js` (`HIDDEN_SESSION_PREFIX`) and the filter in `routes/index.js` in lockstep.

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
| HTTP routes (list, manifest, static serve, invoke) | `routes/modules.js` |
| WS routes (`module_read_file`, `module_write_file`) | `ws-handler.js` (`handleModuleFileOp`) |
| Hidden-session filter | `routes/index.js` (sessions proxy) |
| Iframe lifecycle + postMessage bridge | `public/modules/module-host.js` |
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
