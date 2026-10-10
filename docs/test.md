# Testing Guide

Eve's hermetic suite is Playwright. Each test starts its own `fakerelay` (relay's repo), its own relayScheduler and its own eve, then drives eve only through what a person sees. It runs on Linux and macOS: fakerelay needs Unix sockets and peer credentials, so there is no Windows run. Epic #310 fills the suite; each row in `docs/FEATURES.md` names the spec that proves it.

## What runs today

| Check | Where it runs | What it shows |
|---|---|---|
| `node --check` | CI job `check`; pre-commit on staged JS; pre-push on pushed JS | every JS file parses (eve has no build step) |
| `npm ci` | CI job `check` | the lockfile installs |
| PR guards | CI workflow `guards` (`scripts/ci-guards.sh`) | tests-only, skip-focus and hygiene |
| `npx playwright test` | the hermetic suite (this guide) | eve against fakerelay, one stack per test |
| Devbox world | `npm run -s verify:devbox`; the `devbox/verify` status check on PRs | journeys against the installed stack on the test machine; unchanged, see `devboxverify/README.md` |

## Local hooks

The machine's global hooks dispatcher runs `.githooks/`. Never set a repo-local `core.hooksPath`: it skips the push guard.

- **pre-commit**: when a commit stages `.js`, `.cjs` or `.mjs` files, runs `node --check` on each.
- **pre-push**: when a push's range touches `.js`, `.cjs` or `.mjs` files, runs `node --check` on each one still in the tree.

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

`worlds.base()` is one project `Acme` (id `p_acme`, work mode, a `README.md`) as the work default, with relay's fixed `haiku`, `sonnet` and `opus` models and the echo reply.

Fixtures, one set per test:

| Fixture | Members |
|---|---|
| `eve` | `url`; `open(path = '/', { preReady })`, which returns once `<html data-ready="1">` is set; `reload({ preReady })`. `preReady` (a non-empty reason string) returns at `domcontentloaded`, for rows that act before eve is ready. |
| `relay` | `dir`; `cli(...argv)` (relay verbs as the feature map writes them: `cli('eve', 'list')`) and `ctl(...argv)` (presence, faults, host status, fs events, clock), both `{ code, stdout, stderr }`; `json(...argv)`; `mark()` (now, for `since`); `logs({ event, since })`; `waitForEvent(event, { since, match })`. |
| `passkey` | `enable()` (Chromium virtual authenticator: ctap2, internal, resident key, user verification); `credentials()`; `setPresence(ok)` (false: the next ceremony gets no presence or verification). |
| `voice` | `tts` and `stt`, each with `requests` (live), `waitForRequest(match)` and `reply(...)`. |
| `profiles` | `phone` (Pixel 7) and `tablet` (Galaxy Tab S4), for `test.use(profiles.phone)`. |

`waitForEvent` resolves on the first fakerelay event line of that kind that `match` accepts (any line when there is no `match`). Lines already written count. The bound is the test's timeout. `EventLine` is `{ ts, level, msg, op, event, status, error?, trace_id, ...fields }`.

Fake TTS and STT speak the length-prefixed JSON protocol of `tts-service.js` and `stt-service.js`, on `127.0.0.1` with a free port. TTS answers every synth with a silent 30 s WAV and `list_voices` with one voice. STT answers `ping` with ok and every transcription with `hello from the test microphone`. `reply({ seconds })`, `reply({ text })` or `reply({ error })` changes the answer for later requests.

Specs never touch `context.newCDPSession`, child processes or the file system; those live in `test/e2e/support/`.

### What each test gets

Under one temp root (`<tmp>/ev-XXXXXX`): `r/` (fakerelay's config dir, with `world.json`, `ready.json`, `logs/`), `eve/` (`EVE_DATA_DIR`), `sched/` (relayScheduler's data), `home/` and `tmp/`. fakerelay starts with a scrubbed environment (`PATH`, `HOME`, `TMPDIR`, `TZ=UTC`) and launches relayScheduler and eve with the fd 3 launch secret, so eve's launch-identity path runs in every test. Eve binds `127.0.0.1` (`EVE_BIND_HOST`) on a free port. The fixture fails by name if a socket path would pass 103 bytes.

Readiness is signalled, never slept on: fakerelay's ready line, `eve-ready.json`, and relayScheduler's `service.manifest.register` event, each raced against the service's failed state and fakerelay's exit. Teardown sends SIGTERM to fakerelay (it stops eve and relayScheduler) and waits for its exit event; a run still alive after 15 s is killed and the overrun attached.

A failed test attaches `eve.log`, `fakerelay.log`, `relaysessions.log`, `relayscheduler.log` (when on) and `fakerelay.stderr`; the trace is kept (`retain-on-failure`). Worlds use neutral names only (Acme, testbox): CI uploads these as public artifacts.

A setup failure throws a named error: `fakerelay exited <code> before ready: <stderr tail>`, `eve exited <code> before eve-ready.json; see eve.log`, or `relayScheduler exited <code> before its manifest was registered; see relayscheduler.log`.
