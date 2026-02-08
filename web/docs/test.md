# Testing Guide

## Quick Reference

```bash
npm test              # Unit tests only (~0.3s, no external deps)
npm run test:unit     # Same as above
npm run test:integration  # Integration tests (needs real CLIs/servers)
npm run test:all      # Both suites
npm run test:watch    # Unit tests in watch mode (re-runs on file changes)
```

## How Jest Works

Jest is a test runner. You write test files that describe expected behavior, and Jest runs them and reports pass/fail.

A test file looks like this:

```js
describe('Calculator', () => {       // Group of related tests
  it('adds two numbers', () => {     // One specific test
    expect(add(2, 3)).toBe(5);       // Assertion: "I expect add(2,3) to equal 5"
  });

  it('handles zero', () => {
    expect(add(0, 5)).toBe(5);
  });
});
```

Key concepts:
- `describe()` groups related tests together
- `it()` defines a single test case
- `expect()` makes assertions about values
- `beforeEach()` runs setup code before every test in its `describe` block
- `jest.fn()` creates a mock function that records how it was called
- `jest.spyOn()` wraps a real method to track calls while keeping original behavior

## What We Test (and How)

### Unit Tests (`test/unit/`)

Unit tests call functions directly and check return values. No servers, no processes, no network. They run in milliseconds.

**`file-service.test.js`** -- Tests path security and file extension validation.

