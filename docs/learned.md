# Lessons Learned

## Per-Project Allowlists: `allowed_mcp_ids` Is Enforced, `allowed_models` Had to Be

**Issue**: A project carries two allowlists — `allowed_mcp_ids` and `allowed_models` — that look symmetric but weren't. `allowed_mcp_ids` is enforced server-side at the relay bridge (a project's scoped token derives `PermOff` for every non-listed MCP, and `checkToolAccess` gates every tool list/call). `allowed_models` was **stored but never enforced anywhere**: every model picker rendered the full global `/api/models` list, and `POST /api/sessions` forwarded whatever model it was given. A project restricted to two models still offered — and would run — all of them.

**Why it was easy to miss**: Eve does not talk to relayLLM directly. Traffic goes Eve → **relay's frontend socket** (`RELAY_FRONTEND_SOCKET`, see `relay-transport.js`) → relayLLM. relayLLM has no project knowledge at all — projects live only in relay. So an allowlist relayLLM can't see has to be enforced in relay's frontend, in front of the transparent proxy; there is no other chokepoint.

**Fix (two layers, mirroring how the MCP allowlist already works):**

```javascript
// UX only — filter the picker to the project's allowed models.
// Empty list or ["*"] means unrestricted, matching relay's isWildcard.
renderModelSelect(modelSelect, this.state.modelsForProject(this.projectId));
```

- **Enforcement** (the real boundary): `relay/frontend_model_guard.go` intercepts `POST /api/sessions` and `403`s a disallowed model before it reaches relayLLM. relayLLM stays project-agnostic.
- **UX**: `StateStore.modelsForProject(projectId)` filters the list for every project-scoped model `<select>` (web/voice chat, main composer, task dialog, search dialog, legacy task modal). The project-*settings* picker is intentionally **not** filtered — it must show all models so you can choose the allowlist.

**Rule of thumb**: client-side filtering of a model/tool list is UX only, never the security boundary. Put the hard gate where the authoritative data lives (relay), and treat `["*"]` or an empty list as "allow all".

## Never Use `req.headers.host` for Authorization

**Issue**: An early "localhost bypass" in `auth.js` and `ws-handler.js` short-circuited the passkey check when the request `Host` header was `localhost` or `127.0.0.1`. The `Host` header is fully attacker-controllable, so any remote client could send `Host: localhost` and bypass authentication entirely — over HTTP and WebSocket — on every data route and file operation.

```javascript
// WRONG: attacker can set Host: localhost from anywhere
const host = req.get('host') || 'localhost';
if (host === 'localhost' || host === '127.0.0.1') return next();

// WRONG: same bug in the WS upgrade handler
const host = (req.headers.host || 'localhost').split(':')[0];
const isLocalhostConnection = host === 'localhost' || host === '127.0.0.1';

// CORRECT: the only trustworthy signal is the raw TCP source address
const ip = req.socket.remoteAddress;
if (trustedNetwork.isTrusted(ip)) return next();
```

**Rules of thumb:**
- `req.headers.host` and `X-Forwarded-For` are **never** trustworthy inputs for authorization. They are useful for building URLs and for rate limiting *with a per-IP kill switch*, but not for gating access.
- `req.socket.remoteAddress` is the authoritative network identity. If you need to support a reverse proxy, explicitly allow-list the proxy's IP and only then consult `X-Forwarded-For` — and even then, treat it as a hint, not a credential.
- IP-based checks must also normalize IPv6-mapped IPv4 (`::ffff:1.2.3.4` → `1.2.3.4`) or the comparison will silently fail on dual-stack hosts.
- All trust-boundary logic lives in one place (`TrustedNetworkService`) so future edits don't accidentally reintroduce the Host-header path.

Design details and the full fix are tracked in [`plans/cozy-honking-toast.md`](../plans/cozy-honking-toast.md).

## Path Handling in Node.js

**Issue**: `path.resolve()` treats paths starting with `/` as absolute paths.

```javascript
// WRONG: Returns '/' (filesystem root), not project directory
path.resolve('/Users/project', '/');

// CORRECT: Strip leading slashes first
const normalized = relativePath.replace(/^\/+/, '') || '.';
path.resolve('/Users/project', normalized);
```

When building file browsers or APIs that accept "relative" paths from clients, always normalize by stripping leading slashes before using `path.resolve()`.

## File Watching: Watch the Directory, Not the File

**Issue**: `fs.watch(filePath)` on an individual file goes permanently silent after an *atomic* save (write to a temp file, then `rename()` over the target). The watch handle is bound to the original inode; once that inode is unlinked by the rename, no further events arrive. This is how most editors, `git`, and the LLM's own file-edit tools write — so a per-file watcher "works once, then dies," which reads as flaky/unreliable live updates.

