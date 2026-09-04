# A message registry for `ws-handler.js`

## The problem

[001-feature-registry.md](001-feature-registry.md) named `ws-handler.js` (44-arm
switch, 13 injected dependencies) as the last of the three files with this
shape of problem — `tab-manager.js` is done (see
[002-pane-registry.md](002-pane-registry.md)). Measuring `ws-handler.js`
properly, before any production change, found the switch itself was not the
defect — a departure from both prior docs, worth stating plainly before the
numbers.

Categorising all 44 arms by what they actually contain: 10 one-line
`relayClient.<method>()` pass-throughs, 9 one-line `relayClient.send({...})`
field-picks, 6 one-line `fileHandlers.<method>(ws, message)` calls, 5 arms with
one extra seam (2–6 lines), 4 cancel/stop bookkeeping arms (2–4 lines), and 10
arms that already delegated to a named function living outside the switch.
**34 of the 44 arms are one-to-six-line adapters**, and the other 10 already
had their real logic factored out. There is no hidden coupling in the switch
to unhide, unlike `tab-manager.js`'s 51 branch arms, which were interleaved
with the file's own DOM state across six places hand-maintaining the same
element list. `ws-handler.js`'s switch is a flat, exhaustive, greppable table
of the entire client→server wire protocol — a legitimate artefact, and
splitting it into 44 per-type files would have *destroyed* information: you
would no longer be able to read the protocol surface on one screen. That is
why this phase landed at **seven domain files, not forty-four type files** —
the granularity the domain actually has, not the granularity the switch's
`case` count suggested.

What actually hurt, in descending order:

1. **The file was 787 lines and only ~150 of them were its job.** 394 lines
   were eight handler *implementations* (`handleCreateSession`,
   `handleUserInput`, `handleReadPlanFile`, `handleTranscribeAudio`,
   `handleTtsSpeak`, `handleModuleFileOp`, `handleModuleInvokeAi`,
   `handleSearchAiSummarize`) plus `appendDeviceLog` and a 62-line voice-mode
   system prompt — none of it connection lifecycle or dispatch.
2. **`EXPENSIVE_OPS` was a security control living 300 lines from what it
   protects.** The rate-limit set named six message types by string, 300
   lines away from their `case` arms. Adding a seventh expensive type and
   forgetting the set would have silently removed the cap — a defect no test
   would catch and no reviewer would notice, because the two edits were on
   different screens of the same file. This is a security property
   (`docs/security-audit-frontend.md` M3), not an aesthetic one.
3. **Positional parameter lists.** `handleCreateSession` took 6 positional
   parameters, `handleTtsSpeak` took 5, `handleModuleFileOp` took 4 including a
   hand-assembled `{moduleService, fileHandlers, resolveProject, fileWatcher}`
   bag — the file admitting it wanted a context object.

Those three problems justified doing the work even though the switch itself
was innocent.

## What already existed

Two precedents: `FeatureRegistry` ([001](001-feature-registry.md)) and
`PaneRegistry` ([002](002-pane-registry.md)), both register-by-key,
constructs-nothing, unknown-returns-`null`.

## The decision

`WsMessageRegistry` (`ws/message-registry.js`) reuses that idiom, but
descriptors are registered **in batches from seven domain modules** rather
than one file per message type:

```
ws/message-registry.js     the class, the singleton, the explicit loader
ws/session-messages.js     11 arms + handleCreateSession + handleUserInput
ws/file-messages.js        11 arms + handleReadPlanFile
ws/search-messages.js       4 arms + handleSearchAiSummarize
ws/module-messages.js       4 arms + handleModuleFileOp + handleModuleInvokeAi
ws/terminal-messages.js     9 arms
ws/voice-messages.js        4 arms + handleTtsSpeak + handleTranscribeAudio
ws/diagnostics-messages.js  1 arm  + appendDeviceLog
```

