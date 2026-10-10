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
| `npx playwright test` | CI job `e2e` (every PR and every push to `main`); the hermetic suite (this guide) | eve against fakerelay, one stack per test |
| Devbox world | `npm run -s verify:devbox`; the `devbox/verify` status check on PRs | journeys against the installed stack on the test machine; unchanged, see `devboxverify/README.md` |

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

`worlds.base()` is one project `Acme` (id `p_acme`, work mode, a `README.md`) as the work default, with relay's fixed `haiku`, `sonnet` and `opus` models and the echo reply.

Fixtures, one set per test:

| Fixture | Members |
|---|---|
| `eve` | `url`; `open(path = '/', { preReady, weakConnection })`, which returns once `<html data-ready="1">` is set; `reload({ preReady })`; `ready()`, which waits for `<html data-ready="1">`; `signOut()`; `setOffline(offline)`. `preReady` (a non-empty reason string) returns at `domcontentloaded`, for rows that act before eve is ready. |
| `relay` | `dir`; `cli(...argv)` (relay verbs as the feature map writes them: `cli('eve', 'list')`) and `ctl(...argv)` (presence, faults, host status, fs events, clock), both `{ code, stdout, stderr }`; `json(...argv)`; `mark()` (now, for `since`); `logs({ event, since })`; `waitForEvent(event, { since, match })`. |
| `passkey` | `enable()` (Chromium virtual authenticator: ctap2, internal, resident key, user verification); `credentials()`; `setPresence(ok)` (false: the next ceremony gets no presence or verification); `replace()` (a fresh, empty authenticator; returns the old one's credentials). |
| `voice` | `tts` and `stt`, each with `requests` (live), `waitForRequest(match)` and `reply(...)`. |
| `profiles` | `phone` (Pixel 7) and `tablet` (Galaxy Tab S4), for `test.use(profiles.phone)`. |

`waitForEvent` resolves on the first fakerelay event line of that kind that `match` accepts (any line when there is no `match`). Lines already written count. The bound is the test's timeout. `EventLine` is `{ ts, level, msg, op, event, status, error?, trace_id, ...fields }`.

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

`<html data-ready="1">` is set by the app once its WebSocket is up and the projects and sessions have loaded. The WebSocket only opens after sign-in, so on the Sign-in and Set Up Passkey screens (`network: 'untrusted'`) the flag is never set, and `eve.open('/')` would wait out the test. A row that starts on those screens opens with `eve.open('/', { preReady: '<reason>' })` and asserts on the screen by role. Once the row signs in, wait for the app with `await eve.ready()` before acting on anything that needs the loaded app. A row that does not start on a sign-in screen never uses `preReady`.

A row that needs a signed-out browser with a passkey enrols first, then calls `await eve.signOut()`. It throws under `network: 'trusted'`. The Sign-in screen loads with heading "Sign In", and the authenticator still holds its passkey. A row about a second browser ("Add this browser", revoking another browser's passkey) uses the same page: `eve.signOut()`, then `passkey.replace()`, which returns the first browser's credentials. To eve, that page is a new browser.

#### Voice rows

- Dictation: eve discards a recording shorter than 300 ms ("Recording too short"), and nothing reaches the fake STT. The button is named "Stop recording" at once and renames itself to `Recording... 0:01` on the one-second timer tick, so wait for `getByRole('button', { name: /^Recording\.\.\./ })` before pressing it. A button press right after "Stop recording" shows sends no audio.
- The fake STT's `requests` list shows what reached it; `waitForRequest` waits on that, not on a duration.

Fake TTS and STT speak the length-prefixed JSON protocol of `tts-service.js` and `stt-service.js`, on `127.0.0.1` with a free port. TTS answers every synth with a silent 30 s WAV and `list_voices` with one voice. STT answers `ping` with ok and every transcription with `hello from the test microphone`. `reply({ seconds })`, `reply({ text })` or `reply({ error })` changes the answer for later requests.

#### Network rows

`await eve.setOffline(true)` takes the browser off the network, as a person losing signal. `setOffline(false)` brings it back. Assert on the screen with `expect`, never a duration. `eve.open('/', { weakConnection: true })` fails the first load of one core script, so the page never becomes ready. After the person presses Reload, wait with `await eve.ready()`.

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

Allowed in specs: `getByRole`, `getByLabel`, `getByText`, `filter`, `first`/`last`/`nth`, `page.keyboard`, `page.mouse`, `page.touchscreen`, `setInputFiles`, `expect`, and the fixtures (`eve.open`, `eve.reload`, `eve.ready`, `eve.signOut`, `eve.setOffline`, `relay`, `passkey`, `voice`).

`npm run check:static` (`scripts/check-static.js`, plain Node) holds the rest. One finding per line, `<check>: <file>[:<line>]: <what>`; exit 0 clean, 1 findings, 2 usage or an unreadable input. The frozen sets are in `test/static/frozen.json` (`wsTypes`, `expensiveTypes`, `asyncHandlers`, `breakpoints`, `journeys`), so a deliberate change shows in the diff.

| Check | Holds |
|---|---|
| S1 | the E1 allowlist names only files that exist; the removed local file-plane modules stay absent |
| S2 | no `public/**/*.html` iframe `sandbox` contains `allow-same-origin`; the preview pane and editor iframes are exactly `allow-scripts`; the PDF viewer's unsandboxed iframe is the one exclusion |
| S3 | `public/` holds no `auth.json`, `sessions.json`, `settings.json`, `.env`, `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, and no `data/` or `certs/` |
| S4 | every width media query in `public/**/*.css` is in `frozen.breakpoints` |
| S5 | the client message types equal `frozen.wsTypes`, and each is named in `docs/api.md` |
| S6 | the expensive types equal `frozen.expensiveTypes`; the async handlers equal `frozen.asyncHandlers` |
| S7 | every tracked file is in an area or `quiet` in `docs/areas.jsonc`; every journey area exists; the smoke set stays plain journeys, and `chat-reply` runs before `open-existing-thread` and `listen` |
| S8 | the devbox journey set (ids, needs, areas, timeout, screen and fixture flags, run order) equals `frozen.journeys` |
| S9 | no journey function body in `devboxverify/journeys.js`, `journeys-auth.js` or `journey-kit.js` names a world fixture directly |
| S10 | `node .claude/hooks/eve-test-writer-guard.js --self-test` exits 0 |

Guards 9 (burn-in), 7, 8 and 12 are the CI burn-in step and E5, E3 and E4. A deliberate change to a frozen set edits `test/static/frozen.json` in the same PR.

## Coverage

`npm run check:coverage` (`scripts/check-coverage.js`) ties `docs/FEATURES.md` to the specs. It reads the row tables, "Retired IDs", `test/e2e/coverage-pending.txt`, the tests from `npx playwright test --list --reporter=json` (no global setup, no browser) and the journey ids in `frozen.json`. One finding per line, `<ID or file>: <what>`; exit 0, 1 or 2 as above.

A test names its row in its title: `test('greeting and summary line @G1.3', …)`. A refusal is `@G1.3.r1`. The Spec cell grammar is in `docs/FEATURES.md`, "How to read a row".

- A row ID is `G<n>.<n>`, unique, and not retired.
- A `none yet` row passes only while its goal is in `test/e2e/coverage-pending.txt` (`G<n> #<issue>`). The list only shrinks: a child removes its own goals when it lands, and a listed goal whose rows all name a proof is a finding. At the end of epic #310 the file is empty.
- A `<name>.spec.js` item is a file in `test/e2e/` with a test tagged for that row. A `devbox: <id>` item names a journey in `frozen.journeys`.
- Every test carries at least one row tag, every tag names a live row (and an `r<k>` that row has), and that row's Spec cell names the test's file.
- Once a goal is off the pending list, every refusal `r<k>` of its rows is tagged by a test in a named file, unless the cell has a `devbox:` item.

## CI and hooks

`.github/workflows/ci.yml`:

- `check`: `npm ci`, `node --check` on every tracked JS file, `npm run -s lint`, `npm run -s check:static`, `npm run -s check:coverage`.
- `e2e` (every PR and every push to `main`; Ubuntu, 30 minutes): builds the fakes from the pin, installs Chromium, runs `npx playwright test`. On a PR it then runs the burn-in: `node scripts/burn-in-specs.js "$BASE_SHA" "$HEAD_SHA"` lists the specs the PR adds or changes (top-level `test/e2e/*.spec.js` only), and `npx playwright test --repeat-each=5 --retries=0 <specs>` runs them. A change to `test/e2e/support/` or `playwright.config.js` lists none. On failure the job uploads `playwright-report/` and `test-results/` (7 days). CI skips the browser lock.
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