This is the highest-value test file because `validatePath()` is a security boundary. It prevents users from reading `/etc/passwd` by sending `../../etc/passwd` as a file path. The tests verify:
- Normal paths resolve correctly
- `../` attacks throw errors
- Leading slashes get stripped (so `/etc/passwd` doesn't escape the project directory)
- File extension allowlist works (`.js` yes, `.exe` no)

How it works: We create a `FileService` instance and call `validatePath()` and `isAllowedFile()` directly. No filesystem access needed -- these are pure logic functions.

**`providers/claude-provider.test.js`** -- Tests argument parsing, file validation, and session state.

The Claude provider has several pure utility functions that handle CLI argument parsing (`parseQuotedArgs`), argument removal (`removeCustomArg`), and file validation (`validateFiles`). These are tested by creating a provider instance with a mock session (no real Claude process spawned).

How it works: We pass a fake session object to `new ClaudeProvider(session)`. The constructor accepts this without spawning a process. Then we call the utility methods directly and check results.

**`providers/llm-provider.test.js`** -- Tests the base provider class.

Verifies that `sendEvent()` properly JSON-serializes and sends events through the WebSocket, handles closed/null WebSocket gracefully, and that abstract methods throw "Not implemented".

How it works: We use `MockWebSocket` (from `test/helpers/mock-session.js`) which captures every `.send()` call into an array. Then we check what messages were "sent".

**`session-manager.test.js`** -- Tests model routing and slash commands.

The `SessionManager` routes model names to providers (`gemini-2.0-flash` -> GeminiProvider, `haiku` -> ClaudeProvider) and handles slash commands (`/clear`, `/help`, `/zsh`). These are testable because the routing is pure logic, and the slash commands just send JSON messages through the WebSocket.

How it works: We create a `SessionManager` with mock dependencies (fake sessions Map, mock session store). For `/clear`, we spy on `initProvider` to prevent it from spawning a real Claude process. Then we check that the right WebSocket messages were sent and state was updated.

**`session-store.test.js`** -- Tests session persistence (save/load/delete).

Uses real filesystem operations against a temporary directory (`os.tmpdir()`). Each test gets a fresh temp dir that's cleaned up afterward. This tests the actual JSON serialization, file writing, and error handling for corrupt files.

How it works: `beforeEach` creates a temp directory, `afterEach` deletes it. We call `store.save()` then `store.load()` and verify the data round-trips correctly.

### Integration Tests (`test/integration/`)

Integration tests run against real CLI tools and servers. They're slow (seconds per test) and require external dependencies. They auto-skip when dependencies aren't available.

**`providers/claude-provider.test.js`** -- Sends a real message to Claude CLI and verifies a response comes back.

**`providers/gemini-provider.test.js`** -- Same for Gemini CLI.

**`providers/lmstudio-provider.test.js`** -- Same for LM Studio HTTP server.

How auto-skip works:
```js
let cliAvailable = false;
try {
  execSync('which claude', { stdio: 'ignore' });  // Is 'claude' in PATH?
  cliAvailable = true;
} catch (e) {}

const describeIfCli = cliAvailable ? describe : describe.skip;
// describe.skip registers tests but marks them as skipped -- they show up
// in output as "skipped" rather than failing
```

### Shared Test Helpers (`test/helpers/`)

**`mock-session.js`** provides two utilities used across all tests:

`MockWebSocket` -- A fake WebSocket that captures messages instead of sending them over a network:
```js
const ws = new MockWebSocket();
ws.send(JSON.stringify({ type: 'error', message: 'oops' }));
ws.getMessages('error');     // [{ type: 'error', message: 'oops' }]
ws.getLastMessage('error');  // { type: 'error', message: 'oops' }
```

`createMockSession()` -- Builds a session object matching what providers expect, with sensible defaults and a `jest.fn()` for `saveHistory`:
```js
const session = createMockSession({ model: 'opus' });
// session.ws is a MockWebSocket, session.saveHistory is a jest.fn(), etc.
```

## What We Don't Test (and Why)

### Client-side code (`public/app.js`)

The client is vanilla JavaScript loaded via `<script>` tags in the browser. It manipulates the DOM directly (`document.querySelector`, `innerHTML`, etc.) and relies on browser APIs (WebSocket, FileReader, drag-and-drop events).

To unit test this, you'd need JSDOM (a fake browser environment) plus extensive mocking of every browser API the code touches. The effort-to-value ratio is poor -- these tests would mostly be testing that JSDOM works, not that the UI works. Manual browser testing (already mandated in CLAUDE.md) catches the real issues: layout problems, event handling bugs, mobile responsiveness.

### WebSocket lifecycle (`server.js`)

The WebSocket setup code in `server.js` is tightly coupled to Express and the `ws` library. Testing it would mean starting a real HTTP server, connecting a real WebSocket client, and managing the lifecycle -- that's an end-to-end test, not a unit test. The business logic that WebSocket messages trigger (slash commands, message routing) IS tested through the `SessionManager` unit tests.

### Authentication (`auth.js`)

WebAuthn/passkey authentication involves browser crypto APIs, challenge-response protocols, and credential storage. Testing it requires a real browser context (or heavy mocking of `navigator.credentials`). The auth flow is also a security-critical path where mocked tests give false confidence -- manual testing with real passkeys is more meaningful.

### HTTP route handlers (`routes.js`)

The Express route handlers are thin wrappers that parse request parameters and call `SessionManager` methods. Since `SessionManager` is thoroughly tested, the routes themselves add little risk. Testing them would require spinning up an Express server and making HTTP requests -- possible with `supertest`, but not worth the setup for simple delegation code.

### Terminal management (xterm.js, `terminal-manager.js`)

The terminal feature spawns real shell processes (`node-pty`) and streams I/O through WebSocket to xterm.js in the browser. Both ends are tightly coupled to platform APIs (PTY on the server, DOM rendering on the client). There's no pure logic to extract and unit test. Integration testing would require a running server, a real browser, and verifying terminal output -- that's E2E territory.

### Task scheduler (`task-scheduler.js`)

The scheduler uses `setInterval`, `fs.watch`, and spawns headless LLM sessions on timers. It's integration-heavy with time-dependent behavior. Proper testing would need fake timers (`jest.useFakeTimers()`) plus mocking of the filesystem watcher and the headless execution path. Low ROI given the code is straightforward.

## How the Test Infrastructure Works

### Jest Configuration (`jest.config.js`)

Jest is configured with two "projects" -- separate test suites that can run independently:

```js
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.test.js'],
      testEnvironment: 'node'
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.test.js'],
      testEnvironment: 'node',
      setupFilesAfterEnv: ['<rootDir>/test/integration/setup.js']
    }
  ]
};
```

- `testMatch` tells Jest which files to run for each project
- `testEnvironment: 'node'` means tests run in Node.js (not a browser)
- `setupFilesAfterEnv` runs a setup script before tests (used to set a 60-second timeout for integration tests)
- `--selectProjects unit` in the npm scripts makes `npm test` run only unit tests

### Why Two Projects?

Unit tests should be fast and have zero external dependencies. You should be able to run them on any machine, any time, without Claude CLI installed or LM Studio running. Integration tests need real external tools and can be slow or flaky (rate limits, network issues).

Separating them means `npm test` is always fast and reliable (the command you run before every commit), while `npm run test:integration` is for deeper validation when you have the right environment set up.

## Adding New Tests

1. Create the file in the right place:
   - Pure logic test: `test/unit/<module>.test.js`
   - Provider-specific: `test/unit/providers/<name>.test.js`
   - Needs real external service: `test/integration/providers/<name>.test.js`

2. Use the shared helpers:
   ```js
   const { MockWebSocket, createMockSession } = require('../helpers/mock-session');
   ```

3. Run your tests:
   ```bash
   npx jest test/unit/my-new-test.test.js   # Run just one file
   npm test                                   # Run all unit tests
   ```

4. If testing code that spawns processes, mock it:
   ```js
   jest.spyOn(manager, 'initProvider').mockImplementation((s) => {
     s.provider = { kill: jest.fn(), /* ... */ };
   });
   ```

The goal is to test logic, not infrastructure. If you find yourself mocking 10 things to test one function, the function probably isn't a good unit test candidate.
