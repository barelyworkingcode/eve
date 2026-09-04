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
client/transport, ws dispatch, route handlers, module service/invoker, security
headers, rate limiter, slash commands, project normalize, and more. Zero external
deps; this is the pre-commit gate. `collectCoverageFrom` enumerates the server-side
surface explicitly so untested files count as 0% instead of vanishing.

**Integration** (`jest.integration.config.js`) — `test/integration/harness.js` spawns
the real `node server.js` on an ephemeral port with a throwaway data dir, pointed at
`fake-relay.js`. Covers the relay contract, session forwarding, file ops, permissions,
tasks, terminals, binary proxy, module AI, and search end-to-end. Not hermetic
(processes + ports), so it stays out of the unit gate. Serial (`maxWorkers: 1`).

**E2E** (`playwright.config.js`) — same spawned-eve + fake-relay harness, driven through
headless Chromium (`test/e2e/fixtures.js`). Covers browser/DOM behavior unit tests
can't reach: basic app/chat flow, the chat input row and voice drawer's wiring, and
tab/pane behavior. `voice.spec.js` is excluded here (see `test:voice` above). Serial.

**Visual** (`test/visual/playwright.visual.config.js`) — captures screenshots to
`test/visual/__current__` and diffs against `test/visual/__baseline__`; any
non-zero diff fails. Re-baseline only after a deliberate UI change, and check the
diff images in `test/visual/__diff__` first.

Integration, e2e and visual run on loopback, which is a trusted subnet — no
passkey/auth to set up. No relay orchestrator, relayLLM, or real LLM is involved.

## Gotchas

**Timer globals** — Under Jest 30 + Node 26, `jest.useRealTimers()` can leave
`setTimeout`/`clearTimeout` undefined. `test/setup.js` snapshots the real timer
functions and force-restores them after every test, so a fake-timer test can't break
the next file. You don't need to manually restore. Keep fire-and-forget timers
`.unref()`'d (see `file-watcher.js`) so a leaked timer can't hang a worker on teardown.

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
