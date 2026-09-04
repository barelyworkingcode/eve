# A message registry for `ws-handler.js`

## The decision

`WsMessageRegistry` (`ws/message-registry.js`) replaces the message-type
`switch` in `ws-handler.js` with the same register-by-key idiom as
`PaneRegistry` (register-nothing, `get()` returns a descriptor or `null`),
but loaded in batches from seven domain files (`ws/session-messages.js`,
`file-messages.js`, `search-messages.js`, `module-messages.js`,
`terminal-messages.js`, `voice-messages.js`, `diagnostics-messages.js`)
rather than one file per message type.

### Why seven domain files, not one per message type

Message types differ along one axis (what they do) plus one security
classification (`expensive`) — nowhere near the fourteen axes that justified
a `panes/*.js` file per pane type (see
[002](002-pane-registry.md)). Splitting into per-type files the way
`PaneRegistry` did would have destroyed the one thing the old `switch` was
good at: reading the whole wire protocol on one screen. Seven domain files
keep that property.

`ws/message-registry.js` loads the seven files with explicit `require`s and
a loop, not a directory scan like `PaneRegistry` uses: a typo becomes a
`MODULE_NOT_FOUND` at boot instead of a silently-missing message type, and
there's no `global.*` write to reason about under Jest's per-suite module
registry.

### Why `ping` and `auth` are not descriptors

`ping` must answer before the auth gate and the rate limiter; `auth`
mutates `isAuthenticated`, a connection-scoped closure variable the
dispatcher's own gate reads. Neither the ordering nor that mutation
capability is expressible through a descriptor, and making it expressible
would hand every other message type a capability it must not have. They
stay as `if` guards in `ws-handler.js` itself, ahead of the registry lookup.

## Constraints, stated outright

**C1 — a descriptor must never capture connection-scoped state.**
Descriptors are created once per *process*, at `require` time, before any
socket exists. `ws`, `req`, `relayClient`, `fileWatcher`, and the
inflight-id sets are per-*connection* and must reach a handler only through
`ctx`, passed fresh on every call. A module-level variable, something closed
over outside `handle`, or a `ctx` stashed on the descriptor binds the
*first* connection and serves every later one from it — one user's socket
receiving another user's file contents, terminal output, or LLM stream.
Nothing throws; the leak is silent and only shows up with two concurrent
connections. `test/integration/ws-dispatch.test.js`'s two-connection
isolation suite is what catches this class of bug — it exercises every
domain (file, session, search, module, voice, terminal).

**C2 — a descriptor's `handle` is only `async` if the pre-registry `case`
arm was `await`ed.** Exactly three types were: `create_session`,
`module_read_file`, `module_write_file`. `ws-handler.js` does
`await descriptor.handle(ctx)` unconditionally; making a fourth handler
async would turn what was an unhandled rejection into a browser-visible
`{type:'error'}` frame — arguably better, but a protocol change, and out of
scope here. `test/unit/ws-message-registry.test.js` asserts
`handle.constructor.name === 'AsyncFunction'` iff the type is one of the
three.

**C3 — `descriptor.expensive` is the sole source of rate-limit truth.**
There is no fallback list. The six types that carry `expensive: true`
(`create_session`, `search_project`, `search_ai_summarize`,
`module_invoke_ai`, `transcribe_audio`, `tts_speak`) are asserted by
`test/unit/ws-message-registry.test.js`'s `expensiveTypes()` check — that
test is the only thing that would catch a forgotten or mistyped flag on a
new expensive message type.

## Accepted limits

TTS/STT success paths are untested — `test/integration/voice-ws.test.js`
covers only the deterministic failure paths (the harness pins
`TTS_PORT`/`STT_PORT` to dead ports). Exercising the success path needs a
fake length-prefixed-JSON TCP daemon standing in for Kokoro/Whisper; no such
fixture exists in this repo.

## Out of scope

`slash-command-handler.js`'s nested switch is a different axis with a
different owner — `user_input`'s descriptor calls it exactly as before.
Adding a `default:`/unknown-type error frame, backpressure, and
per-message schema validation are all protocol/behaviour changes, not done
here.
