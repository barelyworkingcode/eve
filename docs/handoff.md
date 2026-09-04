# Handoff — eve simplification and the feature-registry refactor

Written for a fresh context picking this up cold. Read
[decisions/001-feature-registry.md](decisions/001-feature-registry.md) next;
it holds the *why* for the current work.

## Where things stand

| branch | state |
|---|---|
| `main` | simplification work merged (PR #22). Green. |
| `refactor/feature-registry` | 5 commits, pushed, **not merged**. Phase 1 of the refactor is complete. |
| `pm/voice-button-features` | branched off it; 3 commits, **not pushed**. Phase 2 is complete. |
| `simplify/remove-browser-voice-and-css` | merged into main; kept, safe to delete. |

Everything green as of `3ac0b62`:

    npm test              # 36 suites, 525 tests   (unit, hermetic, ~4s)
    npm run test:integration   # 69 passed, 1 skipped
    npm run test:e2e      # 13 (spawns eve + fake relay)
    npm run test:voice    # 6  (needs the live Kokoro/Whisper daemons)
    npm run test:visual   # 24 screenshots, must be 0.0000%

## What was done

**Simplification (on `main`).** Removed the in-browser WASM TTS/STT backend
(server + iOS-native paths untouched), pruned dead CSS, cut the cold-load
payload from ~4.4 MB to 322 KB (gzip + lazy-loaded mermaid), dropped three npm
dependencies. ~4,300 lines out. `styles.css` went 6,279 → 2,619.

Two pre-existing bugs surfaced and were fixed: the CSP was silently blocking
both of `index.html`'s inline bootstrap scripts, and `base-uri 'none'` blocked
`<base href="/">` so `/project/` URLs served a blank page.

**Refactor phase 1 (on `refactor/feature-registry`).** `FeatureRegistry` +
named `[data-slot]` containers, with the chat input's five buttons as the first
consumer. Behaviour and appearance unchanged.

**Refactor phase 2 (on `pm/voice-button-features`).** The goal the refactor
exists for: `tts-manager.js` and `stt-manager.js` now touch their own buttons.

`public/features/stt.js` and `public/features/tts.js` each register under the
container key the app already resolved (`sttManager`, `ttsManager`), construct
their manager in `init`, and render and wire their button in a slot closure
that hands the element to the manager as `this.button`. The mic left
`chat-input.js`; the voice-mode button left `index.html` for a new
`voice-drawer-controls` slot, and its long-press gesture left `app.js`.

`app.js` lost both `new XManager(...)` calls, both `initElements()` entries and
the whole voice-mode gesture block, and `enableVoiceMode`/`toggleVoiceMode` now
ask `ttsManager.syncButtonState()` instead of reaching for the element.

Two consequences worth knowing:

- **`VoiceCrashGuard.detectAndRecover()` now runs before `features.boot()`.**
  Both constructors read the `eve-{tts,stt}-backend` keys the guard reverts
  after an on-device crash, and the registry constructs them far earlier than
  `initApp()` used to. Moving the guard back below `boot()` silently defeats
  post-crash recovery, and no test will tell you.
- **Registry construction is now load-bearing for the voice managers.** A
  feature's constructor runs before any slot renders, so it must not touch the
  DOM. Both are clean today; keep them that way.

## Next step — phase 3

Three buttons remain in `public/features/chat-input.js`: attach (belongs to
file attachments), plan mode (to permissions), send and stop (to the chat form
and the run lifecycle). Move each to the feature that owns it, following
`features/stt.js` — it is the smaller of the two worked examples. `chat-input.js`
is deleted when the last one leaves.

Send and stop are the awkward pair: both are driven from `app.js`'s run
lifecycle rather than from a manager that could own them, so that one needs a
home invented for it rather than a home it already has.

Two gates exist and must keep passing unmodified — if one fails, the code is
wrong. `test/e2e/chat-input-row.spec.js` asserts the row's wiring (order, send
submits, plan mode emits `set_permission_mode`, stop hidden while idle, mic
tracks STT availability, attach tracks model capability).
`test/e2e/voice-buttons.spec.js` asserts the drawer's (control order, short tap
toggles TTS, the `voice_mode` frame reaches the server, the manager drives its
own speaking indicator, 500ms long press starts voice chat and a short tap does
not). Screenshots cannot catch a dead button; these can.

Still open after that: `tab-manager.js` (30 `case` arms on pane type) and
`ws-handler.js` (44-arm switch, 12 injected deps) have the same shape of
problem on the document-pane and server sides.

## Gotchas that cost real time

**`server.js` caches `public/index.html` at startup.** Editing it has no effect
until the server restarts. Editing any other file under `public/` is picked up
immediately. The e2e/visual harnesses spawn their own eve, so they are
unaffected.

**`package-lock.json` is committed with CRLF.** `npm install` rewrites it as
LF, turning a 60-line dependency change into a 7,700-line whole-file diff.
After any install: `perl -pi -e 's/\r?\n/\r\n/' package-lock.json`.

