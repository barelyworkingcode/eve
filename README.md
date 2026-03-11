# Eve

A browser-based LLM chat interface that proxies to [relayLLM](https://github.com/barelyworkingcode/relay) for all LLM concerns. Eve provides the UI layer: chat, file editing, terminals, and authentication.

![Overview](showcase/screenshots/Overview%201.png)

![Chat with Claude](showcase/screenshots/Embedded%20Claude.png)

![File Editor](showcase/screenshots/Monico%20Editor.png)

## Features

- **Multi-provider chat** - Access any LLM provider configured in relayLLM (Claude, Gemini, LM Studio, etc.)
- **Projects** - Group sessions under named projects with a default model, directory path, and allowed tools
- **Permission forwarding** - Tool permission prompts forwarded to the browser for approve/deny
- **File browser & editor** - Browse project files, edit with Monaco editor, rename/delete/move via context menu
- **Integrated terminal** - Open a shell in the project directory directly from the UI
- **Passkey authentication** - Secure access with WebAuthn passkeys (first visitor becomes owner)
- **File attachments** - Drag/drop, click, or paste files and images into prompts
- **Session stats** - Real-time context usage % and cost display

## Demo

The `showcase/` directory contains sample projects, sessions, screenshots, and configuration files demonstrating the application. Copy `showcase/` to `data/` to explore the UI with pre-populated content.

## Requirements

- Node.js 18+
- [relayLLM](https://github.com/barelyworkingcode/relay) running (default: `http://localhost:3001`)

## Installation

```bash
npm install
```

## Configuration

### relayLLM Connection

Eve connects to relayLLM for all LLM operations. Set the URL via environment variable:

```bash
RELAY_LLM_URL=http://localhost:3001 npm start
```

Default: `http://localhost:3001`

### Local Settings

Create `data/settings.json` for Eve-specific settings:

```json
{
  "providerConfig": {
    "claude": {
      "path": "/custom/path/to/claude"
    }
  }
}
```

This only affects the local `/claude` terminal command path. All provider configuration (models, API keys, etc.) is managed in relayLLM.

## Usage

```bash
npm start
# or for development with auto-reload:
npm run dev
```

Open http://localhost:3000 in your browser.

### Custom Data Directory

Local persistent data (auth, settings, PIDs) defaults to `./data`. Override with `--data`:

```bash
node server.js --data /var/eve/data
npm start -- --data /custom/path
```

## Relay Registration

Register Eve as a [Relay](https://github.com/barelyworkingcode/relay) service so it launches automatically:

```bash
npm run register
```

This requires the Relay macOS app installed at `/Applications/Relay.app`. The service registers with autostart enabled on `http://localhost:3000`.

## Testing

```bash
npm test                  # Unit tests (no external deps required)
npm run test:all          # All tests
```

## Passkey Authentication

Eve uses WebAuthn passkeys to secure access. The first person to visit the app enrolls their passkey and becomes the owner. Subsequent visitors must authenticate.

**First visit:** You'll see "Set Up Passkey" - click to enroll using Face ID, Touch ID, or your device PIN.

**Return visits:** You'll see "Sign In" - authenticate with your passkey to continue.

**Reset:** Delete `data/auth.json` to clear enrollment and allow a new owner.

**Disable:** Set `EVE_NO_AUTH=1` environment variable to bypass authentication entirely.

### HTTPS for Mobile/LAN Access

WebAuthn requires a secure context. While `localhost` works with HTTP, accessing from other devices requires HTTPS. See [docs/https-setup.md](docs/https-setup.md) for mkcert setup instructions.

```bash
# Quick setup
brew install mkcert && mkcert -install
mkcert -cert-file ./certs/server.pem -key-file ./certs/server-key.pem localhost 192.168.1.100

# Start with HTTPS
HTTPS_CERT=./certs/server.pem HTTPS_KEY=./certs/server-key.pem npm start
```

## Projects

Projects let you group related sessions and set a default model. When creating a session under a project, it inherits the project's model setting.

To create a project:
1. Click the **+** button next to "Projects" in the sidebar
2. Enter a name and directory path
3. Select the default model
4. Optionally configure allowed tools (space-separated, e.g. `Read Glob Grep "Bash(git:*)"`)

To edit a project, click the pencil icon in the project header.

**Allowed tools** pre-approve CLI tools so they execute without prompting. Tools not in the allowed list trigger the permission forwarding flow.

Projects are managed via relayLLM and persist across restarts.

## Permission Forwarding

When an LLM provider encounters a tool that isn't pre-approved, Eve forwards the permission decision to the browser.

**How it works:**
1. relayLLM sends a `permission_request` to Eve via WebSocket
2. Eve forwards the request to the browser
3. A permission modal shows the tool name and input details
4. The user clicks Allow or Deny
5. The decision flows back through Eve to relayLLM

## Commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/zsh` | Open terminal in session directory |
| `/bash` | Open terminal in session directory |
| `/claude` | Open Claude CLI in session directory |
| `/help` | Show available commands |

Additional provider-specific commands (like `/model`, `/compact`, `/cost`) are handled by relayLLM.

## Stats Display

The header shows:
- **Context %** - Percentage of context window used (color-coded: green < 50%, yellow 50-80%, red > 80%)
- **Cost** - Cumulative session cost in USD

Hover over stats for detailed token counts.

## File Attachments

Attach files by:
1. Clicking the paperclip button
2. Dragging files onto the input area
3. Pasting from clipboard (Ctrl+V / Cmd+V) - works with images

Files are sent inline with your message wrapped in `<file name="...">` tags. Binary files (images, video, audio) are skipped.

## File Browser

Each project has a built-in file browser. Click the folder icon in the project header to expand it.

**Features:**
- **Browse** - Click folders to expand/collapse, click files to open in the Monaco editor
- **Edit** - Monaco editor with syntax highlighting, inline save
- **Rename** - Right-click a file or folder and select "Rename", or type directly inline
- **Delete** - Right-click and select "Delete" (files go to system trash for recovery)
- **New Folder** - Right-click and select "New Folder" to create a subdirectory
- **Move** - Drag files or folders onto a directory to move them

The file browser respects a whitelist of editable extensions (code, config, text files) and hides dotfiles.

## Integrated Terminal

Projects can open an interactive terminal directly in the UI. Click the terminal icon in the project header or use `/zsh` to launch a shell in the project directory. Powered by xterm.js on the client and node-pty on the server.

## Architecture

Eve is a relay proxy. It does not manage LLM providers, sessions, or projects directly.

```
Browser ──WS──► Eve ──WS──► relayLLM       (sessions, messages, permissions)
Browser ──WS──► Eve ──local──► FileService  (file ops)
Browser ──WS──► Eve ──local──► TerminalMgr  (terminals)
Browser ──HTTP──► Eve ──HTTP──► relayLLM    (models, projects, sessions list)
```

```
server.js              - Express + WebSocket server, relayLLM config, project cache
ws-handler.js          - WebSocket message dispatch to relay or local handlers
relay-client.js        - WebSocket bridge to relayLLM (one per browser connection)
routes/index.js        - HTTP proxy to relayLLM + local auth routes
routes/auth.js         - WebAuthn enrollment/login
auth.js                - WebAuthn service
file-service.js        - File I/O with path traversal protection
file-handlers.js       - WebSocket adapter for file operations
terminal-manager.js    - Server-side terminal management (node-pty)


public/
  index.html             - Main page structure
  app.js                 - Client application (WebSocket, UI state, rendering)
  styles.css             - Styling
  auth.js                - Client-side WebAuthn authentication
  auth.css               - Authentication styling
  ws-client.js           - WebSocket connection management
  message-renderer.js    - Chat message rendering
  modal-manager.js       - Modal dialogs
  sidebar-renderer.js    - Project/session sidebar
  tab-manager.js         - Session/file/terminal tab bar
  file-browser.js        - File explorer UI
  file-editor.js         - Monaco editor integration
  terminal-manager.js    - xterm.js terminal UI

test/
  helpers/               - Shared mocks (MockWebSocket, createMockSession)
  unit/                  - Pure logic tests (no external deps)

docs/                    - Additional documentation (auth, HTTPS)
showcase/                - Sample projects, sessions, screenshots for demo
data/                    - Runtime data (gitignored): auth, settings, PIDs
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `RELAY_LLM_URL` | `http://localhost:3001` | relayLLM server URL |
| `HTTPS_KEY` | - | Path to SSL private key file (enables HTTPS) |
| `HTTPS_CERT` | - | Path to SSL certificate file (enables HTTPS) |
| `EVE_NO_AUTH` | - | Set to `1` to disable passkey authentication |

## Related Projects

Eve is part of a trio of projects that combine to give LLMs secure access to macOS. Each works independently, but together they form a complete stack: **Eve** provides the browser UI, **Relay** handles LLM orchestration and security, and **macMCP** exposes native macOS capabilities.

- **[Relay](https://github.com/barelyworkingcode/relay)** -- MCP orchestrator for macOS with token-based security and per-tool permissions. Includes relayLLM for LLM session management.
- **[macMCP](https://github.com/barelyworkingcode/macMCP)** -- Standalone Swift MCP server with 41 macOS-native tools (Calendar, Contacts, Mail, Messages, etc.).

## License

[MIT License](./LICENSE)
