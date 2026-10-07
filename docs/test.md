# Testing Guide

Unit is the fast hermetic gate; integration, e2e and visual boot the real
`node server.js` against a fake relay. Voice needs the live speech daemons and
runs separately from all of them.

## Commands

```bash
npm test                    # Unit tests (hermetic, ~5s) — the pre-commit gate
npm run test:watch          # Unit tests in watch mode
npm run test:integration    # Boots real server.js vs fake relay (spawns processes, binds ports)
npm run test:e2e            # Playwright in headless Chrome over the same harness
npm run test:visual         # Screenshot diff against test/visual/__baseline__ (must be 0.0000%)
npm run test:visual:baseline # Re-captures the baseline — only after an intentional UI change
npm run test:voice          # Playwright against the real Kokoro/Whisper daemons (~3s/test, excluded elsewhere)
```

Run `npm test` before committing. The pre-push hook (below) additionally runs
integration, e2e and visual — `test:voice` is excluded there since it fails
whenever the daemons happen to be down.

## Running on Linux (Claude cloud, CI)

`npm test`, `npm run test:integration` and `npm run test:e2e` are green on Linux; CI runs them on
Ubuntu. Differences to know:

- **Chromium.** Playwright pins a browser revision per `@playwright/test` version. A host that ships
  its own Chromium sets `EVE_CHROMIUM_PATH=/path/to/chrome`, or exposes an unversioned `chromium`
  file under `PLAYWRIGHT_BROWSERS_PATH` (the Claude cloud image does), and all three Playwright
  configs use it (`test/helpers/chromium-path.js`). Nothing to set where `npx playwright install`
  works. Do not run `playwright install` in the cloud image.
- **`test:visual` is macOS-only.** The baselines are rendered on macOS; on Linux every screenshot
  differs by font rasterisation (0.3–8 %). Do not re-baseline from Linux.
- **File watching.** Linux uses the pruned `dir-watcher.js` backend, macOS the native recursive
  watch. The watcher tests run both backends on whatever platform runs them
  (`EVE_WATCH_BACKEND=native|pruned`). The removed-directory case runs on Linux only: macOS FSEvents can drop events
  when a handle closes, and the pruned backend ships on Linux only.
- **Root.** Sessions run as root, which ignores file modes. A test that needs an unreadable file
  must fail the open itself (see the `readMarker` unreadable-file row) rather than `chmod 000`.
- **The relay is a fake, pinned to relay's source.** The real relay is macOS-only;
  `test/integration/fake-relay.js` stands in. Every status, body and frame shape it copies names the
  relay file it was read from (header of `fake-relay.js`), and `relay-source-pins.test.js` re-reads
  those files when `../relay` (or `EVE_RELAY_SOURCE`) is checked out, failing if relay moved. Without
  a checkout that half reports a todo. When you change the fake, change its pin; when relay changes
  a pinned text, update the fake, the pin and whichever eve test asserted the old behaviour.
  `relay-fidelity.test.js` holds the fake to those shapes and eve to relay's refusals: bearer 401
  (`startEve({ relayToken })`), `allowed_models` / remote-project refusal, 502/503 on create, a
  `1011 "upstream unreachable"` close, join-gated `permission_response` and `emitToSession`.

**Goals to specs:** [baseline.md](baseline.md) maps each goal in `docs/FEATURES.md` to the specs that prove it in the cloud, what they cannot prove, and the behaviours recorded but not fixed.

## Layout

```
test/
  setup.js       - Global afterEach: force-restores real timer globals
  unit/          - Pure logic / mocked deps. jest.config.js
  integration/   - Real eve child process vs fake relay. jest.integration.config.js
  e2e/           - Playwright drives a spawned eve in Chromium. playwright.config.js
                   (voice.spec.js is excluded from this config's testIgnore —
                   it needs live daemons, run it via `npm run test:voice`)
  visual/        - Screenshot baseline diff. playwright.visual.config.js
```

**Unit** (`jest.config.js`) — pure logic and lightly-mocked modules: path security
(`file-service`), watch/debounce (`file-watcher`), auth ceremony/origin, relay
client/transport, ws dispatch, route handlers, security
headers, rate limiter, slash commands, project normalize, and more. Zero external
deps; this is the pre-commit gate. `collectCoverageFrom` enumerates the server-side
surface explicitly so untested files count as 0% instead of vanishing.

**Integration** (`jest.integration.config.js`) — `test/integration/harness.js` spawns
the real `node server.js` on an ephemeral port with a throwaway data dir, pointed at
`fake-relay.js`. Covers the relay contract, session forwarding, file ops, permissions,
tasks, terminals, binary proxy, and search end-to-end. Not hermetic
(processes + ports), so it stays out of the unit gate. Serial (`maxWorkers: 1`).

**E2E** (`playwright.config.js`) — same spawned-eve + fake-relay harness, driven through
headless Chromium (`test/e2e/fixtures.js`). Covers browser/DOM behavior unit tests
can't reach: basic app/chat flow, the chat input row and voice drawer's wiring, and
tab/pane behavior. `voice.spec.js` is excluded here (see `test:voice` above). Serial.

