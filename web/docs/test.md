# Testing Guide

## Quick Reference

```bash
npm test              # Unit tests only (~0.5s, no external deps)
npm run test:unit     # Same as above
npm run test:integration  # Integration tests (needs real CLIs/servers)
npm run test:all      # Both suites
npm run test:watch    # Unit tests in watch mode
```

## Test Structure

```
test/
  helpers/mock-session.js  - MockWebSocket + createMockSession
  unit/                    - Pure logic tests, no external deps
    file-service.test.js   - Path security, extension validation, file I/O
    session-manager.test.js - Routing, slash commands, session lifecycle
    session-store.test.js  - Persistence round-trips
    providers/
      claude-provider.test.js  - Arg parsing, file validation, handleEvent, commands
      gemini-provider.test.js  - Event normalization, handleEvent, commands
      llm-provider.test.js     - Base class, sendEvent, abstract methods
  integration/             - Tests against real CLIs (auto-skip if unavailable)
    providers/
      claude-provider.test.js
      gemini-provider.test.js
      lmstudio-provider.test.js
```

Two Jest projects: `unit` runs fast with zero deps, `integration` needs real CLIs/servers and has a 60s timeout. `npm test` runs only unit tests.

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

**providers/claude-provider.test.js** -- `parseQuotedArgs`, `removeCustomArg`, `validateFiles`, `handleEvent` (session init capture, text delta accumulation, tool use blocks, stats tracking, result completion, local-command-stdout handling), `handleCommand` (model switching, transfer), session state round-trips.

**providers/gemini-provider.test.js** -- `normalizeEvent` (Gemini-to-Claude format transform), `handleEvent` (message tracking, stats, completion), `handleCommand` (model switching).

**providers/llm-provider.test.js** -- `sendEvent` WebSocket integration, null/closed socket handling, abstract method enforcement, session state defaults.

**session-manager.test.js** -- Model-to-provider routing, `getAllModels` filtering, slash commands (/clear, /help, /zsh, /bash, /claude, provider delegation, transfer), `createSession` (with/without project), `joinSession` (in-memory and restored from store), `sendMessage` (user message saving, provider delegation, slash command interception, transferred session blocking), `endSession`/`deleteSession` cleanup, `restoreSavedSessions`.

**session-store.test.js** -- Save/load round-trips, message/stats/providerState persistence, corrupt file handling, delete, loadAll.

## What We Don't Test

**Client-side code** (`public/app.js`) -- Vanilla DOM manipulation + browser APIs. Would need JSDOM + heavy mocking. Manual browser testing catches real issues.

**WebSocket lifecycle** (`server.js`) -- Tightly coupled to Express/ws. Business logic it triggers is tested through SessionManager.

**Authentication** (`auth.js`) -- WebAuthn requires real browser context. Mocked tests give false confidence for security-critical paths.

**Route handlers** (`routes.js`) -- Thin wrappers around SessionManager, which is thoroughly tested.

**Terminal management** (`terminal-manager.js`) -- Platform-coupled (node-pty + xterm.js). No pure logic to extract.

**Task scheduler** (`task-scheduler.js`) -- 484 lines with cron parsing, task CRUD, execution history, and EventEmitter wiring. The CRUD and schedule validation logic are testable (mock timers), but not yet covered.

**LM Studio provider** (`providers/lmstudio-provider.js`) -- Has integration tests but no unit tests. Unlike Claude/Gemini providers, its HTTP streaming and event handling logic has zero automated coverage when the LM Studio server isn't running.

**File handlers** (`file-handlers.js`) -- Thin WebSocket-to-FileService adapter. FileService is well-tested; this just routes message types to methods.

## Adding Tests

1. Place in `test/unit/<module>.test.js` or `test/unit/providers/<name>.test.js`
2. Use `createMockSession()` and `MockWebSocket` from helpers
3. Mock process-spawning code:
   ```js
   jest.spyOn(manager, 'initProvider').mockImplementation((s) => {
     s.provider = { kill: jest.fn(), getMetadata: jest.fn(() => 'test') };
   });
   ```
4. For file I/O tests, use temp directories (see `session-store.test.js` or `file-service.test.js` patterns)
5. Run: `npx jest test/unit/my-test.test.js` or `npm test`

If you're mocking 10 things to test one function, it's probably not a good unit test candidate.
