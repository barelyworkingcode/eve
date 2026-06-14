# Testing Guide

Three tiers. Unit is the fast hermetic gate; integration and e2e boot the real
`node server.js` against a fake relay.

## Commands

```bash
npm test                 # Unit tests (hermetic, ~5s) — the pre-commit gate
npm run test:watch       # Unit tests in watch mode
npm run test:integration # Boots real server.js vs fake relay (spawns processes, binds ports)
npm run test:e2e         # Playwright in headless Chrome over the same harness
```

Run `npm test` before committing.

## Layout

```
test/
  setup.js               - Global afterEach: force-restores real timer globals
  unit/        (33 files) - Pure logic / mocked deps. jest.config.js
  integration/ (16 files) - Real eve child process vs fake relay. jest.integration.config.js
  e2e/         (2 specs)   - Playwright drives a spawned eve in Chromium. playwright.config.js
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
headless Chromium (`test/e2e/fixtures.js`). Covers browser/DOM behavior (`app.spec.js`,
`chat.spec.js`) that unit tests can't reach. Serial.

Integration and e2e run on loopback, which is a trusted subnet — no passkey/auth to
set up. No relay orchestrator, relayLLM, or real LLM is involved.

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

## Adding Tests

- **Unit**: `test/unit/<module>.test.js`. Use temp dirs for file I/O (see
  `file-service.test.js`). Run one file with `npx jest test/unit/my-test.test.js`.
- **Integration**: `test/integration/<feature>.test.js`. Boot eve via
  `startEve()` from `harness.js`; drive it over HTTP/WS; `await eve.stop()`.
- **E2E**: `test/e2e/<feature>.spec.js`. Use the `eve` fixture from `fixtures.js`.
