# Eve Backlog

## UI Polish

- [ ] Welcome screen "New Session" button should open Shell Launcher dialog instead of legacy modal
- [ ] Session names in Resume tab should show first message preview (like chat app previews)
- [ ] File tree should highlight the currently-open file
- [ ] Context menu on files: add "Open Terminal Here" option
- [ ] Context menu on folders: add "Open Terminal Here" option

## Code Cleanup

- [ ] Remove `sidebar-renderer.js` — replaced by `sidebar/project-tree.js`
- [ ] Remove `file-browser.js` — replaced by `sidebar/file-tree-node.js`
- [ ] Remove `modal-manager.js` — replaced by `dialogs/*.js` (requires migrating session, project, confirm, and permission modals)
- [ ] Remove dual state maps in `app.js` (`this.sessions` vs `this.state.sessions`, `this.projects` vs `this.state.projects`)
- [ ] Migrate remaining legacy modules to EventBus (message-renderer, file-editor, tab-manager, ws-client)
- [ ] Remove `app.*` bridge pattern — dialogs should use container/bus exclusively, not `container.get('app')`
- [ ] Delete unused `terminal-manager.js` (server-side, root level) — terminals now in relayLLM

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
- [ ] Phase 4 completion: full event-driven rewrites of content modules (chat-input extraction, event-driven message-renderer, etc.)