**Visual** (`test/visual/playwright.visual.config.js`) — captures screenshots to
`test/visual/__current__` and diffs against `test/visual/__baseline__`; any
non-zero diff fails. Re-baseline only after a deliberate UI change, and check the
diff images in `test/visual/__diff__` first.
Viewports: `desktop` 1280×800, `mobile` 390×844 and `ipad` 834×1194; the last two set `hasTouch` (never `isMobile`), and `mobile` opens the sheet from the bottom bar's Projects.

Integration, e2e and visual run on loopback, which is a trusted subnet — no
passkey/auth to set up. No relay orchestrator, relayLLM, or real LLM is involved.

## Gotchas

**Browser-test lock** — `test:e2e`, `test:visual` and `verify:devbox` each hold
one machine-wide advisory lock for the whole run (`scripts/browser-lock.js`), so
two browser runs never overlap. The lock file is `~/.cache/eve/browser-tests.lock`
(`EVE_BROWSER_LOCK` overrides the path). A second run prints the holder's pid and
command and waits up to `EVE_BROWSER_LOCK_TIMEOUT` seconds (default 1800), then
gives up: the npm scripts exit 75, `verify:devbox` exits 2 with a
`PREFLIGHT lock FAIL` row. The lock is a kernel `flock` held by a small `perl` child, so `perl` must
be on PATH, and the kernel drops it when the holder dies, even by SIGKILL. Pass
Playwright args with `npm run test:e2e -- <args>`: a bare `npx playwright test`
skips the lock. The lock is not reentrant, so a locked run that starts another
locked run waits on itself until it times out. To clear a stuck lock, kill the
holder named in the message; don't delete the file.

**Pull-request e2e gates** — the PR check does not run the whole browser suite, but
two jobs guard e2e specs. `lint-waits` runs `node scripts/lint-added-waits.js <base> <head>`:
ESLint (`eslint.config.js`, scoped to `.js`/`.mjs`/`.cjs` under `test/e2e`, inline disable comments ignored) flags
`waitForTimeout`, and only findings on lines the PR adds fail it, so waits already on `main`
pass. A moved or reindented line counts as added. A changed TypeScript or JSX e2e file, or a changed file missing from the checkout, exits 2 instead of passing unseen. `burn-in` runs
`node scripts/burn-in-specs.js <base> <head>` to list the files the PR adds or
changes that Playwright's default testMatch runs (`*.spec|test.[cm][jt]s[x]`; not helpers, not `voice.spec.js`), then runs them with
`npm run test:e2e -- --repeat-each=5 --retries=0 <specs>`; with none it prints
`burn-in: no e2e spec added or changed; skipped`. Both take the diff against the merge base.
Run either by hand with `origin/main HEAD`.

**Timer globals** — Under Jest 30 + Node 26, `jest.useRealTimers()` can leave
`setTimeout`/`clearTimeout` undefined. `test/setup.js` snapshots the real timer
functions and force-restores them after every test, so a fake-timer test can't break
the next file. You don't need to manually restore. Keep fire-and-forget timers
`.unref()`'d (see `file-watcher.js`) so a leaked timer can't hang a worker on teardown.

**Host audio** — A real `AudioContext` blocks the page while it opens the
host's output device, for ~20s when the host audio stack is unresponsive. The
e2e and visual tiers therefore inject `test/e2e/hermetic-audio.js`, which swaps
in a device-free `OfflineAudioContext`. A spec with its own `eve` fixture must
extend `hermeticTest` from `test/e2e/fixtures.js`, not `base.test`, or it loses
the swap. The shim has no mic path and never finishes playback, so anything that needs real audio belongs in `test:voice`, whose speech-to-transcript test launches its own browser.

**Pre-commit hook** (`.githooks/pre-commit`) — install once per clone:

```bash
git config core.hooksPath .githooks
```

When a commit stages `.js` / `jest.config.js` / `package.json`, it runs `node --check`
on the staged JS (the build gate — eve has no bundler) then the full unit suite. Skip
in emergencies with `git commit --no-verify`.

**Pre-push hook** (`.githooks/pre-push`) — when a push's range touches `.js` /
`.css` / `.html` / test config, additionally runs integration, e2e and visual
(`test:voice` excluded — see Commands above). This is the tier that actually
catches a regression in this codebase: the frozen behavioural gates (chat
input row, voice drawer, pane characterisation, two-connection WS isolation)
and the pixel baselines only run here, not in the pre-commit unit tier. Skip
with `git push --no-verify`.

## Adding Tests

- **Unit**: `test/unit/<module>.test.js`. Use temp dirs for file I/O (see
  `file-service.test.js`). Run one file with `npx jest test/unit/my-test.test.js`.
- **Integration**: `test/integration/<feature>.test.js`. Boot eve via
  `startEve()` from `harness.js`; drive it over HTTP/WS; `await eve.stop()`.
- **E2E**: `test/e2e/<feature>.spec.js`. Use the `eve` fixture from `fixtures.js`.
  Navigate with `gotoEve(page, url)` and reload with `reloadEve(page)`; both
  return once `<html data-ready="1">` is set (first socket ready, projects and
  sessions loaded or failed, tab restore requested, initial hash handled).
  Models, joins, file reads and tasks are not included: wait on their own
  signal. A hash-only `goto` is same-document and returns at once; for
  a cold load go through `about:blank` first. A spec that acts before ready keeps
  a bare call with `// pre-ready: <why>` on the same line, enforced by
  `test/unit/e2e-ready-wait-guard.test.js`.
