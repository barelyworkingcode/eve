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
| `pm/chat-input-features` | branched off it; 7 commits, **not pushed**. Phase 3 is complete. |
| `pm/tab-manager-registry` | branched off `pm/chat-input-features` (`4778ac2`); 11 commits, **not pushed**. Phase 4 is complete. |
| `simplify/remove-browser-voice-and-css` | merged into main; kept, safe to delete. |

Everything green as of `636b858`:

    npm test              # 39 suites, 540 tests   (unit, hermetic, ~4s)
    npm run test:integration   # 69 passed, 1 skipped
    npm run test:e2e      # 16 (spawns eve + fake relay)
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

**Refactor phase 3 (on `pm/chat-input-features`).** The last four buttons left
`public/features/chat-input.js`, which is now deleted. Attach went to
`public/features/file-attachments.js`, container key `fileAttachmentManager`,
slot `chat-input-leading` order 10. `FileAttachmentManager`'s constructor is now
DOM-free; a new `init(button)` does the wiring, and `setAvailable()` replaces
`app.js` poking `.hidden`. Plan mode went to `public/features/permissions.js`
with a `PermissionModeControl` (`syncMode`/`setAvailable`), key `permissions`,
slot `chat-input-leading` order 20; `message-dispatcher._applyPermissionMode`
now calls `syncMode()` instead of `document.getElementById('planModeBtn')`.
Send and stop went to `public/features/chat-form.js` with a `ChatFormControls`
defined in the same file (`showStop`/`hideStop`/`setSubmitEnabled`), key
`chatForm`, slot `chat-input-trailing` orders 10 and 30 with the mic's 20
between them. `app.js`'s `showStopButton`/`hideStopButton`/`showSessionStarting`/
`clearSessionStarting` keep their names and signatures and became one-line
delegations, so their eleven callers in `message-dispatcher.js`, `tab-manager.js`
and `dialogs/shell-launcher-dialog.js` did not move.

`public/app.js` went 1531 → 1507 lines; `initElements()` went from 65 to 59
`getElementById` entries; `this.elements.*` reach-throughs went from 81 to 69.

New tests: `test/unit/chat-form-controls.test.js`,
`test/unit/permission-mode-control.test.js`,
`test/unit/file-attachment-manager-init.test.js`, and
`test/e2e/chat-form-and-permissions.spec.js`. There are now three frozen gate
specs' worth of behavioural cover on the input row —
`test/e2e/chat-input-row.spec.js` and `test/e2e/voice-buttons.spec.js` remain
unmodifiable contracts, and this phase's new e2e spec joins them.

**Refactor phase 4 (on `pm/tab-manager-registry`).** `tab-manager.js`'s pane-
type and pane-view dispatch moved onto a `PaneRegistry`
(`public/core/pane-registry.js`), the same file-scope-singleton /
deferred-registration idiom as `FeatureRegistry`, composed with
`ViewerRegistry`'s selection-by-key semantics. See
[decisions/002-pane-registry.md](decisions/002-pane-registry.md) for the full
design (two descriptor kinds, why, and the constraint that made the phase
non-trivial).

All five pane types (`session`, `file`, `terminal`, `module`, `image`) and all
eight views (`chat`, `voice`, `editor`, `viewer`, `image`, `terminal`,
`module`, `htmlPreview`) now live in `public/panes/*.js`, registered at file
scope and loaded via one `<script>` tag each in `index.html` (also picked up
under Node by a directory scan in `core/pane-registry.js`, so no handoff had
to add a `require` line to `tab-manager.js`). The dead `console` view id and
the unused `getTab` method were deleted in the final handoff, along with the
two switch statements (`_viewForTab`, `_refForTab`) that had degenerated to a
bare `default:` arm with nothing left to fall through from.

Measured, before → after:

