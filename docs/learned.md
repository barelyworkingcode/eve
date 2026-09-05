# Lessons Learned

Non-obvious pitfalls and patterns from development. Each entry is a bug we actually hit; the fix is in current code.

## Per-project allowlists: enforce where the data lives, not in the picker

A project carries two allowlists — `allowed_mcp_ids` and `allowed_models` — that look symmetric but weren't. `allowed_mcp_ids` is enforced server-side at the relay bridge. `allowed_models` was **stored but never enforced**: every picker rendered the full global `/api/models` list and `POST /api/sessions` forwarded whatever model it got.

The reason it slipped: Eve never talks to relayLLM directly. Traffic goes Eve → relay's frontend socket (`RELAY_FRONTEND_SOCKET`, see `relay-transport.js`) → relayLLM, and relayLLM has no project knowledge — projects live only in relay. An allowlist relayLLM can't see has to be enforced in relay's frontend, in front of the transparent proxy. There is no other chokepoint.

Fix, two layers mirroring the MCP allowlist:
- **Enforcement** (the real boundary): `../relay/cmd/relay/frontend_model_guard.go` intercepts `POST /api/sessions` and `403`s a disallowed model. relayLLM stays project-agnostic.
- **UX only**: `StateStore.modelsForProject(projectId)` (`public/core/state-store.js`) filters the list for every project-scoped `<select>` (chat composer, shell launcher, task, search dialogs). The project-*settings* picker (`public/dialogs/project-dialog.js`) is intentionally **not** filtered — it must show all models so you can pick the allowlist.

**Rule**: client-side filtering of a model/tool list is UX, never the boundary. Put the hard gate where the authoritative data lives. Treat `["*"]` or an empty list as "allow all".

## Never use `req.headers.host` for authorization

An early "localhost bypass" in `auth.js`/`ws-handler.js` short-circuited the passkey check when the request `Host` header was `localhost`/`127.0.0.1`. `Host` is attacker-controllable, so any remote client could send `Host: localhost` and bypass auth entirely over HTTP and WebSocket.

```javascript
// WRONG: attacker sets Host: localhost from anywhere
const host = req.get('host') || 'localhost';
if (host === 'localhost' || host === '127.0.0.1') return next();

// CORRECT: the only trustworthy signal is the raw TCP source address
if (trustedNetwork.isTrusted(req)) return next();   // reads req.socket.remoteAddress
```

Rules:
- `req.headers.host` and `X-Forwarded-For` are never trustworthy for authorization. They are fine for building URLs / WebAuthn RP IDs (`auth.js` `getRpId`/`getOrigin`) and for per-IP rate limiting, but not for gating access.
- `req.socket.remoteAddress` is the authoritative network identity. For a reverse proxy, allow-list the proxy IP first, then treat `X-Forwarded-For` as a hint.
- Normalize IPv6-mapped IPv4 (`::ffff:1.2.3.4` → `1.2.3.4`) or comparisons silently fail on dual-stack hosts (`trusted-network.js`).
- All trust-boundary logic lives in one place (`TrustedNetworkService`) so edits can't reintroduce the Host path.

Full security model: [`authentication.md`](authentication.md).

## Path handling: strip leading slashes before `path.resolve()`

`path.resolve('/Users/project', '/')` returns `/` (filesystem root), not the project dir — a leading `/` makes the second arg absolute. When accepting "relative" paths from clients, normalize first (`file-service.js`):

```javascript
const normalized = relativePath.replace(/^\/+/, '') || '.';
path.resolve(projectPath, normalized);
```

## File watching: watch the directory, not the file

`fs.watch(filePath)` on an individual file goes permanently silent after an *atomic* save (write temp + `rename()` over the target): the handle is bound to the original inode, which the rename unlinks. That's how most editors, git, and the LLM's own edit tools write — so a per-file watcher "works once, then dies."

```javascript
// WRONG: dies after the first atomic temp+rename
fs.watch(absoluteFilePath, (eventType) => { ... });

// CORRECT: one recursive watch on the project root survives atomic replaces
fs.watch(projectRoot, { recursive: true }, (eventType, filename) => { ... });
```

Rules of thumb (`file-watcher.js`):
- One recursive watcher per project per connection serves both editor live-update and sidebar tree sync. No polling — recursive `fs.watch` is FSEvents-backed on macOS.
- `eventType === 'rename'` means a directory listing changed (create/delete/rename/move); `'change'` is content only. Never refresh a listing on `'change'`. Verified on darwin: creates/atomic-saves/nested-creates all surface as `'rename'`.
- FSEvents replays recent historical events right after a watch starts. Guard the editor against a replayed change with identical content (`if (content === originalContent) return;`) so it can't pop a spurious "modified externally" bar on open.
- Only emit a "dir changed" signal for a directory that still exists; a whole-dir delete fires a separate event for the *parent*, which is what drops it from the tree.
- Suppress the echo of Eve's own writes (`markSelfWrite`, keyed on absolute path).
- Recursive `fs.watch` does not follow symlinked dirs on macOS and reports filenames rooted under the watched dir (never `../` escapes). Reads still go through `fileService.readFile` → `validatePath`, so traversal stays gated regardless.

## CSS visibility: use `.hidden`, never inline `style.display`

Inline styles outrank class rules, so `element.style.display = 'none'` survives `classList.remove('hidden')` — content stays blank after you "show" it. Toggle the `.hidden` class only.

## File-preview CSP: one hardening pass broke PDF and HTML two different ways

