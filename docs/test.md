# Testing Guide

Eve's hermetic suite is Playwright. Each test starts its own `fakerelay` (relay's repo), its own relayScheduler and its own eve, then drives eve only through what a person sees. It runs on Linux and macOS: fakerelay needs Unix sockets and peer credentials, so there is no Windows run. Epic #310 fills the suite; each row in `docs/FEATURES.md` names the spec that proves it.

## What runs today

| Check | Where it runs | What it shows |
|---|---|---|
| `node --check` | CI job `check`; pre-commit on staged JS; pre-push on pushed JS | every JS file parses (eve has no build step) |
| `npm run -s lint` | CI job `check`; pre-commit and pre-push (on the touched files) | the ESLint rules below |
| `npm run -s check:static` | CI job `check`; pre-push | the static guards ESLint cannot express |
| `npm run -s check:coverage` | CI job `check`; pre-push | every feature-map row names its proof, every spec test names its row |
| `npm ci` | CI job `check` | the lockfile installs |
| PR guards | CI workflow `guards` (`scripts/ci-guards.sh`) | tests-only, skip-focus and hygiene |
| `npx playwright test` | CI jobs `e2e shard 1/3` to `3/3`, graded by `e2e` (on a PR the specs its change reaches, see "Test selection"; every spec on a push to `main`); the hermetic suite (this guide) | eve against fakerelay, one stack per test |
| Devbox world | `npm run -s verify:devbox`; `devboxverify --epic REF` posts `devbox/verify-full` once per epic | journeys against the installed stack on the test machine; unchanged, see `devboxverify/README.md` |

## Local hooks

The machine's global hooks dispatcher runs `.githooks/`. Never set a repo-local `core.hooksPath`: it skips the push guard.

- **pre-commit**: when a commit stages `.js`, `.cjs` or `.mjs` files, runs `node --check` on each, then `npx eslint --no-warn-ignored` on them.
- **pre-push**: when a push's range touches `.js`, `.cjs` or `.mjs` files, runs `node --check` and `eslint` on each one still in the tree. Then, on any push that is not a branch delete, `npm run -s check:static` and `npm run -s check:coverage`. The hooks never run the browser suite.

## Browser-test lock

`verify:devbox` and, outside CI, `npx playwright test` (in its global setup) hold one machine-wide advisory lock for the whole run (`scripts/browser-lock.js`), so two browser runs never overlap. The lock file is `~/.cache/eve/browser-tests.lock` (`EVE_BROWSER_LOCK` overrides the path). A second run prints the holder's pid and command and waits up to `EVE_BROWSER_LOCK_TIMEOUT` seconds (default 1800), then gives up: `verify:devbox` exits 2 with a `PREFLIGHT lock FAIL` row. The lock is a kernel `flock` held by a small `perl` child, so `perl` must be on PATH, and the kernel drops it when the holder dies, even by SIGKILL. The lock is not reentrant, so a locked run that starts another locked run waits on itself until it times out. To clear a stuck lock, kill the holder named in the message; don't delete the file.

## Hermetic suite

Run it: `npx playwright test` (or `npm run test:e2e`). The first run builds fakerelay and relayScheduler from the pin, then every spec runs in parallel. One file: `npx playwright test test/e2e/g1-today.spec.js`. One row: `--grep "@G1\.3\b"`.

Power doors: `EVE_FAKERELAY_BIN` and `EVE_RELAYSCHEDULER_BIN` replace the pinned builds (to test a relay branch; a run prints `using EVE_FAKERELAY_BIN=<path>, not the pin`), `EVE_E2E_CACHE` moves the build cache, `--workers N` and `--repeat-each N` work as usual. CI never sets the `*_BIN` variables.

### Pin and build

`test/e2e/relay-pin.json` names the two commits (full 40-hex SHAs): fakerelay, built from relay's `fakerelay/cmd/fakerelay`, and relayScheduler. A bump of the pin is a deliberate PR and the only edit that file takes. `node test/e2e/support/build-fakes.js` prints `fakerelay <path>` and `relayscheduler <path>` and exits 0, or exits 1 naming the cause (`go not found`, `git fetch ... failed`, `go build ... failed`).

A build is `git init` + `git fetch --depth 1 <repo> <commit>` in a temp directory, `go build`, then an atomic rename into the cache: `$EVE_E2E_CACHE`, else `$XDG_CACHE_HOME/eve-e2e`, else `~/.cache/eve-e2e`, at `<cache>/<name>-<commit>/<name>`. A hit skips the build. It needs Go 1.25+. Git runs with every `GIT_*` variable dropped, so a run inside a git hook never touches eve's own repository.

### Config

`playwright.config.js`: tests in `test/e2e/*.spec.js`, fully parallel (`workers`: 4 in CI, half the cores locally), `retries: 0` (a retry would hide a flake; the trace is kept on failure), one Chromium project at 1280x720. `timeout` (30 s) and `expect.timeout` (10 s) are bounds, not waits. Global setup builds the fakes, puts their paths in `EVE_E2E_FAKERELAY` and `EVE_E2E_RELAYSCHEDULER`, and, outside CI, takes the browser lock below. `--list` runs no global setup. The browser has a fake microphone and may autoplay audio.

### Fixture API

A spec's only imports:

```js
const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds'); // optional
```

Options, set with `test.use`:

