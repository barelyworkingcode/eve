# Testing Guide

## Quick Reference

```bash
npm test              # Unit tests only (~0.5s, no external deps)
npm run test:unit     # Same as above
npm run test:all      # All tests
npm run test:watch    # Unit tests in watch mode
```

## Test Structure

```
test/
  helpers/mock-session.js  - MockWebSocket + createMockSession
  unit/                    - Pure logic tests, no external deps
    file-service.test.js   - Path security, extension validation, file I/O
```

One Jest project: `unit` runs fast with zero deps. `npm test` runs unit tests.

## Shared Helpers

```js
const { MockWebSocket, createMockSession } = require('../helpers/mock-session');

const ws = new MockWebSocket();
ws.send(JSON.stringify({ type: 'error', message: 'oops' }));
ws.getMessages('error');     // [{ type: 'error', message: 'oops' }]
ws.getLastMessage('error');  // { type: 'error', message: 'oops' }

const session = createMockSession({ model: 'opus' });
// session.ws = MockWebSocket, session.saveHistory = jest.fn(), etc.
```

## What We Test

**file-service.test.js** -- Path traversal prevention (security boundary), extension allowlist, plus async file I/O (read, write, list, rename, move, create directory) against temp directories.

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
2. Use `createMockSession()` and `MockWebSocket` from helpers
3. For file I/O tests, use temp directories (see `file-service.test.js` patterns)
4. Run: `npx jest test/unit/my-test.test.js` or `npm test`