Each domain file is the readable table for its sub-protocol — the same
property the switch had, at the granularity the domain actually has. The
eight handler implementations moved into the domain files that own them.
`ws/message-registry.js` loads the seven files with explicit `require`s and a
loop, not a `readdirSync` scan: a typo is a `MODULE_NOT_FOUND` at boot instead
of a silently-absent message type, and there is no directory-scan behaviour to
reason about under Jest (a `pane-registry.js`-specific device — `global.panes`
plus a directory scan — is deliberately not reproduced here; a `global.*`
write leaks across Jest's per-suite module registries).

### Why seven files and not forty-four

Restated because it will otherwise be re-litigated: message types differ along
one axis (what they do) plus one security classification (`expensive`). Pane
types differed along fourteen axes, which is why `PaneRegistry` earned
fourteen descriptor members and a per-type file each. Forcing the same
granularity onto message types would multiply file count without multiplying
distinctions to express, and it would cost the one thing the switch was
actually good at: reading the whole wire protocol on one screen. The seven
domain files keep that property while fixing the three problems above.

### The descriptor

Three fields, deliberately no more:

| member | required | replaces |
|---|---|---|
| `type` | yes | the `case` label |
| `handle(ctx)` | yes | the arm body |
| `expensive` | no, default `false` | membership in `EXPENSIVE_OPS` |

`register()` requires `type` and `handle`, throws on a duplicate, constructs
nothing. `get(type)` returns a descriptor or `null` — never `undefined`, never
a throw — which is what made the migration incremental (`registry.get(t) ??
<switch>` during H2–H6, exactly as `panes.type(x) ?? <switch>` did for
`tab-manager.js`).

### The `ctx` shape, as built

```js
{
  ws, req, message,        // per connection / per message
  relayClient, fileWatcher,
  inflightSearchIds, inflightAiIds,
  log,
  deps: {
    relayTransport, fileHandlers, moduleService, moduleInvoker,
    searchSummarizer, resolveProject, ttsService, sttService,
  },
}
```

Nine top-level members plus eight in `deps`. `authService`, `trustedNetwork`
and `uiBus` are deliberately absent — no descriptor uses them, and putting
them on `ctx` would invite one to. `claudeConfig` is deleted outright: it had
zero readers repo-wide (`grep -rn "claudeConfig" --include="*.js"` returned
only its own destructure in `ws-handler.js` and its assignment in
`server.js`), so deleting both was a zero-behaviour-change edit.
`createWsHandler`'s parameter count went from 13 to 12.

## Constraints, stated outright

**C1 — a descriptor must never capture connection-scoped state.** Descriptor
objects are created once per *process*, at `require` time, before any socket
exists. `ws`, `req`, `relayClient`, `fileWatcher`, `inflightSearchIds` and
`inflightAiIds` are per-*connection* and reach a handler only through `ctx`,
passed fresh on every call. This is the same rule `PaneRegistry` follows, but
it survives here for a different and more dangerous reason. On the client, a
captured service produced a silent `undefined` — `TabManager` was constructed
before its collaborators existed, so a memoised reference was simply nothing,
and the failure mode was a no-op or a thrown error the first time a user
exercised that pane type. Here, construction order is not the hazard —
`require` is synchronous and `createWsHandler` runs once, after everything is
built. The hazard is that a descriptor is one object shared by every
connection that will ever exist in this process. A module-level
`let currentWs`, a `const relay = ctx.relayClient` outside `handle`, or a
`ctx` stashed on the descriptor binds the *first* browser that connects and
serves every later one from it — one user's socket receiving another user's
file contents, terminal output and LLM stream. Nothing throws. The leak is
silent, and it only shows up with two concurrent connections, which the unit
suite never creates. This is why `test/integration/ws-dispatch.test.js`
contains a two-connection isolation test: open two sockets against one
spawned server, drive a file op and a session op on each, assert every reply
lands on the socket that asked. No other test in the repo would catch this
class of bug.

**C2 — a descriptor returns a promise only if its `case` arm was `await`ed
today.** Exactly three: `create_session`, `module_read_file`,
`module_write_file`. The dispatcher does `await descriptor.handle(ctx)`, so a
descriptor that returns a promise the arm never returned today converts what
was an unhandled rejection into a browser-visible `{type:'error'}` frame —
arguably better, but a protocol change, and forbidden in this phase.
Mechanically guarded: `test/unit/ws-message-registry.test.js` asserts
`handle.constructor.name === 'AsyncFunction'` iff the arm is one of the three.

**C3 — `ping` and `auth` are dispatcher business, not descriptors.** `ping`
must answer before the auth gate and the rate limiter; `auth` mutates
`isAuthenticated`, a connection-scoped closure variable the dispatcher's own
gate reads. Neither ordering nor that mutation capability is expressible in
the registry, and making it expressible would hand all 44 other types a
capability they must not have. They remain the pre-switch `if` guards they
were before this phase.

**C4 — `descriptor.expensive` is now the sole source of rate-limit truth.**
`EXPENSIVE_OPS`, the six-string `Set` that used to sit 300 lines from the
arms it gated, is deleted. The six types it named
(`create_session`, `search_project`, `search_ai_summarize`, `module_invoke_ai`,
`transcribe_audio`, `tts_speak`) each carry `expensive: true` on their
descriptor instead, and `ws-handler.js` computes
`const expensive = descriptor?.expensive === true` with nothing left to fall
back to. That correctly relocates the security control next to the type it
protects — but it also means the whole rate-limit membership rests on one
line, per descriptor, with **one unit test as its only guard**:
`test/unit/ws-message-registry.test.js` asserts `messages.expensiveTypes()`
deep-equals that exact six-element set. Deleting or mistyping the flag on a
descriptor fails that test; there is no second check. Anyone adding an
expensive message type in the future must know that test exists and extend it
— nothing else in the system will notice a forgotten flag.

## Measurements, before → after

| measurement | before (`644976f`) | after |
|---|---|---|
| `case` labels on message type in `ws-handler.js` | 44 | 0 |
| `switch` statements in `ws-handler.js` | 1 | 0 (one unrelated comment still contains the substring "switch" — "phone network switch", not a statement) |
| `ws-handler.js` line count | 787 | 144 |
| `ws/` total line count | 0 (directory did not exist) | 977, across 8 files (`message-registry.js` 91, `session-messages.js` 217, `file-messages.js` 140, `voice-messages.js` 170, `module-messages.js` 135, `search-messages.js` 99, `terminal-messages.js` 84, `diagnostics-messages.js` 41) |
| net server line change (`server.js` + `ws-handler.js` + `ws/*.js`, vs. `644976f`) | — | **+333** |
| `createWsHandler` parameter count | 13 | 12 |
| arms with zero test coverage (§9a/§9b of the phase spec) | 13 (`device_log`, `delete_file`, `create_directory`, `search_ai_stop`, `module_ai_stop`, `terminal_list`, `terminal_reconnect`, `join_terminal`, `leave_terminal`, `terminal_templates`, `tts_speak`, `tts_speak_cancel`, `transcribe_audio`) | 0 — all 13 gained coverage from the characterisation suite (`test/integration/ws-dispatch.test.js`, `test/integration/voice-ws.test.js`, `test/unit/ws-handler.test.js`) written in H1, before any production line moved |
| `claudeConfig` references (`grep -rn "claudeConfig" --include="*.js" .`) | 2 (`ws-handler.js:50`, `server.js:378`) | 0 |
| `EXPENSIVE_OPS` references in `ws-handler.js` | 1 definition + 1 use | 0 |

The phase spec's own §0 predicted **+100 to +200** net server lines, on the
theory that implementations move rather than get wrapped. The H2 checkpoint
measured +153 for 9 of 44 arms (of which 85 was one-time registry cost) and
corrected the estimate to a realistic **+220 to +260** (§11a). The real,
fully-measured number is **+333** — higher than even the corrected estimate.
Say this plainly rather than rounding it down to match a prediction: this
phase bought locality — the 394 lines of handler bodies now live next to the
protocol concern they implement instead of jammed into a dispatcher, and
`EXPENSIVE_OPS` now sits on the descriptor it protects instead of 300 lines
away — and it bought a security control that is correctly co-located with
what it guards. It did not buy brevity, and it was never expected to. The gap
between +260 and +333 is the registry's own fixed cost (`message-registry.js`,
91 lines) plus per-file overhead (module docblocks, `require`s, the explicit
loader list) repeated across seven files rather than one switch — the same
shape of overshoot `002-pane-registry.md` recorded for `tab-manager.js`, where
net client lines went up and locality, not brevity, was the stated goal.