```javascript
// WRONG: dies after the first atomic temp+rename replace
fs.watch(absoluteFilePath, (eventType) => { ... });

// CORRECT: one recursive watch on the project root survives atomic replaces
// (the tree persists even as files inside are unlinked/replaced)
fs.watch(projectRoot, { recursive: true }, (eventType, filename) => { ... });
```

**Rules of thumb** (see `file-watcher.js`):
- One recursive watcher per project per connection serves both editor live-update (content push for open files) and sidebar tree sync (add/remove). No polling — recursive `fs.watch` is FSEvents-backed on macOS.
- `eventType === 'rename'` means a directory listing changed (create/delete/rename/move). `'change'` means content only — never refresh a listing on `'change'`. Verified on darwin: creates/atomic-saves/nested-creates all surface as `'rename'`.
- FSEvents **replays recent historical events** right after a watch starts. Guard the editor against a replayed change carrying identical content (`if (content === originalContent) return;`) so it can't pop a spurious "modified externally" bar on open.
- Only emit a "dir changed" signal for a directory that **still exists** — when a whole dir is deleted, its child-removal events would otherwise ask the client to re-list a path that's gone (noisy "not found"). The dir's own removal fires a separate event for its *parent*, which is what actually drops it from the tree.
- Suppress the echo of Eve's own writes (`markSelfWrite` keyed on the absolute path) so a save doesn't bounce back as an external change.
- Recursive `fs.watch` does **not** follow symlinked directories on macOS, and reports filenames relative to (and rooted under) the watched dir — it never emits `../` escapes. File reads still go through `fileService.readFile` → `validatePath`, so traversal stays gated regardless.

## CSS Visibility Control

Use `.hidden` class consistently for showing/hiding elements. Never use inline `style.display`:

```javascript
// WRONG: Inline style overrides class removal, content stays hidden
element.style.display = 'none';
element.classList.remove('hidden');  // Still invisible!

// CORRECT: Use classes consistently
element.classList.add('hidden');
element.classList.remove('hidden');  // Works as expected
```

Inline styles have higher specificity than classes. Mixing them causes hard-to-debug visibility bugs where content appears blank even after removing the `hidden` class.

## Safari Incompatibilities with On-Device Voice (2026-03-31)

On-device STT/TTS runs in Web Workers using ONNX models. Chrome works fully. Safari has several issues to monitor for future fixes:

### kokoro-js TTS: TypeError on Safari (all platforms)
- **Error**: `TypeError: undefined is not a function (near '...e of A...')` in `kokoro.web.js`
- **Impact**: On-device TTS fails on Safari. Falls back to server Kokoro daemon.
- **Root cause**: Unknown — error is in the minified kokoro-js bundle. Occurs with both WASM and WebGPU backends. Model loads successfully but generation fails.
- **Workaround**: Safari defaults to `backend: 'server'` for TTS.
- **Monitor**: kokoro-js releases (npm `kokoro-js`, GitHub `hexgrad/kokoro`). Test with: `Settings → Voice → TTS Backend → On-Device`.

### Whisper STT: Mobile Safari memory crash
- **Error**: Tab reloads/crashes during model download on iPhone/iPad.
- **Impact**: On-device STT unusable on mobile Safari.
- **Root cause**: Mobile Safari enforces ~1-2GB memory limit per tab. Even whisper-base (57MB model) combined with WASM runtime overhead exceeds the budget.
- **Workaround**: Safari defaults to `backend: 'server'` for STT. Could try whisper-tiny (31MB) in the future.
- **Monitor**: Safari memory limits in future iOS releases; transformers.js memory optimizations.

### VAD: AudioWorklet issues on mobile Safari
- **Error**: `onSpeechEnd` never fires on iPhone/iPad (vad-web GitHub issue #227).
- **Impact**: Conversation mode (always-listening) doesn't work on mobile Safari.
- **Workaround**: Mobile Safari defaults to push-to-talk input mode.
- **Monitor**: vad-web releases (npm `@ricky0123/vad-web`, GitHub `ricky0123/vad`).

### Safari WebGPU + ONNX Runtime
- **Issue**: ONNX Runtime node assignment warnings appear on Safari with WebGPU backend. Not a blocker — STT (transformers.js Whisper) works fine with WebGPU on Safari desktop.
- **Impact**: Performance warnings only, no functional issue for STT.
- **Monitor**: onnxruntime-web releases for improved Safari WebGPU support.

### Current defaults by platform
| | Chrome | Safari Desktop | Safari Mobile |
|---|---|---|---|
| Voice mode | Conversation (VAD) | Conversation (VAD) | Push-to-talk |
| STT | On-device (browser) | Server (daemon) | Server (daemon) |
| TTS | On-device (browser) | Server (daemon) | Server (daemon) |

All settings are user-overridable via Settings → Voice.
