# Eve Workspace - AI Assistant Context

Browser-based LLM frontend that proxies all LLM concerns to [relayLLM](https://github.com/barelyworkingcode/relayLLM). Eve handles UI, file editing, terminals, and authentication locally.

**See also**: [docs/learned.md](docs/learned.md) - Common pitfalls and patterns discovered during development.
**Test index**: [docs/testindex.md](docs/testindex.md) - Quick-reference index of all tests.

## Enterprise Development Standards

This project follows enterprise software engineering practices. All code changes must meet production-grade standards.

### Code Quality Requirements

**No Overengineering**
- Solve the specific problem, nothing more
- Don't create abstractions for single use cases
- Don't add "future-proofing" features that aren't needed now
- Three similar lines are better than premature abstraction
- Delete unused code completely—no comments, no `_unused` variables

**Critical Review**
- Challenge requirements if they don't make sense
- Identify issues before they become problems
- Propose better approaches when you see them
- Question patterns that add complexity without value
- Push back on unnecessary features

**Concrete Implementation**
- Show working code, not theoretical explanations
- Provide specific examples with actual values
- Debug systematically from root cause, not symptoms
- Use real error messages, not hypothetical scenarios

### Security Standards

**Input Validation**
- Validate at system boundaries (user input, external APIs)
- Trust internal code and framework guarantees
- Don't validate data that can't be invalid
- Sanitize user content for XSS (use `escapeHtml()` pattern)
- Never execute user input as code

**Authentication & Authorization**
- No client-side security decisions
- Validate permissions server-side
- Never trust client-provided IDs without verification

**Data Protection**
- Never log sensitive data (tokens, credentials)
- Use environment variables for secrets, not config files
- Sanitize error messages sent to client

### Error Handling

**Client-Side**
- Catch WebSocket errors and attempt reconnection
- Display user-friendly error messages
- Log detailed errors to console for debugging
- Never leave UI in broken state after error
- Always provide recovery path (reload, retry, etc.)

**Server-Side**
- Send user-friendly errors via WebSocket
- Clean up resources on error
- Don't crash server on relay failures
- Log stack traces for debugging

**Pattern**
```javascript
try {
  await riskyOperation();
  this.updateUI();
} catch (err) {
  console.error('Operation failed:', err);
  this.showError('Something went wrong. Please try again.');
  this.resetState();
}
```

### Testing Philosophy

**Manual Testing Required**
Every feature must be manually tested across:
1. Happy path - feature works as intended
2. Error cases - handles failures gracefully
3. Edge cases - empty states, relay disconnected
4. Mobile viewport - touch interactions, responsive layout
5. Browser compatibility - Chrome, Safari, Firefox

**Integration Points**
Test WebSocket reconnection:
- Stop server while client connected
- Verify auto-reconnect and state recovery

Test relay disconnection:
- Stop relayLLM while Eve is running
- Verify error messages and recovery when relay returns

### State Management Standards

**Single Source of Truth**
- Client: `EveWorkspaceClient` instance owns UI state
- Server: relayLLM owns session/project state, Eve caches projects in memory
- Never duplicate state across components
- Always derive UI from authoritative state

**State Update Pattern**
```javascript
// Always: Update state → Re-render UI
this.sessions.set(id, session);
this.renderProjectList();  // Required

// Never: Update UI without updating state
document.querySelector('.session').classList.add('active');  // Wrong
```

**Immutability Where It Matters**
- Don't mutate WebSocket message objects
- Clone before modifying shared objects
- Use `.set()` / `.delete()` for Maps (don't mutate entries)

### Performance Standards

**Acceptable Trade-offs**
- Full re-render of project list on changes (< 100 projects)
- No virtualization for message list (cleared per session)
- Synchronous file reads for attachments (< 10MB typical)

**Unacceptable Patterns**
- N+1 queries in rendering loops
- Memory leaks (unreleased WebSocket listeners)
- Blocking main thread > 100ms

**Resource Cleanup**
```javascript
// Always clean up
relayClient.close();      // Close relay connection
ws.close();               // Close browser WebSocket
terminalManager.killAll(); // Kill terminal processes
```

### Code Organization

**File Length Limits**
- Single file should not exceed 1000 lines
- Break into logical modules at 800+ lines

**Function Length**
- Keep functions under 50 lines
- Extract complex logic into helper methods
- One level of abstraction per function

**Naming Conventions**
- `camelCase` for variables and methods
- `PascalCase` for classes
- `UPPER_CASE` for constants
- Descriptive names over comments: `isDisabled` not `disabled`

### Documentation Standards

**When to Document**
- Complex algorithms - explain the "why"
- Relay protocol quirks - flag non-obvious behavior
- Security considerations - mark validation points
- Public APIs - if creating reusable modules

**When NOT to Document**
- Self-explanatory code
- Obvious patterns (getters/setters)
- Temporary debugging code
- Code that comments would just repeat

### Git Practices

**Commit Standards**
- One logical change per commit
- Present tense: "Add feature" not "Added feature"
- Reference what changed, not how: "Add quick session button" not "Update renderProjectList"
- No "WIP", "fix", "updates" commits in main branch

**CRITICAL: Never Auto-Commit**
- Only create commits when explicitly requested by user
- Do not commit after completing features unless asked
- Do not commit "to save progress" proactively
- Always wait for explicit instruction: "commit this" or "create a commit"
- When in doubt, ask before committing

**Code Review Checklist**
- [ ] No unused variables, imports, or functions
- [ ] Error handling on all async operations
- [ ] UI state updated after data changes
- [ ] Mobile responsive (test at 375px width)
- [ ] No console errors in browser
- [ ] WebSocket reconnection tested

### Dependency Management

**Adding Dependencies**
- Justify why existing code can't solve it
- Check bundle size impact
- Verify maintenance status (last update < 6 months)
- Prefer standard library over npm when possible
- No dependencies for trivial operations

**Current Philosophy**
This project intentionally has minimal dependencies:
- No frontend framework (vanilla JS)
- No build tooling (direct browser execution)
- No UI library (custom CSS)
Keep it that way unless absolutely necessary.

### Debugging Standards

**Systematic Approach**
1. Reproduce the issue reliably
2. Identify root cause, not symptoms
3. Fix the cause, not the symptom
4. Verify fix across all affected paths
5. Add safeguards to prevent recurrence

**Debugging Tools**
- Browser DevTools Network tab for WebSocket messages
- Console for client-side errors and state inspection
- Server logs for relay connection issues
- `curl` for testing HTTP endpoints directly

**Common Issues**
- "Relay service unavailable" → Check relayLLM is running on configured URL
- "UI not updating" → Check render called after state change
- "Session not found" → Check relay WS connection is alive

### Automated Testing

**Commands**
```bash
npm test              # Unit tests only (fast, no external deps)
npm run test:unit     # Same as above
npm run test:all      # All tests
npm run test:watch    # Unit tests in watch mode
```

**Structure**
```
test/
  helpers/mock-session.js  - Shared MockWebSocket + createMockSession
  unit/                    - Pure logic tests (no external deps)
```

**Rule**: Run `npm test` before committing to catch regressions.

## Project Architecture

Eve is a relay proxy -- it does not manage LLM providers, sessions, or projects directly. All LLM concerns are delegated to relayLLM via HTTP and WebSocket proxying. Eve handles local concerns: file browsing/editing, terminals, and authentication.

### Communication Flow

```
Browser ──WS──► Eve (ws-handler) ──WS──► relayLLM    (sessions, messages, permissions)
Browser ──WS──► Eve (ws-handler) ──local──► FileService  (file ops)
Browser ──WS──► Eve (ws-handler) ──local──► TerminalMgr  (terminals)
Browser ──HTTP──► Eve (routes) ──HTTP──► relayLLM     (models, projects, sessions list)
```

### Core Components

**Server**
- `server.js` - Express + WS setup, relayLLM config, project cache, shutdown
- `ws-handler.js` - WebSocket message dispatch: relay ops → RelayClient, local ops → file/terminal handlers
- `relay-client.js` - WS bridge to relayLLM (one instance per browser connection)
- `slash-command-handler.js` - Local slash commands (/clear, /help, /zsh, /bash, /claude)
- `routes/index.js` - HTTP proxy to relayLLM (models, projects, sessions) + local auth
- `routes/auth.js` - WebAuthn enrollment/login
- `file-handlers.js` - WebSocket adapter for file operations
- `file-service.js` - Path validation + file CRUD
- `terminal-manager.js` - PTY management (node-pty)
- `auth.js` - WebAuthn service (delegates session tokens to SessionStore)
- `session-store.js` - Auth session token create/validate/cleanup

**Client** (`public/`)
- `app.js` - Thin orchestrator wiring modules, state owner
- `ws-client.js` - WebSocket connection, auth, reconnection
- `message-dispatcher.js` - Server message routing and LLM event processing
- `message-renderer.js` - Chat messages, tool use, thinking indicator, formatting
- `file-attachment-manager.js` - File selection, reading, drag/drop, paste for chat input
- `modal-manager.js` - All modal show/hide, confirmation flow, permission prompts
- `sidebar-renderer.js` - Project list, session items, inline rename
- `tab-manager.js` - Tab bar for sessions, files, terminals
- `file-browser.js` - Directory tree in sidebar
- `file-editor.js` - Monaco editor integration
- `terminal-manager.js` - xterm.js terminal tabs

### Key Patterns

**Relay Proxy**
Eve creates one `RelayClient` per browser WebSocket connection. The relay client:
1. Connects to relayLLM's WebSocket endpoint
2. Forwards session/message/permission operations from browser → relayLLM
3. Forwards events (LLM responses, stats, permissions) from relayLLM → browser
4. Caches session directory for local slash commands

**Session Lifecycle** (via relay)
1. Client sends `create_session` to Eve
2. Eve POSTs to relayLLM `/api/sessions`, gets session back
3. Eve sends `session_created` to browser, joins session on relay WS
4. Messages flow: browser → Eve → relayLLM → LLM provider
5. Session end/delete forwarded to relayLLM

**Local Slash Commands** (handled by Eve, not relayed)
- `/clear` - Sends clear to relay
- `/help` - Shows available commands
- `/zsh`, `/bash` - Opens local terminal
- `/claude` - Opens local Claude CLI terminal

All other input is forwarded to relayLLM.

**Project Cache**
Eve caches project data from relayLLM in memory (`projectCache` Map) for file handler path resolution. Cache is refreshed on project list fetch and after mutations.

## Client Architecture

### Module Responsibilities

| Module | Owns | Key methods |
|--------|------|-------------|
| `app.js` | `sessions`, `projects`, `currentSessionId` | `handleSubmit()`, data loading |
| `messageDispatcher` (MessageDispatcher) | - | `dispatch()` - routes server messages to handlers |
| `fileAttachmentManager` (FileAttachmentManager) | `files` array | `addFiles()`, `consumeFiles()`, `render()` |
| `wsClient` (WsClient) | `ws` connection | `connect()`, `send()` |
| `messageRenderer` (MessageRenderer) | `currentAssistantMessage` | `startAssistantMessage()`, `appendToolUse()`, `formatText()` |
| `modalManager` (ModalManager) | `confirmCallback`, `editingProjectId`, `pendingPermissionId` | show/hide for modals |
| `sidebarRenderer` (SidebarRenderer) | `renamingSessionId` | `renderProjectList()`, `renderSessionItem()` |

Existing modules (TabManager, FileBrowser, FileEditor, TerminalManager) access the WebSocket via `this.client.ws`, which is a getter proxy to `wsClient.ws`.

### UI Patterns

**Modals** (managed by `ModalManager`)
- Session creation, project create/edit, confirmation, permission request
- All follow same pattern: backdrop click closes, focus management, hidden class toggle

**Sidebar Hierarchy** (rendered by `SidebarRenderer`)
```
Projects (section)
  ├── Project 1
  │   ├── Session A [MODEL]
  │   └── Session B [MODEL]
  └── Project 2
Ungrouped (implicit section)
  └── Session C [MODEL]
```
Each session item displays its own model badge.

**Hover Actions**
Buttons appear on hover in project headers:
- Edit button (pencil) - opens project modal in edit mode
- Quick add button (`+`) - creates session in project
- Delete button (`×`) - removes project

## Development Guidelines

### Adding Features to Client

**State changes must update UI**
```javascript
// Bad
this.sessions.set(id, session);

// Good
this.sessions.set(id, session);
this.sidebarRenderer.renderProjectList();
```

**Modal workflow** (methods live in `ModalManager`)
1. Show modal with pre-filled data
2. User submits or cancels
3. Hide modal and reset form state
4. Update collections and re-render

**WebSocket messages**
Server sends typed messages:
- `session_created` - New session ready (includes `model`)
- `session_joined` - Rejoined existing session (includes `model`)
- `llm_event` - LLM response streaming (relayed from relayLLM)
- `stats_update` - Context/cost updates (relayed from relayLLM)
- `error` - Display error to user
- `permission_request` - Tool needs user approval (relayed from relayLLM)

Client sends:
- `create_session` - Includes optional `model` override
- `permission_response` - User's allow/deny decision for a pending permission request

### Adding Features to Server

**What lives in Eve vs relayLLM**
- Eve: file browser, terminals, auth, UI serving, local slash commands
- relayLLM: providers, sessions, projects, tasks, permissions, model routing

**Adding a new local feature**
1. Add WebSocket message handler in `ws-handler.js`
2. Create service module if needed
3. Wire into `createWsHandler()` dependencies

**Adding relay proxy routes**
1. Add route in `routes/index.js` using the `proxy()` helper
2. Add `requireAuth` middleware
3. Refresh `projectCache` if the route mutates project data

### File Structure Conventions

**Data persistence**
```
data/
  auth.json     - WebAuthn enrollment data
  settings.json - Local Eve settings (claude path)

```

All session, project, and task data lives in relayLLM.

**Client code organization** (modular)
- `app.js` - Orchestrator: init, elements, event listeners, data loading, UI helpers
- `ws-client.js` - WebSocket lifecycle
- `message-dispatcher.js` - Server message routing, LLM event handling
- `message-renderer.js` - Chat rendering and formatting
- `file-attachment-manager.js` - File attach/paste/drag-drop for chat input
- `modal-manager.js` - Modal show/hide, confirm flow
- `sidebar-renderer.js` - Project/session sidebar
- `tab-manager.js`, `file-browser.js`, `file-editor.js`, `terminal-manager.js` - Feature-specific modules

**Server code organization** (modular)
- `server.js` (~200 lines) - Startup, service wiring, shutdown
- `ws-handler.js` (~200 lines) - WebSocket message dispatch
- `relay-client.js` (~140 lines) - WS bridge to relayLLM
- `slash-command-handler.js` (~65 lines) - Local slash command handling
- `session-store.js` (~70 lines) - Auth session token persistence
- `routes/index.js` (~77 lines) - HTTP proxy routes
- `routes/auth.js` (~107 lines) - WebAuthn routes

## Common Tasks

### Adding a new modal
1. Add HTML structure in `index.html`
2. Add CSS following existing `.modal*` patterns
3. Add element refs in `app.js` `initElements()`
4. Add show/hide methods in `modal-manager.js`
5. Add event listeners in `ModalManager.initEventListeners()`

### Adding a button to project headers
1. Update `SidebarRenderer.renderProjectGroup()` HTML template in `sidebar-renderer.js`
2. Add CSS (hidden by default, show on `.project-header:hover`)
3. Query element after innerHTML set
4. Add click handler with `e.stopPropagation()`

### Adding a new HTTP proxy route
1. Add route in `routes/index.js` using `proxy(req, res, method, relayPath, body)`
2. Add `requireAuth` middleware
3. Refresh `projectCache` after mutations if route affects projects

### Updating stats display
Stats flow: relayLLM → Eve WebSocket → Client
1. relayLLM sends `stats_update` via WebSocket
2. Eve's RelayClient forwards to browser
3. Client `updateStats()` updates DOM
4. Color coding: <50% green, 50-80% yellow, >80% red

## Edge Cases & Gotchas

**Relay disconnection**
- If relayLLM goes down, Eve sends error to browser
- RelayClient does not auto-reconnect (browser reconnection triggers new relay connection)
- File and terminal operations continue working (local)

**Session cleanup**
- Active sessions tracked in sidebar even if relay disconnects
- Session state lives in relayLLM, not Eve

**File attachments**
- Images converted to base64 data URLs
- Text files read as UTF-8
- Video/audio files rejected (too large)
- Pasted images get auto-generated names

**Project deletion**
- Shows session count in confirmation message
- Sessions become ungrouped (not deleted)
- Confirmation uses custom modal, not native `confirm()`
- Project cache refreshed after delete

**Mobile behavior**
- Sidebar slides in as overlay on <768px
- Closes automatically after session selection
- Touch targets increased for buttons

**Permission forwarding**
- Permission requests come from relayLLM via WebSocket
- Eve forwards to browser, browser responds, Eve relays back
- `alwaysAllow` flag auto-approves subsequent permissions in same connection

## Testing Workflow

Manual testing checklist for new features:
1. Desktop Chrome - full feature set
2. Mobile viewport - sidebar, touch interactions
3. Session creation - via relay
4. Project creation/deletion - via relay proxy
5. WebSocket reconnection - server restart recovery
6. Relay disconnection - error handling, recovery
7. File attachments - drag/drop, paste, click

## Performance Considerations

**Client-side**
- Session list renders on every state change (acceptable for <100 sessions)
- No virtualization needed for message list (cleared on new session)
- WebSocket reconnection auto-retries every 2s

**Server-side**
- One RelayClient WebSocket per browser connection
- HTTP proxy requests are pass-through (no processing)
- File and terminal operations are local (no relay overhead)

## Ecosystem

Eve is part of the Relay ecosystem. It depends on relayLLM for all LLM operations and registers with Relay as a managed service.

- `../relay/` -- MCP orchestrator. Manages Eve as a background service.
- `../relayLLM/` -- LLM engine. Eve proxies all session/project/permission operations to relayLLM.
