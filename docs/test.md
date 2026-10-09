# Testing Guide

Eve has no hermetic test suite right now. The Jest unit, integration and visual suites, the Playwright specs and the JS fake relay were removed. Epic #310 rebuilds the suite: each Playwright spec starts its own `fakerelay` (relay's repo) and eve, and drives eve only through what a person sees; each row in `docs/FEATURES.md` will name the spec that proves it. This guide is rewritten when that harness lands.

## What runs today

| Check | Where it runs | What it shows |
|---|---|---|
| `node --check` | CI job `check`; pre-commit on staged JS; pre-push on pushed JS | every JS file parses (eve has no build step) |
| `npm ci` | CI job `check` | the lockfile installs |
| PR guards | CI workflow `guards` (`scripts/ci-guards.sh`) | tests-only, skip-focus and hygiene |
| Devbox world | `npm run -s verify:devbox`; the `devbox/verify` status check on PRs | journeys against the installed stack on the test machine; unchanged, see `devboxverify/README.md` |

## Local hooks

The machine's global hooks dispatcher runs `.githooks/`. Never set a repo-local `core.hooksPath`: it skips the push guard.

- **pre-commit**: when a commit stages `.js`, `.cjs` or `.mjs` files, runs `node --check` on each.
- **pre-push**: when a push's range touches `.js`, `.cjs` or `.mjs` files, runs `node --check` on each one still in the tree.

## Browser-test lock

`verify:devbox` holds one machine-wide advisory lock for the whole run (`scripts/browser-lock.js`), so two browser runs never overlap. The lock file is `~/.cache/eve/browser-tests.lock` (`EVE_BROWSER_LOCK` overrides the path). A second run prints the holder's pid and command and waits up to `EVE_BROWSER_LOCK_TIMEOUT` seconds (default 1800), then gives up: `verify:devbox` exits 2 with a `PREFLIGHT lock FAIL` row. The lock is a kernel `flock` held by a small `perl` child, so `perl` must be on PATH, and the kernel drops it when the holder dies, even by SIGKILL. The lock is not reentrant, so a locked run that starts another locked run waits on itself until it times out. To clear a stuck lock, kill the holder named in the message; don't delete the file.