Two CSP guards ([`security-audit-frontend.md`](security-audit-frontend.md) C3, and the `/api/files` sandboxing) sit in different places. Both are correct for their threat model, but each can silently break a preview, and both look identical to a user ("preview is blank").

**PDF — the `/api/files` `sandbox` directive.** The route set `default-src 'none'; sandbox` on *every* served file. The bare `sandbox` token sandboxes the framed document, and **Chrome's built-in PDF viewer can't run in a sandboxed frame** — blank iframe even on a `200` `application/pdf`. Fix (`routes/index.js`): scope `sandbox` + `Content-Disposition: attachment` to script-capable types (`.html/.htm/.xhtml/.svg/.xml`); serve inert binaries (PDF/image/audio/video) with `default-src 'none'` and no `sandbox`. `default-src 'none'` alone does not break the native viewer; the `sandbox` token does.

**HTML — `srcdoc` iframes inherit the parent's CSP (C3).** The editor's HTML preview (`file-editor.js` `renderHtmlPreview`) rendered via `iframe.srcdoc` in a `sandbox="allow-scripts"` frame. A `srcdoc`/`about:blank`/`blob:`/`data:` document **inherits the embedding page's CSP**, and Eve's app-shell CSP (`security-headers.js`) has `script-src 'self' 'wasm-unsafe-eval' blob: <hashes>` with no `'unsafe-inline'` — so the previewed page's inline `<script>` was blocked. HTML+CSS rendered, nothing interactive ran. **You can't loosen an inherited CSP from inside the child**; a child `<meta>` CSP can only tighten. Fix: serve the preview from a real URL whose own response headers carry the policy. `/api/files/...?preview=1` (HTML only) returns `Content-Security-Policy: sandbox allow-scripts` and the editor loads it via `iframe.src`. The response-level `sandbox` forces an opaque origin even on direct top-level navigation, so scripts run but the page can't reach Eve's DOM, cookies, or session token. Trade-off: the preview reflects the **saved** file (a version token bumps on save/external-change to reload), not the unsaved buffer.

**Rule**: a response CSP applies to that resource *as a document*. `sandbox` neutralizes script-capable documents (HTML/SVG) but also disables browser viewers (PDF) and inline scripts — scope it to the types that need neutralizing. To give a sandboxed-but-scriptable preview its own policy, load it from a URL, never `srcdoc`.

## Server TTS/STT daemons: voice is on-device only in the native iOS app now

The browser path has exactly two TTS/STT backends, `native` and `server`
(`tts-manager.js`/`stt-manager.js`) — there is no in-browser WASM/ONNX model
anymore. `native` means the iOS app's on-device engine, gated to opt-in
because it's unreliable on-device (see `tts-manager.js`'s comment on the
iOS 26.5.1 crash); every browser defaults to `server`, which calls the local
relayTTS/relaySTT daemons (`tts-service.js`/`stt-service.js`, loopback TCP
only — see [CLAUDE.md](../CLAUDE.md) "Voice is the one exception").

**Read-aloud (`tts_speak`) must stay serialized even though it's fire-and-forget.**
Within one voice session, streaming synthesis is already serial via
`RelayClient._ttsChain`. `tts_speak` (the read-aloud button in a text session)
runs off that chain, so without its own guard it can overlap a live voice
session's generation. The daemon can crash under concurrent generation
requests — a crash there takes out voice for every connected session, not
just the one that triggered it — so `ws/voice-messages.js` explicitly
serializes `tts_speak` against the daemon's own global generation lock. Any
new call path into the daemon must go through the same serialization; there
is no "fast path" that's safe to bypass it.

## A reconnect has to re-join terminals, because input and output aren't symmetric

A shell pane would go dead after the browser's WebSocket dropped and
reconnected: keystrokes still went somewhere, nothing ever came back, and a
reload showed everything that had been typed in the meantime. It reads like a
rendering freeze, and it isn't one — xterm's renderer is running and its grid
matches the DOM. Nothing is being *sent* to the pane.

The asymmetry is in relayLLM (`ws.go`):

- `handleTerminalInput` writes to a PTY looked up **by id**, from any
  connection, with no membership check.
- `terminal_output` goes only to connections registered as viewers by
  `joinTerminalConn`, which runs for `terminal_create`, `join_terminal` and
  `terminal_reconnect`.

A browser reconnect builds a whole new chain — new browser WS, new
`RelayClient`, new upstream WS to relayLLM — so the new connection's viewer set
is empty while the PTY is untouched and still accepting input. The pane is
write-only.

Sessions were fine because `app.js#onWebSocketReady` re-sends `join_session`
for open tabs. Terminals were not: `onTerminalList` only joins ids it doesn't
already hold locally, and after a reconnect it holds all of them. A reload
"fixed" it because a reload is the one path that rebuilds `this.terminals` from
empty, which makes every id look new again.

Fix: `markTerminalsForRejoin()` flags live panes on every `auth_success`;
`onTerminalList` re-joins the visible one (the list proves it's still resident,
so it can't draw a spurious "terminal not found"), and hidden ones re-join from
`showTerminal`, which fits them against a real viewport first. Because a join
always replays full scrollback, `onTerminalJoined` resets the grid first when
`replayPending` is set — otherwise the replay stacks a second copy of the
screen under the first.

**Rule**: any per-connection subscription upstream — terminals, sessions,
watches — has to be re-established on the reconnect path, and "we already have
it locally" is not evidence that the server still knows that. Reaching for the
renderer is the wrong instinct here: check whether frames are arriving at all
before assuming they arrived and failed to paint.
