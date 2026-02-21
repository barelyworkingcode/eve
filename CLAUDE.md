# Eve Workspace - AI Assistant Context

Multi-provider LLM web interface with persistent sessions, project grouping, and real-time stats.

**See also**: [docs/learned.md](docs/learned.md) - Common pitfalls and patterns discovered during development.
**Test index**: [docs/testindex.md](docs/testindex.md) - Quick-reference index of all unit, integration, and E2E tests.

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
- Catch provider process crashes and log
- Send user-friendly errors via WebSocket
- Clean up resources (kill processes) on error
- Don't crash server on session failures
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
3. Edge cases - empty states, disabled providers, missing data
4. Mobile viewport - touch interactions, responsive layout
5. Browser compatibility - Chrome, Safari, Firefox

**Integration Points**
Test WebSocket reconnection:
- Stop server while client connected
- Verify auto-reconnect and state recovery

Test provider switching:
- Disable provider in settings
- Verify UI updates (grayed out projects)
- Verify cannot create sessions

Test concurrent sessions:
- Create multiple sessions
- Verify stats isolation
- Verify switching preserves state

### State Management Standards

**Single Source of Truth**
- Client: `EveWorkspaceClient` instance owns all state
- Server: `sessions` Map owns session state
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
- Process spawns per message (use persistent processes)

**Resource Cleanup**
```javascript
// Always clean up
session.provider.kill();  // Kill process
ws.close();               // Close WebSocket
this.sessions.delete(id); // Remove from Map
```

### Code Organization

**File Length Limits**
- Single file should not exceed 1000 lines
- Break into logical modules at 800+ lines
- Exception: `app.js` is 900 lines but well-organized by section

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
- Provider-specific quirks - flag non-obvious behavior
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
- [ ] Works with disabled providers

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

**Test-Driven Debugging**
Before fixing a bug:
1. Create a minimal test case that reproduces the issue
2. Verify the test fails with current code
3. Fix the bug
4. Verify the test passes with the fix
5. Test edge cases around the fix

Example workflow:
```javascript
// 1. Create test case
async function testProjectDeletion() {
  const project = { id: '123', name: 'Test' };
  const session = { id: 'abc', projectId: '123' };
  // Expect: deletion shows session count in message
}

// 2. Run test → fails (native confirm used, no count)
// 3. Implement custom modal with session count
// 4. Run test → passes
// 5. Test edge cases: 0 sessions, disabled project, etc.
```

**Systematic Approach**
1. Reproduce the issue reliably
2. Identify root cause, not symptoms
3. Fix the cause, not the symptom
4. Verify fix across all affected paths
5. Add safeguards to prevent recurrence

**Debugging Tools**
- Browser DevTools Network tab for WebSocket messages
- Console for client-side errors and state inspection
- Server logs for provider process output
- `curl` for testing HTTP endpoints directly

**Common Issues**
- "Session not found" → Check WebSocket reconnection
- "Process exited" → Check provider available in PATH
- "Stats not updating" → Check provider emits stats events
- "UI not updating" → Check render called after state change

### Automated Testing

**Commands**
```bash
npm test              # Unit tests only (fast, no external deps)
npm run test:unit     # Same as above
npm run test:integration  # Integration tests (needs CLI/servers)
npm run test:all      # Both suites
npm run test:watch    # Unit tests in watch mode
```

**Structure**
```
test/
  helpers/mock-session.js  - Shared MockWebSocket + createMockSession
  unit/                    - Pure logic tests (no external deps)
  integration/             - Tests against real CLIs/servers (auto-skip if unavailable)
```

**Adding tests**: Place unit tests in `test/unit/`, mirroring source structure. Use `createMockSession()` from helpers. Integration tests go in `test/integration/` with conditional skip via `describe.skip` when CLIs are unavailable.

**Rule**: Run `npm test` before committing to catch regressions.

## Project Architecture