| Option | Default | Effect |
|---|---|---|
| `world` | `worlds.base()` | fakerelay world, schema 1 (`docs/fakerelay.md` in the relay repo). Setting `services` throws: the fixture owns them. `listeners.api` is off unless the world sets it. |
| `network` | `'trusted'` | `'untrusted'` sets `EVE_DISABLE_SUBNET_BYPASS=1`, so the Sign-in screen shows. |
| `scheduler` | `true` | `false` leaves relayScheduler out, for "scheduler down" refusals. |
| `publicOrigin` | `null` | Sets `EVE_PUBLIC_ORIGIN`, e.g. `'https://eve.acme.test'`. The app never reaches `data-ready` under it (the WebSocket needs that origin), so open with `eve.openByIp` or `preReady`. |
| `trustedSubnets` | `null` | Sets `EVE_TRUSTED_SUBNETS`, e.g. `'192.0.2.0/24'`, replacing the default trusted set. |
| `plansDir` | `'agent'` | `'agent'` sets `EVE_PLANS_DIR` to fakerelay's plans dir (`<relay dir>/home/.claude/plans`), where `plan` replies write. `'eve'` leaves it unset, so eve uses its own default (a plan written on another machine). |
| `eveSettings` | `null` | An object written as eve's `data/settings.json` before eve starts, e.g. `{ voice: { handsFreeReminderSeconds: 5 } }` or `{ chiefOfStaff: {...} }`. `null` writes no file. |
| `eveFiles` | `null` | An object of file name to string contents, each written into eve's data dir beside `settings.json` before eve starts, e.g. `{ 'chief-of-staff.jsonl': '<one post per line>' }` to seed Chief of Staff posts. A name with `/` or `..` throws. `null` writes nothing. |
| `cosPosts` | `null` | An array of Chief of Staff post objects, written as `chief-of-staff.jsonl` (one JSON post per line) through `eveFiles`. `null` seeds nothing. |
| `pathCommands` | `null` | Program names that resolve as an agent `command`: a list for both machines, or `{ local: [...], host: [...] }`. Each becomes an executable stub in a scratch dir that is the world's `local_path` and `host_path`, unless the world sets that key itself. Removed at teardown. `null` leaves both to fakerelay's own `PATH`. |
| `mic` | `'beep'` | What the page hears when it opens the microphone. `'beep'` is Chromium's own fake device. `'silence'` and `'speech'` replace the audio of `getUserMedia` with a looping WAV generated in code (`test/e2e/support/mic-audio.js`, no audio file in the repo): one second of silence, or 2.5 s of synthetic speech-like audio (a pulse train through moving vowel formants) followed by five seconds of silence, repeating. |
| `micBlocked` | `false` | `true` makes `getUserMedia` with audio reject with a `DOMException` named `NotAllowedError`, as when a person denies the browser prompt. It wins over `mic`. Video requests pass through. |

`worlds.media.webm()` and `worlds.media.wav()` return `{ base64 }`, a world file value of about 1 s that plays in Playwright's Chromium: `files: { 'clip.webm': worlds.media.webm() }`.

`worlds.base()` is one project `Acme` (id `p_acme`, work mode, a `README.md`) as the work default, with relay's fixed `haiku`, `sonnet` and `opus` models and the echo reply.

Fixtures, one set per test:

