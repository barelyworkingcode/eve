# Eve Workspace - AI Assistant Context

Multi-provider LLM web interface with persistent sessions, project grouping, and real-time stats.

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
2. Server spawns provider process (CLI) or initializes HTTP client
3. Process/client persists for entire session lifetime
4. Session ends → process killed, state cleared

**Project Grouping**
- Projects have: name, path, default model
- Sessions optionally belong to one project
- Disabling a provider grays out projects using that provider's models

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
```

### UI Patterns

**Modals**
- Session creation modal (`#modal`)
- Project creation modal (`#projectModal`)
- Confirmation modal (`#confirmModal`)
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