### Core Components

**Server** (`server.js`)
- Express HTTP + WebSocket server
- Session management (Map of sessionId → session state)
- Project persistence to `data/projects.json`
- Provider abstraction layer

**Client** (`public/app.js`)
- Vanilla JavaScript WebSocket client
- Single `EveWorkspaceClient` class managing all state
- No framework dependencies

**Providers** (`providers/`)
- `llm-provider.js` - Base class for all providers
- `claude-provider.js` - Claude CLI integration (persistent process)
- `gemini-provider.js` - Gemini CLI integration (persistent process)
- `lmstudio-provider.js` - LM Studio HTTP API integration (stateless)

### Key Patterns

**Provider Selection**
Models are routed to providers based on naming:
- `gemini*` → GeminiProvider
- LM Studio config models → LMStudioProvider
- Everything else → ClaudeProvider

**Session Lifecycle**
1. Client creates session via WebSocket
2. Server ensures PreToolUse hook config in project's `.claude/settings.local.json`
3. Server spawns provider process (CLI) or initializes HTTP client
4. Claude CLI spawned with `EVE_HOOK_URL`, `EVE_SESSION_ID`, `EVE_AUTH_TOKEN` env vars
5. Process/client persists for entire session lifetime
6. Session ends → process killed, state cleared

**Project Grouping**
- Projects have: name, path, default model, allowedTools
- Sessions optionally belong to one project
- Disabling a provider grays out projects using that provider's models

**Permission Forwarding**
- Claude CLI PreToolUse hook (`scripts/permission-hook.js`) POSTs to `/api/permission`
- Server holds HTTP response open, forwards to browser via WebSocket (`permission_request`)
- Browser shows permission modal, user clicks Allow/Deny
- Client sends `permission_response` via WebSocket, server resolves held HTTP response
- Hook outputs decision JSON to stdout for Claude CLI
- 60s timeout auto-denies; network errors fail-open (allow)

## Client Architecture

### State Management
All state lives in `EveWorkspaceClient` instance:
```javascript
this.ws                    // WebSocket connection
this.currentSessionId      // Active session ID
this.sessions              // Map of all sessions
this.projects              // Map of all projects
this.attachedFiles         // Pending file attachments
this.confirmCallback       // Current confirmation modal callback
this.editingTask           // { projectId, taskId } when editing a task
this.editingProjectId      // projectId when editing a project
this.pendingPermissionId   // permissionId for pending permission request
```

### UI Patterns

**Modals**
- Session creation modal (`#modal`)
- Project create/edit modal (`#projectModal`) - shared for create and edit via `editingProjectId`
- Confirmation modal (`#confirmModal`)
- Tasks list modal (`#tasksModal`)
- Task create/edit modal (`#taskFormModal`)
- Permission request modal (`#permissionModal`) - approve/deny Claude CLI tool use
- All follow same pattern: backdrop click closes, focus management, hidden class toggle

**Sidebar Hierarchy**
```
Projects (section)
  ├── Project 1
  │   ├── Session A
  │   └── Session B
  └── Project 2
Ungrouped (implicit section)
  └── Session C
```

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
this.renderProjectList();
```

**Modal workflow**
1. Show modal with pre-filled data
2. User submits or cancels
3. Hide modal and reset form state
4. Update collections and re-render

**WebSocket messages**
Server sends typed messages:
- `session_created` - New session ready
- `llm_event` - LLM response streaming
- `stats_update` - Context/cost updates
- `error` - Display error to user
- `permission_request` - Claude CLI tool needs user approval

Client sends:
- `permission_response` - User's allow/deny decision for a pending permission request

### Adding Features to Server

**Provider implementation checklist**
1. Extend `LLMProvider` base class
2. Implement `startProcess()` or HTTP setup
3. Implement `sendMessage(text, files)`
4. Implement `handleEvent(event)` for responses
5. Add to `getProviderForModel()` routing logic
6. Add model list to `getAllModels()`

**Session safety**
- Always check session exists before sending
- Clean up on disconnect: `session.provider.kill()`
- Prevent message sends during processing

### File Structure Conventions

**Data persistence**
```
data/
  projects.json         - Generated, committed to .gitignore
  settings.json         - Optional, user-created
  lmstudio-config.json  - Optional, user-created