| Fixture | Members |
|---|---|
| `eve` | `url`; `openByIp(path = '/')` (opens `http://192.0.2.10:<eve port><path>`; support forwards the browser's requests to eve's real listener with `Host: 192.0.2.10:<port>`, so eve sees a bare-IP visit; resolves at `domcontentloaded`); `open(path = '/', { preReady, weakConnection })`, which returns once `<html data-ready="1">` is set; `reload({ preReady })`; `ready()`, which waits for `<html data-ready="1">`; `signOut()`; `setOffline(offline)`; `openAnother(path = '/')`, a second page in a new browser context with this test's context options (profile, locale, permissions) and its own storage, which returns once that page has `<html data-ready="1">` and is closed at teardown. `preReady` (a non-empty reason string) returns at `domcontentloaded`, for rows that act before eve is ready. |
| `relay` | `dir`; `cli(...argv)` (relay verbs as the feature map writes them: `cli('eve', 'list')`) and `ctl(...argv)` (presence, faults, host status, fs events, clock), both `{ code, stdout, stderr }`; `json(...argv)`; `mark()` (now, for `since`); `logs({ event, since })`; `waitForEvent(event, { since, match })`; `removePlanFiles()` (fault injection: deletes every `*.md` in fakerelay's plans dir, resolves after the unlinks with the count). |
| `desktop` | `dropFiles(target, files)`: one `DataTransfer` holding every `{ name, text?, size?, type? }` file (`size` fills zero bytes), then `dragenter`, `dragover` and `drop` on the `target` locator. Returns once `drop` is dispatched; wait on the effect (for example `file.write`). `paste(target, items)`: one `ClipboardEvent('paste')` on the `target` locator carrying one `DataTransfer`; each item is a string (`text/plain`) or a file `{ name, type?, base64 }`. Returns once dispatched; wait on the effect (the chip). `unreadableFile(name)`: writes a file with mode 0 in the test's scratch directory and returns its path. Hand it to `setInputFiles`: Chromium accepts the path, and the page's read of it fails with `NotReadableError`, as for a real file the person cannot read. Probed on this box; as root the mode would not block the read. |
| `touch` | Real touches through CDP `Input.dispatchTouchEvent`, for gestures `page.touchscreen` cannot make. `swipe(target, { dx, dy })`: touch down at the centre of the `target` locator, move by `(dx, dy)` in eight steps, lift; resolves after the lift. `hold(target, { until })`: touch down at the centre and keep the finger there until the `until` locator is visible, then lift (also if the wait fails); waits on that locator, never a duration. Use with `test.use(profiles.phone)`. |
| `passkey` | `enable()` (Chromium virtual authenticator: ctap2, internal, resident key, user verification); `credentials()`; `setPresence(ok)` (false: the next ceremony gets no presence or verification); `replace()` (a fresh, empty authenticator; returns the old one's credentials). |
| `voice` | `tts` and `stt`, each with `requests` (live), `waitForRequest(match)`, `reply(...)`, `hold({ after })` and `release()`; `mic` and `speech`, each with `stops` (live count) and `waitForStop(after = 0)`. |
| `profiles` | `phone` (Pixel 7) and `tablet` (Galaxy Tab S4), for `test.use(profiles.phone)`. |

`waitForEvent` resolves on the first fakerelay event line of that kind that `match` accepts (any line when there is no `match`). Lines already written count. The bound is the test's timeout. `EventLine` is `{ ts, level, msg, op, event, status, error?, trace_id, ...fields }`.

#### Time rows

A row about time away (idle for an hour, a 24-hour expiry, "now" versus "yesterday") installs the browser clock first, then moves it: `await page.clock.install()` before `eve.open`, `await page.clock.fastForward('01:00:00')` (or `'24:00:00'`) after, then `await eve.reload()` so eve starts again at the new time. Eve's server side does not move; `relay.ctl('clock', 'advance', MS)` moves fakerelay's clock for rows about its own time (enrolment windows, credential expiry). Never wait out real time.

#### World keys the specs use

From `docs/fakerelay.md` in the relay repo at the pinned commit (`test/e2e/relay-pin.json`); a key not listed here needs that file read first. Names are snake_case in the world and camelCase on eve's own wire.

| Key | Shape |
|---|---|
| `projects[]` | `id, name, path, kind, host_id, mode, files_read_only, allowed_mcp_ids, allowed_models, allowed_templates, chat_templates, permission_policy`, plus `files` (`{rel: string \| null (dir) \| {base64} \| {symlink}}`) and `repos` |
| `projects[].repos[]` | `{ dir, branch, commits: [{ message, files }] }`: real `git init`, `add`, `commit`; `files` is written after `repos`, so it sets the worktree state (the Changes tab) |
| `projects[].chat_templates[]` | `{ id, name, model, mode, voice, system_prompt[, preset_for] }` (`docs/api.md`); `preset_for` lists `home` or `work`; one Ask and one voice preset per mode |
| `projects[].permission_policy` | relay's per-project policy record, read back as is |
| `models[]` | `{ value, label, group, provider, reply }`; `reply` is `{ kind }` and defaults to `echo`. `haiku`, `sonnet` and `opus` are fixed in relay and always listed |
| `models[].reply.kind` | `echo` (answers `echo: <text>`); `text` (`{ text }`, a fixed answer); `permission` (`{ tool }`: raises a `permission_request` for that tool, echoes on approve; a page that joins the session while it waits is sent the request again); `hold` (no fields: the turn starts and the session runs until it is stopped or ended; no prompt); `plan` (`{ text? }`: writes `<relay dir>/home/.claude/plans/<sessionId>.md`, then a `Write` tool use and an `ExitPlanMode` tool use whose `input.plan` is `text`; no text block); `fail` (`message_complete` with `isError: true`); `exit` (`{ code: 1..255, stderr?: string[≤10] }`: the provider process exits, so the session errors and carries `exit`) |
| `sessions[]` | `{ id, project_id, name, model, state: 'idle' \| 'dormant', messages: [{ role, text }] }` |
| `terminal_templates[]` | relay's terminal template, `{ id, name, command, description, ... }`; the console's, see Terminal rows |
| `hosts[]` | `{ id, name, target, probe, tmux_path, agent: 'none' \| 'connecting' \| 'connected' \| 'unreachable', terminal_templates[], persistent_sessions: [{ name, created, attached }] }` (a session `name` is `relay-<project id>-<template id>-<n>`, `created` is epoch seconds and `attached` an integer, or the world is refused; Reattach needs a template with `persist: true`); `probe` is `{ at, ok, os, arch, home, shell, node_path, claude_path, tmux_path }`; a project joins it with `host_id` |
| `audit[]` | verbatim audit rows appended at start: `id, ts, event, actor { kind, auth, ... }, outcome, scope` plus the optional keys of the row shape |
| `chief_of_staff` | `{ project_id, model, daily_model_calls }` |
| `default_project` | `{ home, work }` |
| `mcps[]` | `{ id, name, transport, catalogue }` (never started) |
| `hosts[]`, `eve`, `presence`, `faults[]`, `credentials[]` | see fakerelay.md; presence and faults are also set live with `relay.ctl` |

#### Relay proof stand-ins

The feature map names relay's own commands. fakerelay serves some of them, and these are the reads a spec uses instead. Only what the world seeded or the test caused is there; there is no host-wide view.

| Real relay | In a spec | Notes |
|---|---|---|
| `relay session list` | `(await relay.json('ctl', 'state', '--json')).sessions` | array of the sessions fakerelay holds, seeded and created |
| `relay terminal list` | `(await relay.json('ctl', 'state', '--json')).terminals` | array; `[]` when none is open; the verb itself is not served (relay gap R15) |
| `relay model list` | `await relay.logs({ event: 'model.list' })` | one line per `GET /api/models`, so it shows eve asked; the fixed `haiku`, `sonnet`, `opus` are not in the state. `state.models` holds only the models the world added (`null` when none) |
| `relay audit` | `await relay.cli('audit', '--json', ...)` | `{ code, stdout, stderr }`; `stdout` is one JSON row per line. Reads only the rows the world seeded plus the `file_op` and `control_decision` rows fakerelay writes. Flags: `--tail N`, `--project ID`, `--event E`, `--outcome O` |
| `relay project create` / `edit` | `relay.cli('project', 'create' \| 'edit', ...)` | `--file F` reads the body; a widening edit asks `project.grant` presence |
| `relay terminal stop` / `log` | `terminals` of the ctl state above (a stop is the row leaving the list); a log is the `terminal.log` event | the verbs are not served (R15); no read of the bytes a terminal received |
| `relay host disconnect` | `await relay.ctl('host', 'status', '--id', H, '--status', 'unreachable', '--error', 'disconnected')` | the verb is not served (R16); the status frame is what eve sees |
| `relay terminal persistent-list` / `persistent-kill` | event `session.persistent.list` / `session.persistent.kill`, then `hosts[].persistent_sessions` in ctl state | the verbs are not served (R15) |
| `relay mcp list` | `relay.cli('mcp', 'list')` | |
| `relay eve list` / `revoke` | `relay.cli('eve', 'list')` | |

#### `relay.ctl` and faults

`ctl` reaches fakerelay's control socket. Each call resolves to `{ code, stdout, stderr }`; `code` 0 is success. Arguments are the argv of `fakerelay ctl`, one string each:

| Call | Effect |
|---|---|
| `ctl('fault', 'add', '--route', R, '--mode', M, ...)` | adds a fault; `stdout` is `{"id":"f1"}` |
| `ctl('fault', 'clear')` / `ctl('fault', 'clear', '--id', ID)` | removes all faults / one |
| `ctl('fault', 'release', '--id', ID)` | lets a held (`slow`) request go |
| `ctl('presence', 'project.grant=approve')` | sets the outcome per gated op (`approve`, `deny` or `timeout`; `project.grant`, `eve.enrolment.open`, `eve.passkey.revoke`); replaces the whole map; an absent op is `deny` |
| `ctl('host', 'status', '--id', H, '--status', S, '--error', TEXT)` | sets an SSH host's status; answers after the frame went to every `/ws/files` connection |
| `ctl('fs-event', '--project', P, '--path', PATH, '--kind', K)` | sends a file-change event; stdout is `{"delivered":N}` |
| `ctl('clock', 'show')`, `('clock', 'set', RFC3339)`, `('clock', 'advance', MS)` | moves fakerelay's clock (enrolment windows, credential expiry) |
| `ctl('state', '--json')` | the live state |

A fault is `--route` (required), `--mode` and these optional flags: `--times N` (applications; absent or 0 means until cleared), `--delay-ms N`, `--status N` with `--body JSON`, or `--name NAME`.

- `--route` is a registered pattern such as `GET /api/projects`, `*` (every frontend route), `BRIDGE <Type>` or `PROXY <manifest prefix>`. A route ending in `/` matches by prefix; any other matches exactly.
- `--mode down` closes the connection with no answer. `--mode error` answers `--status` and `--body`, or a `--name`: `HOST_UNREACHABLE` (503), `TIMEOUT` (504), `AUDIT_UNAVAILABLE` (503), `ERROR` (500), `unavailable` (503), `bad_gateway` (502), `presence_refused` (403), `not_found` (404). `--mode slow` holds the request until `release`, or for `--delay-ms` when given.
- Example: `await relay.ctl('fault', 'add', '--route', 'GET /api/projects', '--mode', 'down')`. Clear it with `ctl('fault', 'clear')`.
- Wait for a hold, never sleep: `await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'held' })`. Every application also writes a `fakerelay.fault` line with `fault_id`, `route`, `mode` and `action` (`applied`, `held` or `released`).
- A fault applies from the next request. Add it before the action that makes the request, and the fault lasts for the test (each test has its own fakerelay).

#### Sign-in rows

`<html data-ready="1">` is set by the app once the first `ready` frame (the startup state the server pushes over the socket, carrying the projects and sessions) has been applied. It is never set while relay is unreachable at load, so a spec that opens that way uses `preReady`. The WebSocket only opens after sign-in, so on the Sign-in and Set Up Passkey screens (`network: 'untrusted'`) the flag is never set, and `eve.open('/')` would wait out the test. A row that starts on those screens opens with `eve.open('/', { preReady: '<reason>' })` and asserts on the screen by role. Once the row signs in, wait for the app with `await eve.ready()` before acting on anything that needs the loaded app. A row that does not start on a sign-in screen never uses `preReady`.

A row that needs a signed-out browser with a passkey enrols first, then calls `await eve.signOut()`. It throws under `network: 'trusted'`. The Sign-in screen loads with heading "Sign In", and the authenticator still holds its passkey. A row about a second browser ("Add this browser", revoking another browser's passkey) uses the same page: `eve.signOut()`, then `passkey.replace()`, which returns the first browser's credentials. To eve, that page is a new browser.

#### Voice rows

- Dictation: eve discards a recording shorter than 300 ms ("Recording too short"), and nothing reaches the fake STT. The button is named "Stop recording" at once and renames itself to `Recording... 0:01` on the one-second timer tick, so wait for `getByRole('button', { name: /^Recording\.\.\./ })` before pressing it. A button press right after "Stop recording" shows sends no audio.
- The fake STT's `requests` list shows what reached it; `waitForRequest` waits on that, not on a duration.
- Inject an engine error with `voice.stt.reply({ error })` or `voice.tts.reply({ error })` before the action. The expected text comes from the row.
- A blocked microphone: `test.use({ micBlocked: true })`. The launch flags accept every real prompt, so the fixture rejects the call instead.
- Hands-free (`getByRole('radio', { name: 'Hands-free' })`): the status region "Voice status" holds the orb (button "Voice orb"), the text "Listening…" / "Thinking…" / "Speaking…" and, only while speaking, the button "Stop reply". "Listening…" appears when listening has started. With `mic: 'speech'` the VAD hears the sentence; the signal is the fake STT's `waitForRequest` and then the spoken turn with its "Spoken" mark. With `mic: 'silence'` the VAD hears nothing, so a spec of the silence reminder sets `eveSettings: { voice: { handsFreeReminderSeconds: 5 } }` and waits on `voice.tts.waitForRequest` for the text "I'm still here.". The fake TTS reply is 30 s of silence, so "Speaking…" lasts until Stop or its end.

`voice.mic` counts the page stopping the fake microphone track (only with `mic: 'speech'` or `'silence'`; Chromium's own `'beep'` device is not wrapped). `voice.speech` counts the page stopping a spoken reply (a non-looping `AudioBufferSourceNode.stop`). Counts only grow, so read `stops` before the action and pass it: `waitForStop(before)` resolves once a later stop has happened and cannot miss one that came early. Both are no-ops for specs that never read them.

Fake TTS and STT speak the length-prefixed JSON protocol of `tts-service.js` and `stt-service.js`, on `127.0.0.1` with a free port. TTS answers every synth with a silent 30 s WAV and `list_voices` with two voices, "Heart" and "George". STT answers `ping` with ok and every transcription with `hello from the test microphone`. `reply({ seconds })`, `reply({ text })` or `reply({ error })` changes the answer for later requests. `hold({ after = 0 })` holds the answer to later synth or transcription requests, after letting `after` through; each is still recorded at once, so `waitForRequest` fires; a new `hold` first releases an earlier one. `release()` answers every held one and ends the hold; teardown releases any left.

#### Network rows

`await eve.setOffline(true)` takes the browser off the network, as a person losing signal. `setOffline(false)` brings it back. Assert on the screen with `expect`, never a duration. `eve.open('/', { weakConnection: true })` fails the first load of one core script, so the page never becomes ready. After the person presses Reload, wait with `await eve.ready()`.

#### Terminal rows

A terminal is an echo terminal, not a shell. Input comes back as output, byte for byte, except `\r`, which comes back as `\r\n`. A line is the bytes since the last `\r`. A line of `exit` or `exit N` (N 0 to 255) echoes, then the terminal exits with N; `exit 300` is only echoed. `\x04` on an empty line exits 0 with no echo; in the middle of a line it is dropped. Bytes after the exit are dropped. Nothing reads what a terminal received, so proof is what the echo shows on screen. xterm acts on echoed escapes, so key-bar bytes show: Tab moves to the next tab stop, left arrow and shift-Tab move the cursor back, Home moves it to the line start, an OSC title sets the title. `\x03`, Page Up and Page Down echo bytes xterm draws nothing for, so the screen does not change.

- `(await relay.json('ctl', 'state', '--json')).terminals` rows are `{ id, templateId, name, directory, state: 'running' | 'stopped', exitCode? }`; `exitCode` only when not 0. A stopped terminal stays in the list until it is closed. The row has no `host` or `origin`.
- `session.launch` (`kind: 'terminal'`, `session_id`) is written on open. On exit fakerelay writes `session.exited` (`session_id` is the terminal id) before the viewers hear `terminal_exit`. `terminal.log` is written when the log is read. The log keeps every byte sent, also after close.
- Eve's close (the `terminal_close` frame) writes no event and answers every page with `terminal_closed`. Nothing relay sends marks the close, and a second page's board keeps the row (eve treats `terminal_closed` as an exit), so a spec waits with `expect.poll` on `ctl state .terminals[]` until the row is gone.
- `terminal_templates` in the world are the console templates. A project sees all of them when `allowed_templates` is empty, only the listed ids otherwise (`['*']` is all). A host project sees its host's `terminal_templates` and never the console's. A template outside the list is refused 403 `{"error":"terminal template \"<id>\" is not available for this project"}`.
- Fault routes: `GET /api/terminal/templates`, `POST /api/terminals`, `GET /api/terminals/{id}/log`, `POST /api/hosts/{id}/pastetmp`, `GET /api/projects/{id}/persistent-sessions`, `DELETE /api/projects/{id}/persistent-sessions/{name}`, `POST /api/projects/{id}/files/<op>` (`list`, `stat`, `read`, `write`, `mkdir`, `rename`, `move`, `delete`, `search`, `git`), `GET /api/models`, `POST /api/sessions`, and tasks as `PROXY /api/tasks` (list, create) or `PROXY /api/tasks/` (one task, its run, history and delete; the longest matching manifest route). A file route's error body is `{"error": TEXT, "code": CODE}`; other routes use `{"error": TEXT}`.

#### Host rows

- State: `ctl state --json` has `hosts[]` (the world rows with `root`; `agent` is the world's initial value) and `host_status`, a map `{ [hostId]: { status, error? } }` that holds the live state. Read `host_status`, not `hosts[].agent`. `persistent_sessions` in `hosts[]` loses a row once it is killed.
- A host project is `{ host_id, path, files, repos }`. `files` and `repos` live under the host's own root. Its terminals and files run there.
- Status is `connecting`, `connected` or `unreachable`. With agent `none`, the first file op or watch moves the host to `connecting`, then `connected`. `ctl('host', 'status', '--id', H, '--status', S, '--error', TEXT)` answers after the frame has reached every `/ws/files` connection, so the page has it by then. It sets any of the three; any other value is refused 400.
- While a host is `connecting` or `unreachable`, a file op answers 503 `{"error":"host is not connected","code":"HOST_UNREACHABLE"}` and a watch fails with that code. Persistent list and kill: 502 `{"error":"host unreachable"}` only when the host is `unreachable` (or its probe failed); 409 `{"error":"host has no tmux"}` when neither the host nor its probe has a `tmux_path`; kill of a missing name 404, of a malformed name 400.
- A host chip's dot is an image named with the status word. Today's project chip and a palette option are named by the project only, so find the dot inside them. Their accessible description is the host name, a space, then the status word, e.g. `testbox connected`; a console project's is empty.
- `session.delete` is written when a thread is deleted.
- `session.persistent.list` and `session.persistent.kill` carry `project_id`. `host.pastetmp` carries `host_id`. File ops write `file.*`.
- `attached_here` is always `false` on a persistent row, though relay sets it when a live terminal carries the name. A spec cannot see an attached-here state.

#### Routine rows

A routine run is a session started by the scheduler, so it reaches fakerelay as `POST /api/sessions` and is the project's session on the routine's model. A run on a model whose `reply` is `{ kind: 'hold' }` stays running until it is stopped, with no prompt; a `{ kind: 'permission', tool }` run also stays running, at its permission request, and a page that opens its thread shows that prompt. `echo` finishes at once. A failed run: add `ctl('fault', 'add', '--route', 'POST /api/sessions', '--mode', 'error', '--times', '1', '--status', '500', '--body', '{"error":"boom"}')` before pressing Run Now, then wait for the `fakerelay.fault` line with `action: 'applied'`. Task events reach the page over `/ws/tasks`; a spec waits on what the page shows.

#### Layout rows

- Widths: wide is 1024 px and up, regular is 600 to 1023, compact is under 600. `page.setViewportSize` after `eve.open` re-lays out the page live. `profiles.phone` is 412x839 (compact) and `profiles.tablet` is 712x1138 (regular). Both have touch, which the `touch` fixture needs.
- A closed menu slides off-screen and still counts as visible. Check the Rail and the Project panel with `toBeInViewport()` and `not.toBeInViewport()`, never `toBeVisible`.
- At regular width the dimmed area is a full-window layer with no role. Tap a point to the right of the panel's `boundingBox` with `page.mouse.click` or `page.touchscreen.tap`. At compact width the menu is a full-screen sheet and there is no dimmed area.
- An edge swipe opens the menu only when the touch starts less than 30 px from the left edge and moves more than 60 px right, with no more movement down than across. A swipe closes it when the touch moves more than 60 px left, from anywhere. `touch.swipe` starts at the target's centre.
- The pane divider and the panel's edge have no role. Drag them with `page.mouse` at the shared edge of the two panes' boxes, or at the panel's right edge. A pane is at least 140 px. The panel is 200 to 600 px, and its width survives a reload.
- A tab drag uses pointer events: `page.mouse.down` on the tab, then a move of 8 px or more, in steps, onto an edge of the content.
- Close a tab from the keyboard with `ControlOrMeta+w`. An unsaved file tab raises a native confirm; handle it with `page.once('dialog', ...)`.
- Front door: a missing stamp counts as away, so a fresh test context opens on Today. A reload after `page.clock.fastForward` does not count as away, because eve stamps on `pagehide` at the moved time. Nothing hides and shows a page, so the resume path has no test.
- Appearance: compare `toHaveCSS('background-color', ...)` on an element found by role, before and after. Auto follows `page.emulateMedia({ colorScheme })`. Light and dark are proven by a brightness range (each rgb channel 192 or more for light, 64 or less for dark), never an exact colour. Text size: the font-size equals the size the slider names, in px.

#### Phone rows

- The Safari fallback page: `eve.open('/api/auth/safari-login', { preReady: '<reason>' })` under `network: 'untrusted'`, with a passkey already enrolled. The page starts the ceremony itself half a second after load, shows "Success! Returning to app…", then sets the location to `relayclient://...`, which Chromium cannot open.
- Dragging a finger on the terminal scrolls its history. Target a visible echoed line.
- Chromium has no soft keyboard, haptics, screen lock or native audio. Rows that need them are not testable here.

#### Changes rows

The Changes tab and the diff pane (a file row opens the diff).

- A world repo is `projects[].repos[]` with `files` laid over it (see World keys). The repo has one branch, nothing staged and nothing deleted. On `main`, "vs base" lists the same files as "Uncommitted".
- Git failures are faults on the literal route `POST /api/projects/{id}/files/git` (type `{id}` as written, it matches every project). Add one through `relay.ctl('fault', 'add', ...)` before the action that loads the list (see `relay.ctl` and faults):

| Screen shows | Fault flags |
|---|---|
| "Git is not installed on this machine." (the note replaces the list) | `--mode error --status 500 --body '{"error":"file operation failed","code":"GIT_MISSING"}'` |
| "git timed out" | `--mode error --name TIMEOUT` |
| "Too many changes to list" | `--mode error --status 413 --body '{"error":"File too large","code":"TOO_LARGE"}'` |
| "internal error" (relay's own reason) | `--mode error --name ERROR` |

- An agent's edit while the tab is open: `await relay.ctl('fs-write', '--project', P, '--path', REL, '--content', TEXT)` writes the file as a process outside relay would. It answers `{path, kind, delivered}` once the `fs_event` is on the wire, so the page has been told by then; wait for the row on screen, never a duration. `kind` is `rename` for a new file, else `change`. Parent folders must already exist (a missing one is `ENOENT`).
- The diff opens side by side at 768 px wide and wider, inline below that.
- Diff-ready signal: the button "Ask about this" is disabled until the diff is computed, and enabled once it is. It stays disabled for a diff with no line changes and is hidden for a binary file, a too-large file and a host project, so wait on it only for a text change.
- Limits: a file over 2 MiB (in world `files`) shows "File too large to diff". A text diff over 256 KB opens, but "Ask about this" answers "That's too large to attach (over 256 KB)."

#### Request shapes a spec can match on

Each entry in `voice.tts.requests` and `voice.stt.requests` is the parsed JSON object eve sent, with eve's field names. `ping` requests are not recorded.

- TTS synth: `{ text, voice, speed }`, plus `trace_id` when eve has one, `instruct` when set, and `gain` when it is not 1.0. It has no `action` field. `voice` defaults to `af_heart` and `speed` to `1.0`. Match with `waitForRequest((r) => r.text === '...')` or on `r.speed`.
- TTS voice list: `{ action: 'list_voices' }`.
- STT transcription: `{ audio_base64 }`, plus `trace_id`, plus `language` when one is chosen. It has no `action` field. `audio_base64` is the recording in whatever format the browser recorded (any format ffmpeg decodes), not a WAV; match on its presence or length, not its bytes.
- STT availability check: `{ action: 'ping' }`. The fake answers it but does not record it.
- Replies: TTS `{ success, audio_base64, sample_rate, duration }`; STT `{ success, text, language, duration }`; an error reply is `{ success: false, error }`.

Specs never touch `context.newCDPSession`, child processes or the file system; those live in `test/e2e/support/`.

### What each test gets

Under one temp root (`<tmp>/ev-XXXXXX`): `r/` (fakerelay's config dir, with `world.json`, `ready.json`, `logs/`), `eve/` (`EVE_DATA_DIR`), `sched/` (relayScheduler's data), `home/` and `tmp/`. fakerelay starts with a scrubbed environment (`PATH`, `HOME`, `TMPDIR`, `TZ=UTC`) and launches relayScheduler and eve with the fd 3 launch secret, so eve's launch-identity path runs in every test. Eve binds `127.0.0.1` (`EVE_BIND_HOST`) on a free port. The fixture fails by name if a socket path would pass 103 bytes.

Readiness is signalled, never slept on: fakerelay's ready line, `eve-ready.json`, and relayScheduler's `service.manifest.register` event, each raced against the service's failed state and fakerelay's exit. Teardown sends SIGTERM to fakerelay (it stops eve and relayScheduler) and waits for its exit event; a run still alive after 15 s is killed and the overrun attached.

A failed test attaches `eve.log`, `fakerelay.log`, `relaysessions.log`, `relayscheduler.log` (when on) and `fakerelay.stderr`; the trace is kept (`retain-on-failure`). Worlds use neutral names only (Acme, testbox): CI uploads these as public artifacts.

A setup failure throws a named error: `fakerelay exited <code> before ready: <stderr tail>`, `eve exited <code> before eve-ready.json; see eve.log`, or `relayScheduler exited <code> before its manifest was registered; see relayscheduler.log`.

## Lint rules and checks

`npm run lint` is `eslint .`. `eslint.config.js` sets `noInlineConfig` (an `eslint-disable` comment has no effect) and `reportUnusedDisableDirectives`. Server code and tests parse as CommonJS, `public/**/*.js` as script.

| Rule | Files | Forbids |
|---|---|---|
| E1 file plane | root `*.js`, `ws/`, `routes/`, `mcp/`, except the allowlist | `require` of `fs`, `fs/promises`, `child_process` (also with `node:`), `@vscode/ripgrep`, `trash`; `import('trash')`. The allowlist is the config object named "E1 allowlist", each file with its reason as a comment. |
| E2 iframe sandbox | `public/**/*.js` | a string or template text containing `allow-same-origin` |
| E3 no fixed waits | `test/e2e/**` | `waitForTimeout` on any receiver |
| E4 raw relay egress | the E1 files, except `relay-transport.js` | bare `fetch()`, `new WebSocket()`, `http`/`https` `.request()` or `.get()`, `require('undici')`. Voice's `net.Socket` stays allowed. |
| E5 screen only | `test/e2e/*.spec.js` | `locator`, `frameLocator`, `getByTestId`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `$`, `$$`, `$eval`, `$$eval`, `waitForSelector`, `evaluate`, `evaluateAll`, `evaluateHandle`, `waitForFunction`, `addInitScript`, `addScriptTag`, `exposeFunction`, `exposeBinding`, `route`, `routeWebSocket`, `unroute`, `request`, `goto`, `newCDPSession` on any receiver; `reload` on any receiver but `eve`; destructuring any of them; a `request` fixture parameter |
| E6 spec imports | `test/e2e/*.spec.js` | any `require` but `./support/fixtures` and `./support/worlds`, and any `import` |

Allowed in specs: `getByRole`, `getByLabel`, `getByText`, `filter`, `first`/`last`/`nth`, `page.keyboard`, `page.mouse`, `page.touchscreen`, `toHaveCSS`, `toBeInViewport`, `page.emulateMedia`, `page.setViewportSize`, `page.clock`, `page.goBack`, `page.once('dialog')`, `setInputFiles`, `boundingBox` (geometry rows), `toHaveJSProperty('duration', ...)` on a media element found by label, `expect`, and the fixtures (`eve.open`, `eve.reload`, `eve.ready`, `eve.signOut`, `eve.setOffline`, `eve.openByIp`, `eve.openAnother`, `relay`, `desktop` (incl. `desktop.paste`, `desktop.unreadableFile`), `passkey`, `voice`, `touch`).

`npm run check:static` (`scripts/check-static.js`, plain Node) holds the rest. One finding per line, `<check>: <file>[:<line>]: <what>`; exit 0 clean, 1 findings, 2 usage or an unreadable input. The frozen sets are in `test/static/frozen.json` (`wsTypes`, `expensiveTypes`, `asyncHandlers`, `breakpoints`, `journeys`), so a deliberate change shows in the diff.

| Check | Holds |
|---|---|
| S1 | the E1 allowlist names only files that exist; the removed local file-plane modules stay absent |
| S2 | no `public/**/*.html` iframe `sandbox` contains `allow-same-origin`; the preview pane and editor iframes are exactly `allow-scripts`; the PDF viewer's unsandboxed iframe is the one exclusion |
| S3 | `public/` holds no `auth.json`, `sessions.json`, `settings.json`, `.env`, `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, and no `data/` or `certs/` |
| S4 | every width media query in `public/**/*.css` is in `frozen.breakpoints` |
| S5 | the client message types equal `frozen.wsTypes`, and each is named in `docs/api.md` |
| S6 | the expensive types equal `frozen.expensiveTypes`; the async handlers equal `frozen.asyncHandlers` |
| S7 | every tracked file is in an area or `quiet` in `docs/areas.jsonc`; every app file (under `public/`, `routes/`, `ws/`, `mcp/`, or a root `*.js` that is not `*.config.js`; never `*.md`) is in an area, not only `quiet` (rule M4); every journey area exists; the smoke set stays plain journeys, and `chat-reply` runs before `open-existing-thread` and `listen` |
| S8 | the devbox journey set (ids, needs, areas, timeout, screen and fixture flags, run order) equals `frozen.journeys` |
| S9 | no journey function body in `devboxverify/journeys.js`, `journeys-auth.js` or `journey-kit.js` names a world fixture directly |
| S10 | `node .claude/hooks/eve-test-writer-guard.js --self-test` exits 0 |
| S11 | every `test/static/*-selftest.js` exits 0 |

Guards 9 (burn-in), 7, 8 and 12 are the CI `e2e-burn-in` job and E5, E3 and E4. A deliberate change to a frozen set edits `test/static/frozen.json` in the same PR.

## Coverage

`npm run check:coverage` (`scripts/check-coverage.js`) ties `docs/FEATURES.md` to the specs. It reads the row tables, "Retired IDs", `test/e2e/coverage-pending.txt`, the tests from `npx playwright test --list --reporter=json` (no global setup, no browser) and the journey ids in `frozen.json`. One finding per line, `<ID or file>: <what>`; exit 0, 1 or 2 as above. `docs/FEATURES-iOS.md` is out of scope: its rows are not counted, and the check fails a row there whose Simple door neither starts with "iOS app" nor is "n/a: background", whose Power door is not `none` or `n/a...`, whose Spec does not start with `none yet`, or whose ID is malformed or also live in `docs/FEATURES.md` (a `G<n>.<n>.r<k>` refusal entry needs a live parent).

A test names its row in its title: `test('greeting and summary line @G1.3', …)`. A refusal is `@G1.3.r1`. The Spec cell grammar is in `docs/FEATURES.md`, "How to read a row".

- A row ID is `G<n>.<n>`, unique, and not retired.
- A `none yet` row passes only while its goal is in `test/e2e/coverage-pending.txt` (`G<n> #<issue>`). The list only shrinks: a child removes its own goals when it lands, and a listed goal whose rows all name a proof is a finding. At the end of epic #310 the file is empty.
- A `<name>.spec.js` item is a file in `test/e2e/` with a test tagged for that row. A `devbox: <id>` item names a journey in `frozen.journeys`.
- Every test carries at least one row tag, every tag names a live row (and an `r<k>` that row has), and that row's Spec cell names the test's file.
- Once a goal is off the pending list, every refusal `r<k>` of its rows is tagged by a test in a named file, unless the cell has a `devbox:` item.

The same command holds the map rules (`scripts/spec-map.js`; M4 is S7 above). A spec's areas are the `Areas` cells in the Goals table of the goals whose rows name it.

| Rule | Holds |
|---|---|
| M2 | every spec named by a row resolves to at least one area defined in `docs/areas.jsonc`; no tracked `*.spec.js` lies outside the top level of `test/e2e/` |
| M3 | every area that is not `full` and not journey-only is listed by a goal and selects at least one spec; an area waits while any goal listing it is in `coverage-pending.txt` |
| M5 | every area that is not `full`, journey-only or listed under Pending has a break in `test/map-proof/breaks.json` (a file in one of the area's code globs) and a row in `docs/map-proof.md`; every journey-only area is listed in its "Journey-only areas"; a Pending line names the goals that list the area and the issues `coverage-pending.txt` gives them, and an area with a Pending line has no proof row; the area may be Pending only while every goal listing it is on `coverage-pending.txt` |
| syntax | every area in the Goals table is defined in `docs/areas.jsonc`; "## Areas" in `docs/FEATURES.md` has one `Journey-only:` line, `none` or a comma-separated list of defined areas |

### Test selection

`node scripts/select-specs.js (--base REV [--head REV] | --full) [--labels-json JSON] [--env FILE] [--summary FILE]` picks the specs a PR's e2e job runs. It prints `AREAS`, `SPECS <n>/<N>`, `UNMAPPED <path>`, `NARROWED <path> <spec,...>` and, on success, `RUN all|none|<paths>`. Exit 0 selected; 1 a map finding, an unmapped path or narrowing without the label; 2 usage or a git error, such as a shallow clone. No error path runs the whole suite. `--env` appends `SELECT_MODE` and `SELECT_SPECS`; `--summary` appends the job summary.

Per changed path (`git diff --no-renames --name-only -z base...head`):

1. A spec at head runs itself.
2. A spec-harness file (`test/e2e/support/**`, `test/e2e/relay-pin.json`, `playwright.config.js`, `scripts/browser-lock.js`) runs every spec. A `devboxverify/` file other than `*.md` runs none: Playwright never loads it, and the devbox run grades it.
3. Any other path takes the areas of the base map plus the head map. In no area and not `quiet` in either: `UNMAPPED`. A `full` area runs every spec. `quiet` only runs nothing. Otherwise it runs every spec present at head that the rows of a goal listing the area name, in either map.
4. Narrowing is read at the merge base and at head. For each tracked file at head, a spec the merge-base map selects and the head map does not is `NARROWED`, and so is an area added to `Journey-only:`. The PR label `map-narrowing-approved`, applied only by the owner, allows it.

Two more checks read the merge base and head. A goal at head that `test/e2e/coverage-pending.txt` lists and the merge base does not is `NARROWED pending:<goal>`; an area under "## Pending" in `docs/map-proof.md` that the merge base does not list is `NARROWED pending-area:<area>` (skipped when the merge base has no `docs/map-proof.md`). Both need the `map-narrowing-approved` label.

`node scripts/map-proof.js (--areas a,b | --all) [--base REV] [--record docs/map-proof.md]` runs the map proof (`docs/map-proof.md`): it breaks one line per area in a detached worktree and prints `PROVEN`, `GREEN`, `BASE-RED` or `REFUSED` per area; exit 0 all proven, 1 otherwise, 2 usage, git, `npm ci` or build errors.

A push to `main` runs every spec (`--full`). The M2 to M5 checks run in the `check` job, so a gap in the map fails there as well.

## CI and hooks

`.github/workflows/ci.yml`:

- `check`: `npm ci`, `node --check` on every tracked JS file, `npm run -s lint`, `npm run -s check:static`, `npm run -s check:coverage`.
- The hermetic suite (every PR and every push to `main`; Ubuntu) runs as parallel jobs, graded by one job named `e2e`:
  - `e2e-select` runs `select specs` once (`--base`/`--head` on a PR, `--full` otherwise; see "Test selection"), which fails the run on an unmapped path or unapproved narrowing before any spec runs. Its summary lists the areas, the specs run and the count not run, and its outputs (`SELECT_MODE`, `SELECT_SPECS`) feed every shard, so each shard splits the same list.
  - `e2e-fakes` builds fakerelay and relayScheduler from the pin into the build cache and saves it with `actions/cache`, keyed on `test/e2e/relay-pin.json`; a hit skips the build. The shards and the burn-in restore it and never build or install Go.
  - `e2e shard 1/3`, `2/3` and `3/3` (30 minutes each), unless the mode is `none`: each installs Chromium and runs `npx playwright test --shard=<n>/3 --reporter=list,blob` (mode `all`) or the same with `$SELECT_SPECS`. Playwright splits the selected tests evenly, so each test runs in exactly one shard; a shard the selection leaves empty runs nothing and passes.
  - `e2e-burn-in` (a PR only, in parallel with the shards, 30 minutes): `node scripts/burn-in-specs.js "$BASE_SHA" "$HEAD_SHA"` lists the specs the PR adds or changes (top-level `test/e2e/*.spec.js` only), and `npx playwright test --repeat-each=5 --retries=0 <specs>` runs them. A change to `test/e2e/support/` or `playwright.config.js` lists none, and the job passes without installing a browser.
  - `e2e` needs all four and always runs. It fails when any of them failed or was cancelled; a skip passes only for the shards when the mode is `none` and for the burn-in off a PR. This is the status branch protection and `merge-check` read. On failure it merges the blob reports the failed jobs uploaded (`npx playwright merge-reports --reporter html`) into one `e2e-report` artifact, traces included (7 days).
  - CI skips the browser lock.
- Both workflows also run on `labeled` and `unlabeled`, so adding or removing a PR label reruns every job.
- `guards.yml` (tests-only, skip-focus, hygiene) is unchanged.

The local hooks are under "Local hooks" above.

## The eve-test-writer agent

`.claude/agents/eve-test-writer.md` writes the feature specs. It works from `docs/FEATURES.md` rows, `docs/api.md`, `docs/fakerelay.md` and this guide, and reads no eve code, so a spec says only what a person sees. Its tools are Read, Write, Edit, Bash, Glob and Grep, on Sonnet.

The rule is enforced, not requested. A `PreToolUse` hook in `.claude/settings.json` runs `.claude/hooks/eve-test-writer-guard.js` for each tool call. A `hooks:` block in the agent's own frontmatter does not fire on the Claude Code version we tested (2.1.296), so the project settings carry the hook. The hook input names the calling agent in `agent_type`; the guard exits 0 at once for any other agent or none, so other work in this repo is unaffected. The name is set both for the subagent and for `claude --agent eve-test-writer`, so the guard holds in both forms. For this agent, unparseable input is refused.

| Tool | Allowed | Refusal |
|---|---|---|
| Read, Glob, Grep | a path under `docs/`, `test/e2e/` or `test-results/`, or `CLAUDE.md`, `package.json`, `devboxverify/README.md`. No path means the repo root, which is refused. | `eve-test-writer reads docs, specs and screens, not eve code: <path>` |
| Write, Edit, MultiEdit | `test/e2e/*.spec.js`, `docs/FEATURES.md`, `test/e2e/coverage-pending.txt` | `eve-test-writer edits only ...: <path>` |
| Bash | starts with `npx playwright test`, `npm run -s lint`, `npm run -s check:coverage` or `node --check test/e2e/`; no `;`, `&`, `|`, `$(`, backtick, `>`, `<` or newline; no argument under a refused path | the read refusal for a path, else `eve-test-writer runs only ...` |

Paths resolve against the repo root, `..` is normalised and symlinks are followed before matching. `node .claude/hooks/eve-test-writer-guard.js --self-test` runs the allow and deny table; `npm run check:static` (S10) calls it.

Toasts sit in one `status` region; find one with `getByRole('status').filter({ hasText })`.