| measurement | before | after |
|---|---|---|
| `case` labels in `tab-manager.js` | 32 (28 pane-type + 4 `_edgeToDir`) | 4 (all `_edgeToDir`, drop edges — not pane types) |
| `default:` arms | 4 | 1 (`_edgeToDir`'s) |
| pane-type conditionals (`.type === '…'` etc.) | 20 | 0 |
| `tab-manager.js` lines | 1187 | 971 |
| `public/core/pane-registry.js` + `public/panes/*.js` lines | 0 | 761 |

Net lines across the client went up (locality was the goal, not brevity — see
002's consequences section). All four suites stayed green through every one
of the ten handoffs, and `test:visual`'s 24 screenshots stayed at 0.0000%
end to end.

**Correcting a stale figure.** [001-feature-registry.md](001-feature-registry.md)
and the previous revision of this document both cited "30 `case` arms on pane
type" for `tab-manager.js`. That was a `grep -c "case '"` line count, which
undercounts (two lines each carry two labels) and doesn't count `if`/ternary
comparisons at all. The actually-measured pre-refactor dispatch surface was
**51 branch arms across 18 sites**: 28 `case` labels + 3 pane-type `default:`
arms + 20 `if`/ternary comparisons (`_edgeToDir`'s 4 drop-edge labels excluded
throughout, since they're not pane-type dispatch). See 002 for the full
inventory.

## Next step — ws-handler.js

The refactor's next target is the server side: `ws-handler.js` (44-arm
switch, 12 injected deps) has the same shape of problem `tab-manager.js` did —
a single file doing dispatch that belongs to whichever service owns each case.
It is the last of the three files [001-feature-registry.md](001-feature-registry.md)
named as having this problem (`tab-manager.js` is now done; `ws-handler.js` is
the remaining one).

One piece of debt, corrected here because the old figure was wrong: `app.js`'s
`showStopButton`/`hideStopButton`/`showSessionStarting`/`clearSessionStarting`
were described as "four one-line forwarders" to `chatForm`. Only two of the
four actually are (`showStopButton`, `hideStopButton`). The other two own
`elements.userInput.disabled` in addition to delegating to `chatForm` —
`showSessionStarting` also clears messages, switches to the chat screen and
shows the thinking indicator; `clearSessionStarting` re-enables the textarea
directly. Neither can be deleted in favor of callers reaching `chatForm`
directly until `#userInput` itself moves into the chat-form feature, which is
a phase in its own right (`elements.userInput` has callers throughout
`app.js`). Phase 4 deleted two of the ten external call sites for the two
genuine forwarders for free, inside the `session` view's `show` (now
`ctx.container.get('chatForm').showStop()`/`.hideStop()` directly, in
`public/panes/views.js`) — the remaining eight all live in
`message-dispatcher.js`, whose natural owner is the `ws-handler.js` phase.

Six gates exist from the chat-input and tab-manager work and must keep
passing unmodified — if one fails, the code is wrong.
`test/e2e/chat-input-row.spec.js` asserts the row's wiring (order, send
submits, plan mode emits `set_permission_mode`, stop hidden while idle, mic
tracks STT availability, attach tracks model capability).
`test/e2e/voice-buttons.spec.js` asserts the drawer's (control order, short
tap toggles TTS, the `voice_mode` frame reaches the server, the manager
drives its own speaking indicator, 500ms long press starts voice chat and a
short tap does not). `test/e2e/chat-form-and-permissions.spec.js` covers two
seams the other two don't reach: send/textarea disabled only during the
session-starting window, and plan mode reflecting a server-pushed
`mode_changed` frame rather than only the local click.
`test/e2e/tab-panes.spec.js` pins tab/pane behaviour end to end (splits,
undocking, close confirms, the long-press session delete, image ownership,
localStorage restore). `test/unit/tab-manager-logic.test.js` pins the pure
logic seams (`_getRecentEntries`, `_projectIdForDirectory`,
`_nextTabInProject`, `_ownedBy`, `_edgeToDir`, `_updateHash`).
`test/unit/pane-registry.test.js` pins `PaneRegistry` itself (registration,
duplicate-throws, unknown-lookup-returns-null). Screenshots cannot catch a
dead button or a silently-undefined captured service; these can.

## Gotchas that cost real time

**A pane descriptor must resolve its owning service through `ctx`, at call
time — never capture one.** `new TabManager(this.container)` runs at
`app.js:75`, before `fileEditor` (79), `htmlPreviewPane` (81), `moduleHost`
(87), `viewerRegistry` (95), `terminalManager` (118) and `voiceChatManager`
(131) are constructed. A `panes/*.js` file that does
`const ed = container.get('fileEditor')` at file scope, at registration, or in
a memoised field gets `undefined`, and the failure is silent — nothing throws
at load time; the descriptor's call into `undefined` either no-ops behind an
optional chain or throws deep inside a click handler the first time a user
exercises that pane type. No test in the repo catches a captured service: the
unit suite constructs `TabManager` against a fake `document` with no real
`app`, and by the time the e2e suite runs, every service already exists, so
"resolved late, correctly" and "resolved early, would have been undefined"
look identical. Every descriptor function must reach a service through
`ctx.app.<x>` inside its own body — see `TabManager._ctx()` and
`core/pane-registry.js`'s file header.

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

**A feature's `init` constructor runs at `features.boot()`, before any slot
renders and before `initElements()`.** It must not touch the DOM.
`FileAttachmentManager` was the case that proved it: its constructor used to
call `initEventListeners()` against `app.elements`, which does not exist yet at
that point. The fix is the pattern the other features already use — a
DOM-free constructor plus a separate `init(button)` called from the slot's
render closure, once the element it needs actually exists.

**Whisper jitters.** Assert word overlap ≥ 0.7, never string equality: a phrase
scoring 100% on most runs was observed at 78%, and unusual proper nouns get
mangled ("eve voice" → "in police"). Broken speech scores near zero, so 0.7
still fails hard on a real regression.

**`.input-form` is a flex row** and its buttons are direct flex items, so any
`[data-slot]` wrapper needs `display: contents` or the row's spacing changes.
`public/apple/base.css:85` already has `[data-slot] { display: contents; }`
globally — don't remove it, and don't add a wrapper element of any other kind
inside a slot. No selector depends on that form's children structurally.

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