```

**Client code organization** (app.js ~900 lines)
1. Constructor & initialization (1-133)
2. File handling (145-230)
3. WebSocket connection (240-263)
4. Server message handling (335-400)
5. UI rendering (450-650)
6. Modal management (700-800)
7. Project/session rendering (776-891)

## Common Tasks

### Adding a new modal
1. Add HTML structure in `index.html`
2. Add CSS following existing `.modal*` patterns
3. Add element refs in `initElements()`
4. Add show/hide methods
5. Add event listeners in `initEventListeners()`

### Adding a button to project headers
1. Update `renderProjectList()` HTML template
2. Add CSS (hidden by default, show on `.project-header:hover`)
3. Query element after innerHTML set
4. Add click handler with `e.stopPropagation()`
5. Check for disabled projects if needed

### Updating stats display
Stats flow: Provider → Server → WebSocket → Client
1. Provider emits stats in response
2. Server forwards as `stats_update` message
3. Client `updateStats()` updates DOM
4. Color coding: <50% green, 50-80% yellow, >80% red

## Edge Cases & Gotchas

**Disabled providers**
- Projects using disabled provider models show as grayed out
- Cannot create sessions in disabled projects
- Cannot select disabled project in new session dropdown
- Sessions in disabled projects remain visible but non-interactive

**Session cleanup**
- Active sessions tracked in sidebar even if process crashes
- Process exit sends `process_exited` message
- New user message restarts crashed process automatically

**File attachments**
- Images converted to base64 data URLs
- Text files read as UTF-8
- Video/audio files rejected (too large)
- Pasted images get auto-generated names

**Project deletion**
- Shows session count in confirmation message
- Sessions become ungrouped (not deleted)
- Confirmation uses custom modal, not native `confirm()`

**Mobile behavior**
- Sidebar slides in as overlay on <768px
- Closes automatically after session selection
- Touch targets increased for buttons

**Permission forwarding**
- Hook no-ops when `EVE_HOOK_URL` not set (normal CLI usage unaffected)
- Server restart during pending permission → hook gets network error, fails open (allows)
- Multiple concurrent sessions each have own `EVE_SESSION_ID` — no conflicts
- 60s timeout auto-denies if user doesn't respond
- `.claude/settings.local.json` is gitignored by Claude Code — won't pollute repos

## Testing Workflow

Manual testing checklist for new features:
1. Desktop Chrome - full feature set
2. Mobile viewport - sidebar, touch interactions
3. Session creation - all paths (project, no project, override directory)
4. Project creation/deletion - persistence across refresh
5. WebSocket reconnection - server restart recovery
6. Multiple sessions - switching, stats isolation
7. File attachments - drag/drop, paste, click

## Performance Considerations

**Client-side**
- Session list renders on every state change (acceptable for <100 sessions)
- No virtualization needed for message list (cleared on new session)
- WebSocket reconnection auto-retries every 2s

**Server-side**
- One persistent process per CLI-based session
- Process reused across messages (warm starts)
- HTTP providers stateless (no process overhead)

## Provider-Specific Notes

**Claude CLI**
- Requires `claude` in PATH
- Uses stream-json I/O format
- Provides detailed context/cost stats
- Supports `/compact` command

**Gemini CLI**
- Requires `gemini` in PATH
- Stream-json format matching Claude
- Stats support varies

**LM Studio**
- Requires local server running
- Models configured in `lmstudio-config.json`
- No persistent process (HTTP only)
- Limited stats support (no cost tracking)
