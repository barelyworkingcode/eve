# Eve Backlog

## UI Polish

- [ ] Welcome screen "New Session" button should open Shell Launcher dialog instead of legacy modal
- [ ] Session names in Resume tab should show first message preview (like chat app previews)
- [ ] File tree should highlight the currently-open file
- [ ] Context menu on files: add "Open Terminal Here" option
- [ ] Context menu on folders: add "Open Terminal Here" option

## Code Cleanup

Deletable once migrated:
- [ ] Remove `sidebar-renderer.js` — replaced by `sidebar/project-tree.js`
- [ ] Remove `file-browser.js` — replaced by `sidebar/file-tree-node.js`
- [ ] Remove `modal-manager.js` — requires migrating remaining modals to `dialogs/*.js`:
  - [ ] Session creation modal → Shell Launcher "Web Chat" flow (partially done)
  - [ ] Project create/edit modal → `dialogs/project-dialog.js` (planned, not yet created)
  - [ ] Confirm modal → `dialogs/confirm-dialog.js` (planned, not yet created)
  - [ ] Permission modal → `dialogs/permission-dialog.js` (planned, not yet created)
- [ ] Delete `terminal-manager.js` (server-side, root level) — terminals now in relayLLM

State consolidation:
- [ ] Remove dual state maps in `app.js` (`this.sessions`/`this.projects`/`this.models` → use `this.state.*` exclusively)
- [ ] Remove `this.sessionHistories` from app.js → move to `StateStore`
- [ ] Replace `loadProjects`/`loadSessions`/`loadModels` raw fetch with `ApiClient`

Module migration to EventBus (each can be done independently):
- [ ] `ws-client.js` → emit `ws:ready`, `ws:message`, `ws:disconnected` instead of calling `app.*`
- [ ] `message-dispatcher.js` → emit bus events instead of calling `app.messageRenderer.*`, `app.tabManager.*`, etc.
- [ ] `message-renderer.js` → subscribe to chat events from bus instead of being called by dispatcher
- [ ] `tab-manager.js` → subscribe to session/file events from bus
- [ ] `file-editor.js` → subscribe to file events from bus
- [ ] `terminal-manager.js` (client-side) → subscribe to terminal events from bus
- [ ] `task-manager.js` → use `ApiClient` instead of raw fetch
- [ ] `file-attachment-manager.js` → use container instead of `this.client.*`

Final cleanup:
- [ ] Remove `app.*` bridge pattern — all modules use container/bus exclusively
- [ ] Shrink `app.js` to ~100 lines (just wiring `AppShell`)

## Features

- [ ] Terminal template configuration UI (add/edit/remove custom templates via Eve settings)
- [ ] Pre-launch dialog for terminals (pick working directory, extra args before spawning)
- [ ] Split pane view — terminal beside editor, or chat beside terminal
- [ ] Command palette (Cmd+P) for quick actions
- [ ] File search (Cmd+Shift+F) across project files
- [ ] Tab reordering via drag-drop

## Mobile

- [ ] Swipe between terminal and chat tabs
- [ ] Long-press context menus on file tree items
- [ ] Adaptive layout: side-by-side on tablet, stacked on phone

## Architecture

- [ ] CSS split: break `styles.css` (3000+ lines) into thematic files (`variables.css`, `layout.css`, `sidebar.css`, `dialogs.css`, `chat.css`, `editor.css`, `terminal.css`, `tabs.css`, `mobile.css`)
- [ ] Extract `chat/chat-input.js` from `app.js` (textarea, submit, stop button, auto-resize)
- [ ] Create `layout/main-content.js` for content area switching (chat/editor/terminal/welcome)
- [ ] Create `layout/sidebar.js` for sidebar container (resize, swipe gesture)
- [ ] Rewrite `index.html` — remove inline modal HTML, simplify to minimal shell

## Vision (from original redesign discussion)

- [ ] Eve as a thin viewport — all process hosting in relayLLM
- [ ] Terminal template configuration screen via Relay's settings UI
- [ ] Better interplay between shells and web chat — seamless switching
- [ ] Support for additional terminal agents as they emerge (aider, goose, etc.)
- [ ] Explore: can terminal sessions be "pinned" / saved for later resumption?

## Things to Consider

**Eve might not need a backend.** The Node.js server does three things: serves static files, proxies WebSocket to relayLLM, and handles file operations. relayLLM could serve the frontend directly. File operations could move to fsMCP (already exists). At that point Eve is just a `public/` folder — no Node process, no port, no restarts. Relay.app could serve it from an embedded web view or bundle it. Already 80% there with the thin-client architecture.

**Terminal sessions and chat sessions are converging.** Both live in relayLLM, both have names, both can be resumed, both show in tabs. The distinction is just rendering (xterm vs chat bubbles). Unifying them under a single "workspace session" concept with a `type` field would collapse the Resume tab, tab persistence, and lifecycle management into one code path.

**The scheduler is underused.** relayScheduler currently only runs "prompt on a schedule." It could also schedule terminal commands ("run `git pull && npm test` every morning"), file operations ("back up key files daily"), or multi-step workflows. The Task dialog could become a general automation hub.

**Eve on iPad is close to viable.** The mobile bar, responsive grid, and touch-friendly file tree are there. The gap: iPadOS Safari doesn't handle xterm.js keyboard input well (virtual keyboard fights with terminal). A native iOS wrapper (WKWebView) with a proper keyboard accessory view would fix it. The existing macMCP Swift project is a template for the wrapper.

**Identity question: workspace coordinator vs IDE.** The file tree, editor, terminal, and AI chat in one window — that's an IDE. The question is whether to lean in (git status indicators, inline diffs, language server integration) or stay deliberately simple (coordinator for AI agents, not a code editor). Both are valid, but the answer shapes every future feature decision.
