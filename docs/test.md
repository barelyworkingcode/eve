# Testing Guide

## Quick Reference

```bash
npm test              # Unit tests only (~0.5s, no external deps)
npm run test:watch    # Unit tests in watch mode
```

## Test Structure

```
test/
  unit/                    - Pure logic tests, no external deps
    file-service.test.js   - Path security, extension validation, file I/O
    file-watcher.test.js   - Debouncing, self-write tracking, cleanup
```

One Jest project: `unit` runs fast with zero deps. `npm test` runs unit tests.

## What We Test

**file-service.test.js** -- Path traversal prevention (security boundary), extension allowlist, plus async file I/O (read, write, list, rename, move, create directory) against temp directories.

**file-watcher.test.js** -- Watch/unwatch lifecycle, self-write tracking with auto-clear, debounced change detection, event coalescing.

## What We Don't Test

**Client-side code** (`public/app.js`) -- Vanilla DOM manipulation + browser APIs. Would need JSDOM + heavy mocking. Manual browser testing catches real issues.

**WebSocket handler** (`ws-handler.js`) -- Thin dispatch layer routing messages to relay or local handlers.

**Relay client** (`relay-client.js`) -- WebSocket bridge to relayLLM. Integration testing requires a running relayLLM instance.

**Authentication** (`auth.js`) -- WebAuthn requires real browser context. Mocked tests give false confidence for security-critical paths.

**Route handlers** (`routes/index.js`) -- Thin HTTP proxy to relayLLM.

**Terminal management** (`terminal-manager.js`) -- Platform-coupled (node-pty + xterm.js). No pure logic to extract.

**File handlers** (`file-handlers.js`) -- Thin WebSocket-to-FileService adapter. FileService is well-tested; this just routes message types to methods.

## Adding Tests

1. Place in `test/unit/<module>.test.js`
2. For file I/O tests, use temp directories (see `file-service.test.js` patterns)
3. Run: `npx jest test/unit/my-test.test.js` or `npm test`