**`index.html` is also CRLF**, and browsers normalise CRLF→LF before hashing an
inline script. `computeInlineScriptHashes` now normalises to match. If you
touch CSP hashing, keep that.

**`git diff` lies about large pure deletions.** Its default myers alignment
reports phantom insertions when a file has many repeated short lines — 148 of
them on a deletion-only CSS change. Use `--minimal` or `--histogram` for any
"zero insertions" check.

**The visual harness must stub the voice-daemon probes.** `/api/stt/status`
decides whether the mic button renders at all. Left unstubbed, the same commit
screenshots differently depending on whether the daemons happen to be running —
this produced a baseline with no mic button and four false regressions.
`test/visual/support.js#stubVoiceDaemons` pins both.

**The mic button is in the DOM on the welcome screen, but its ancestor is
hidden.** A "is the mic hidden?" assertion therefore passes for the wrong
reason unless a chat session is opened first. Both voice and button-row specs
open one.

**Whisper jitters.** Assert word overlap ≥ 0.7, never string equality: a phrase
scoring 100% on most runs was observed at 78%, and unusual proper nouns get
mangled ("eve voice" → "in police"). Broken speech scores near zero, so 0.7
still fails hard on a real regression.

**`.input-form` is a flex row** and its buttons are direct flex items, so any
`[data-slot]` wrapper needs `display: contents` or the row's spacing changes.
No selector depends on that form's children structurally.

**The `FeatureRegistry` instance must exist at file scope.** Feature files run
the moment their `<script>` is parsed, long before `initApp()`, so
`core/feature-registry.js` creates `const features` itself. Creating it in
`initApp()` leaves file-scope `register()` calls with nothing to call.

## Voice testing without a virtual audio device

Chromium takes a WAV file as the microphone:
`--use-file-for-fake-audio-capture=/path/x.wav%noloop` with
`--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`.
Verified: a speech WAV gives peak 1.0, a silent one gives 0.

- `navigator.mediaDevices` needs a secure context — the page must be on
  `127.0.0.1`, not `about:blank`.
- `%noloop` matters, or a long hold captures the phrase twice.
- Known speech: `say -v Samantha -o x.aiff "..."` then
  `afconvert -f WAVE -d LEI16@48000 -c 1 x.aiff x.wav`. macOS only.

This is preferred over a virtual audio driver (BlackHole et al.) for anything
browser-based: hermetic, headless, parallel-safe, no admin. BlackHole would
only be worth installing for the native iOS app or real system-audio capture.

The daemons run as relay services (`relaystt-daemon`, `relaytts-daemon`) and
are respawned by a wrapper script — killing the python process alone is not
enough to test the daemon-down path.

## Open decisions for the user

- **`AGENTS.md` is untracked, deliberately.** It briefs local agent tooling and
  materially improves handoff quality, but committing it changes behaviour for
  other agent tools in the repo. Their call.
- **~1,400 lines of CSS remain** that `scripts/prune-css.js` cannot prove safe:
  135 partially-overridden rule blocks, plus ~250 lines whose selectors match
  no DOM (mostly an abandoned task sidebar, replaced by `task-dialog.js` /
  `task-viewer.js`). Needs judgment, not automation.
- **The visual harness covers 6 surfaces.** Terminal, module host, task viewer
  and search dialog are not captured. The voice drawer is not either — phase 2
  changed it, so its layout was checked by capturing the panel's control
  geometry and pixels either side of the change instead (identical).
- **Native iOS voice is preserved by inspection, not exercised.**

## Working with the pi handoffs

`pmCheap` routes implementation to a free local model. Two failure modes cost
time here and are now guarded:

- It once began polling its own `pi-host` job id, which deadlocks. `AGENTS.md`
  now states it *is* the job and must not invoke any pi-dev script.
- Two handoffs against one working tree made the diffs unattributable. Run them
  sequentially, or in separate worktrees.

Sizing matters more than anything else: the one rejected handoff packed five
requirements into a single round after every mechanism had already been proven
by hand — it was mostly transcription, and faster to do directly. Keep
architecture and design decisions; hand over mechanical work with an exact
contract.

Two of the last four handoffs failed on defects in the *brief*, not the
implementation (a gate no implementation could satisfy; a registry with no
instance to register against). Write the spec carefully; it is where the errors
land.

Phase 2 went two-for-two accepted, split as one handoff per button and run
sequentially against the one tree. What the specs did that the failed ones did
not: name the exact container key and slot name on both sides of the move, and
spell out the ordering constraint (`VoiceCrashGuard` before `boot()`) rather
than leaving it to be inferred from the code.

The second round's fresh-context review looped — tool calls froze while the
event count ran past 90k — and never produced findings. It is a free filter, so
the answer is to review the diff yourself and not wait on it; the write phase
had already finished and its output was good.
