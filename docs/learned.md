# Lessons Learned

Non-obvious pitfalls and patterns from development. Each entry is a bug we actually hit; the fix is in current code.

## Per-project allowlists: enforce where the data lives, not in the picker

A project carries two allowlists — `allowed_mcp_ids` and `allowed_models` — that look symmetric but weren't. `allowed_mcp_ids` is enforced server-side at the relay bridge. `allowed_models` was **stored but never enforced**: every picker rendered the full global `/api/models` list and `POST /api/sessions` forwarded whatever model it got.

The reason it slipped: Eve never talks to relayLLM directly. Traffic goes Eve → relay's frontend socket (`RELAY_FRONTEND_SOCKET`, see `relay-transport.js`) → relayLLM, and relayLLM has no project knowledge — projects live only in relay. An allowlist relayLLM can't see has to be enforced in relay's frontend, in front of the transparent proxy. There is no other chokepoint.

Fix, two layers mirroring the MCP allowlist:
- **Enforcement** (the real boundary): `../relay/frontend_model_guard.go` intercepts `POST /api/sessions` and `403`s a disallowed model. relayLLM stays project-agnostic.
- **UX only**: `StateStore.modelsForProject(projectId)` (`public/core/state-store.js`) filters the list for every project-scoped `<select>` (chat composer, voice, task, search dialogs). The project-*settings* picker (`public/dialogs/project-dialog.js`) is intentionally **not** filtered — it must show all models so you can pick the allowlist.

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

The frontend security audit ([`security-audit-frontend.md`](security-audit-frontend.md), items H2/C3) added CSP in two places. Both correct for their threat model, each silently broke a preview, and both look identical to a user ("preview is blank").

**PDF — the `/api/files` `sandbox` directive (H2).** The route set `default-src 'none'; sandbox` on *every* served file. The bare `sandbox` token sandboxes the framed document, and **Chrome's built-in PDF viewer can't run in a sandboxed frame** — blank iframe even on a `200` `application/pdf`. Fix (`routes/index.js`): scope `sandbox` + `Content-Disposition: attachment` to script-capable types (`.html/.htm/.xhtml/.svg/.xml`); serve inert binaries (PDF/image/audio/video) with `default-src 'none'` and no `sandbox`. `default-src 'none'` alone does not break the native viewer; the `sandbox` token does.

**HTML — `srcdoc` iframes inherit the parent's CSP (C3).** The editor's HTML preview (`file-editor.js` `renderHtmlPreview`) rendered via `iframe.srcdoc` in a `sandbox="allow-scripts"` frame. A `srcdoc`/`about:blank`/`blob:`/`data:` document **inherits the embedding page's CSP**, and Eve's app-shell CSP (`security-headers.js`) has `script-src 'self' 'wasm-unsafe-eval' blob: <hashes>` with no `'unsafe-inline'` — so the previewed page's inline `<script>` was blocked. HTML+CSS rendered, nothing interactive ran. **You can't loosen an inherited CSP from inside the child**; a child `<meta>` CSP can only tighten. Fix: serve the preview from a real URL whose own response headers carry the policy. `/api/files/...?preview=1` (HTML only) returns `Content-Security-Policy: sandbox allow-scripts` and the editor loads it via `iframe.src`. The response-level `sandbox` forces an opaque origin even on direct top-level navigation, so scripts run but the page can't reach Eve's DOM, cookies, or session token. Trade-off: the preview reflects the **saved** file (a version token bumps on save/external-change to reload), not the unsaved buffer.

**Rule**: a response CSP applies to that resource *as a document*. `sandbox` neutralizes script-capable documents (HTML/SVG) but also disables browser viewers (PDF) and inline scripts — scope it to the types that need neutralizing. To give a sandboxed-but-scriptable preview its own policy, load it from a URL, never `srcdoc`.

## Safari on-device voice incompatibilities

On-device STT/TTS runs in Web Workers using ONNX models. Chrome works fully; Safari has several open issues. Defaults are user-overridable via Settings → Voice.

| | Chrome | Safari Desktop | Safari Mobile |
|---|---|---|---|
| Voice mode | Conversation (VAD) | Conversation (VAD) | Push-to-talk |
| STT | On-device | Server (daemon) | Server (daemon) |
| TTS | On-device | Server (daemon) | Server (daemon) |

- **kokoro-js TTS, all Safari**: `TypeError: undefined is not a function` inside the minified `kokoro.web.js` (WASM and WebGPU). Model loads, generation fails. Safari defaults TTS to `server`. Monitor npm `kokoro-js` / GH `hexgrad/kokoro`.
- **Whisper STT, mobile Safari**: tab crashes during model download — mobile Safari's ~1-2GB per-tab limit is exceeded even by whisper-base (57MB) + WASM overhead. Mobile Safari defaults STT to `server`; whisper-tiny (31MB) is a possible future try.
- **VAD, mobile Safari**: `onSpeechEnd` never fires (`@ricky0123/vad-web` #227), so conversation mode doesn't work — mobile Safari defaults to push-to-talk.
- **Safari WebGPU + ONNX**: node-assignment warnings only; STT works fine with WebGPU on Safari desktop.

## Server Kokoro daemon: serialize all generation, pin mlx-audio==0.4.1

The server TTS path (`tts-service.js` → Kokoro daemon on TCP :9997) crashed intermittently — a session would lose voice ("stuck on Speaking"), sometimes taking out TTS for everyone.

- **Root cause**: the daemon (`../kokoro/daemon/kokoro_daemon.py`) serves each TCP connection on its own thread, all calling the shared `mlx-audio` `generate()` (MLX/Metal) and the espeak-ng phonemizer. Neither is thread-safe; two overlapping requests raced on shared Metal command-buffer / espeak global state and segfaulted the process. Confirmed upstream: mlx-audio#638, mlx#3078.
- **Why intermittent**: within one session the server path is already serialized via `RelayClient._ttsChain`, so a streaming response never overlaps itself. A crash needed two overlapping requests — two voice sessions, or the read-aloud play button (`tts_speak`), which was fire-and-forget off the chain.
- **Fix**: `gen_lock` in the daemon (`kokoro_daemon.py`) serializes all generation process-wide — the real fix, since it's global across sessions and also guards espeak. Defense in depth: `tts_speak` is serialized per-connection in `ws-handler.js`; `daemon_wrapper.sh` supervises and restarts on crash; daemon deps are hash-pinned.
- **Invariant**: the daemon model is effectively single-threaded. Anything that can issue concurrent `generate()` calls must stay behind the daemon's lock — don't optimize it away.

**Don't bump past 0.4.1.** mlx-audio 0.4.2–0.4.4 has a `broadcast_shapes` regression in Kokoro generation: certain phoneme sequences fail deterministically (`Shapes (1,N,1) and (1,N+300,9) cannot be broadcast`), probability rising with text length, so long read-aloud blocks reliably surfaced as "TTS error: Speech synthesis failed." 0.4.1 is clean (verified, independent of the mlx core version). Pin `mlx-audio==0.4.1` (`../kokoro/requirements.txt`); our `gen_lock` provides thread-safety, not the library. Re-evaluate when upstream ships a corrected release.
