# Lessons Learned

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