## Accepted limits

- **C1's automated coverage is partial.** The two-connection isolation test
  drives `read_file` and `create_session` only — the file and session
  domains. Search, module and voice have code-review cover only; "nothing
  captured" stays a reviewer checklist item for those three domains rather
  than a test assertion.
- **TTS/STT success paths remain untested.** `tts_speak`'s and
  `transcribe_audio`'s *failure* paths are covered deterministically
  (`test/integration/voice-ws.test.js`, with `TTS_PORT`/`STT_PORT` pinned to
  unbound ports in the harness). The success paths need a fake
  length-prefixed-JSON TCP daemon standing in for the Kokoro/Whisper
  processes — real new harness surface, not something this phase builds.
  Deferred.

## Out of scope

Everything the phase spec named out of scope stayed out of scope:
`slash-command-handler.js`'s nested switch (different axis, different owner —
`user_input`'s descriptor calls it exactly as before), `relay-client.js`'s
relay→browser direction, adding a `default:` arm or an unknown-type error
frame (a protocol change), backpressure (not implemented today; adding it is
a behaviour change), sanitising `err.message` in the dispatcher's catch (an
existing information-disclosure surface, raised separately), per-message
schema validation, and moving `ws._ttsSpeakGen`/`ws._ttsSpeakChain` off the
socket.

**The `app.js` forwarder debt is not this phase's.**
[002-pane-registry.md](002-pane-registry.md) and `docs/handoff.md` both named
the `ws-handler.js` phase as the natural owner of
`showStopButton`/`hideStopButton`/`showSessionStarting`/`clearSessionStarting`
and their ten call sites. That assignment was wrong: those are client-side DOM
forwarders with no relationship to server message dispatch. The actual
coupling is `#userInput` living in `app.js`; moving it is a client-side phase
in its own right, not a byproduct of a server-side registry. It remains
unclaimed — see `docs/handoff.md`.
