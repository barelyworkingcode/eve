# Eve

A browser-based LLM chat interface that proxies to [relayLLM](https://github.com/barelyworkingcode/relayLLM) for all LLM concerns. Eve provides the UI layer: chat, file editing, terminals, and authentication.

## Features

- **Multi-provider chat** - Access any LLM provider configured in relayLLM (Claude, Gemini, LM Studio, etc.)
- **Projects** - Group sessions under named projects with a default model, directory path, and allowed tools
- **Permission forwarding** - Tool permission prompts forwarded to the browser for approve/deny
- **File browser & editor** - Browse project files, edit with Monaco editor, rename/delete/move via context menu
- **Integrated terminal** - Open a shell in the project directory directly from the UI
- **Passkey authentication** - Secure access with WebAuthn passkeys (first visitor becomes owner)
- **File attachments** - Drag/drop, click, or paste files and images into prompts
- **Session stats** - Real-time context usage % and cost display
- **Scheduled tasks** - Run LLM prompts on a schedule via relayScheduler (daily, hourly, cron, etc.)

## Requirements

- Node.js 18+
- [relayLLM](https://github.com/barelyworkingcode/relayLLM) running (default: `http://localhost:3001`)

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
npm run test:watch        # Unit tests in watch mode
```

## Passkey Authentication

Eve uses WebAuthn passkeys to secure access. The first person to visit the app enrolls their passkey and becomes the owner. Subsequent visitors must authenticate.

**First visit:** You'll see "Set Up Passkey" - click to enroll using Face ID, Touch ID, or your device PIN.

**Return visits:** You'll see "Sign In" - authenticate with your passkey to continue.

**Reset:** Delete `data/auth.json` to clear enrollment and allow a new owner.

**Disable:** Set `EVE_NO_AUTH=1` environment variable to bypass authentication entirely (CI / dev containers only).

### Trusted-subnet bypass

Eve can skip the passkey prompt for clients whose **IP address** (from the raw TCP connection — not the `Host` header) sits on a subnet Eve trusts. This is how Claude-driven Chrome automation reaches the UI without a passkey interstitial when running on the same machine or LAN.

**Default trusted set:** loopback (`127.0.0.0/8`, `::1`) plus each non-internal IPv4 interface's subnet, derived at startup from `os.networkInterfaces()`.

**Override:** set `EVE_TRUSTED_SUBNETS` to a comma-separated CIDR list (e.g. `10.0.0.0/24,192.168.1.0/24`) to pin the trusted set explicitly. Useful for multi-NIC hosts, VPN overlays, and container networks.

**Disable:** set `EVE_DISABLE_SUBNET_BYPASS=1` to require a passkey on every request, including loopback.

Eve's trust check **only** reads `req.socket.remoteAddress` — the `Host` header and `X-Forwarded-For` are never consulted for authorization decisions. Deployments behind a reverse proxy should either rely on the proxy to enforce auth, or pin `EVE_TRUSTED_SUBNETS` to exclude the proxy's IP so every request hits the passkey flow.

> This subnet-gated model replaces an earlier "localhost bypass" that incorrectly trusted the request `Host` header. Design details and implementation tracking live in [`plans/cozy-honking-toast.md`](plans/cozy-honking-toast.md).

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

Eve is a relay proxy. It does not manage LLM providers, sessions, or projects directly. **Every** browser call that touches backend state traverses the Eve server — the only direct external fetch from the browser is a public-CDN download of Kokoro TTS ONNX model weights and voice embeddings from `huggingface.co` (`public/tts-worker.js`), which carries no user data.

```
Browser ──WS──► Eve ──WS──► relayLLM       (sessions, messages, permissions)
Browser ──WS──► Eve ──local──► FileService  (file ops)
Browser ──WS──► Eve ──local──► TerminalMgr  (terminals)
Browser ──HTTP──► Eve ──HTTP──► relayLLM    (models, projects, sessions list)
Browser ──HTTP──► Eve ──HTTP──► relayLLM ──HTTP──► relayScheduler  (tasks)
```

## Security Model

Eve sits between a single browser user and a set of trusted backend services (`relayLLM`, `relayScheduler`, on-device TTS/STT daemons). Two trust boundaries need to be hardened: browser↔Eve and Eve↔backend.

### Browser ↔ Eve

- **WebAuthn passkey + session token.** The first visitor enrolls a passkey; subsequent visits exchange the passkey for a 256-bit session token stored in `localStorage` and sent on every request as `X-Session-Token` (HTTP) or the first `{type:'auth', token}` WebSocket message.
- **Fail-closed auth middleware.** `requireAuth` in `routes/index.js` wraps every data route. The WebSocket upgrade accepts the connection but blocks all non-auth frames until the token validates; an invalid token closes the socket with code `4001`.
- **Trusted-subnet bypass.** See the "Trusted-subnet bypass" section above. The check uses the raw TCP source address only — the `Host` header and `X-Forwarded-For` are never trusted for authorization.
- **No cookies.** Tokens travel in an explicit header, so the usual CSRF attack surface does not exist.
- **TLS on the wire.** Passkeys require a secure context, so any non-loopback deployment must set `HTTPS_KEY` / `HTTPS_CERT`. See [docs/https-setup.md](docs/https-setup.md).

### Eve ↔ backend

Eve is the only process that talks to `relayLLM`, which in turn proxies to `relayScheduler`. The transport between Eve and relayLLM is a **Unix domain socket + ephemeral bearer token**, reusing the pattern used by the Go `relay` orchestrator for MCP tool calls (`relay/tokens.go`, `relay/service_registry.go`, `relay/bridge/server.go`).

- **Socket mode (preferred).** `RELAY_LLM_SOCKET` points at a `0600`-permission Unix socket allocated by the relay orchestrator at spawn time. Kernel-enforced file permissions do the primary authorization work; the bearer token is defense-in-depth.
- **TCP mode (fallback).** `RELAY_LLM_URL` is used only when Eve and relayLLM run on different hosts. Must be `https://`, with certificate verification enabled (`rejectUnauthorized: true`) and an optional `RELAY_LLM_CA` for operators who run an internal CA. Plain `http://` off loopback is refused at startup — no silent downgrade.
- **Bearer token.** `RELAY_LLM_TOKEN` is a 32-byte hex value generated by the relay orchestrator at Eve/relayLLM spawn time and injected into both processes via environment variables. It is ephemeral — revoked automatically when either process exits, never written to disk. Eve sends it on every outbound HTTP request as `Authorization: Bearer <token>` and during the WebSocket upgrade as the same header, so relayLLM rejects unauthenticated upgrades before protocol-switching.
- **Parallel, not multiplexed.** The existing `relay.sock` carries MCP tool-call JSON; Eve↔relayLLM runs on its own socket so a leaked token in one channel cannot grant access to the other.
- **Fail-closed startup.** `RelayTransport.assertStartupConfig()` refuses to start on any insecure combination (off-loopback HTTP, missing token in non-dev modes, socket mode without token). There is no "skip verify" or "downgrade" option.
- **TTS / STT daemons** are hard-pinned to `127.0.0.1` (Kokoro :9997, Whisper :9998). They are not reachable from the network.

> **Implementation status.** Shipped. Design rationale and verification results (including a Chrome end-to-end test over the Unix socket) live in [`plans/cozy-honking-toast.md`](plans/cozy-honking-toast.md). The cross-repo pieces — the `bearerAuth` middleware + Unix socket listener in `../relayLLM`, and the `LLMChannel` credential injection in `../relay/service_registry.go` — landed alongside the Eve changes.

### What to watch out for

- Do **not** edit auth or trust logic without also updating `plans/cozy-honking-toast.md` and the verification tests.
- Do **not** re-introduce a "localhost" check that reads `req.headers.host`. The raw TCP source address is the only safe signal.
- Do **not** add backwards-compatibility flags that disable TLS or token validation on the Eve↔backend channel.

```
server.js                - Express + WebSocket server, relayLLM config, project cache
ws-handler.js            - WebSocket message dispatch to relay or local handlers
relay-client.js          - WebSocket bridge to relayLLM (one per browser connection)
slash-command-handler.js - Local slash commands (/clear, /help, /zsh, /bash, /claude)
routes/index.js          - HTTP proxy to relayLLM (models, projects, sessions, tasks)
routes/auth.js           - WebAuthn enrollment/login routes
auth.js                  - WebAuthn service
session-store.js         - Auth session token persistence
file-service.js          - File I/O with path traversal protection
file-handlers.js         - WebSocket adapter for file operations
file-watcher.js          - Event-driven file change detection
terminal-manager.js      - Server-side terminal management (node-pty)

public/
  index.html               - Main page structure
  constants.js             - Shared constants
  app.js                   - Thin orchestrator wiring modules, state owner
  ws-client.js             - WebSocket connection management
  message-dispatcher.js    - Server message routing and LLM event processing
  message-renderer.js      - Chat message rendering and formatting
  file-attachment-manager.js - File attach/paste/drag-drop for chat input
  task-manager.js          - Task CRUD client for relayScheduler
  modal-manager.js         - Modal dialogs
  sidebar-renderer.js      - Project/session/task sidebar
  tab-manager.js           - Session/file/terminal tab bar
  file-browser.js          - File explorer UI
  file-editor.js           - Monaco editor integration
  terminal-manager.js      - xterm.js terminal UI
  auth.js                  - Client-side WebAuthn authentication

test/
  unit/                  - Pure logic tests (no external deps)

docs/                    - Additional documentation (auth, HTTPS, testing)
data/                    - Runtime data (gitignored): auth, settings
```

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HTTPS_KEY` | - | Path to SSL private key file (enables HTTPS) |
| `HTTPS_CERT` | - | Path to SSL certificate file (enables HTTPS) |
| `DUAL_LISTEN` | - | Set to `true` to run HTTP alongside HTTPS. The HTTP listener binds to `127.0.0.1` only (not the LAN) to prevent plaintext traffic from escaping the host. |
| `HTTP_PORT` | `3000` | HTTP port when `DUAL_LISTEN` is enabled |
| `EVE_ALLOW_PLAINTEXT_REMOTE` | - | Explicit opt-in required to bind HTTP to a non-loopback address without HTTPS. Not for production — set only for local-dev convenience. |

### Browser auth

| Variable | Default | Description |
|----------|---------|-------------|
| `EVE_NO_AUTH` | - | Set to `1` to disable passkey authentication entirely. CI / dev containers only. |
| `EVE_TRUSTED_SUBNETS` | auto | Comma-separated CIDR list of subnets allowed to bypass the passkey prompt (e.g. `10.0.0.0/24,192.168.1.0/24`). Defaults to loopback plus every non-internal IPv4 interface derived from `os.networkInterfaces()`. See "Trusted-subnet bypass". |
| `EVE_DISABLE_SUBNET_BYPASS` | - | Set to `1` to require a passkey on every request, ignoring the trusted-subnet list (including loopback). |
| `EVE_SESSION_TTL_DAYS` | `7` | Session token lifetime in days. After this period the user must re-authenticate. |

### Eve ↔ relayLLM

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_LLM_SOCKET` | - | Path to a Unix domain socket provisioned by the `relay` orchestrator at spawn time. When set, Eve dials it via `http.Agent({ socketPath })` for both HTTP and WebSocket traffic. Kernel file permissions (`0600`) anchor authorization; no TLS is needed on this hop. Preferred transport in orchestrator-managed deployments. |
| `RELAY_LLM_URL` | `http://localhost:3001` | Fallback TCP URL for split-host deployments. Off-loopback values must use `https://`; plain `http://` to a remote host is refused at startup. |
| `RELAY_LLM_TOKEN` | - | Ephemeral bearer token, injected by the orchestrator into both Eve and relayLLM at spawn time. Sent on every HTTP request and every WebSocket upgrade as `Authorization: Bearer <token>`. Per-process-lifetime — never written to disk. |
| `RELAY_LLM_CA` | - | Optional PEM path for operators running an internal CA in front of relayLLM. Loaded into a shared `https.Agent` with `rejectUnauthorized: true`. There is no "skip verify" option. |

## Ecosystem

Eve is part of the Relay ecosystem. Each project works independently, but together they form a complete stack for giving LLMs secure access to macOS.

- **[Relay](https://github.com/barelyworkingcode/relay)** -- MCP orchestrator. Manages Eve as a background service with per-token permissions.
- **[relayLLM](https://github.com/barelyworkingcode/relayLLM)** -- LLM engine. Eve's single backend — proxies all session, project, permission, and task operations to relayLLM, which in turn proxies tasks to relayScheduler.
- **[relayScheduler](https://github.com/barelyworkingcode/relayScheduler)** -- Task scheduler. Runs LLM prompts on schedule. Eve reaches it indirectly through relayLLM.
- **[relayTelegram](https://github.com/barelyworkingcode/relayTelegram)** -- Telegram bot bridge to relayLLM sessions.
- **[macMCP](https://github.com/barelyworkingcode/macMCP)** -- Swift MCP server with 41 macOS-native tools.
- **[fsMCP](https://github.com/barelyworkingcode/fsmcp)** -- File system MCP server (read, write, edit, glob, grep, bash).

## License

[MIT License](./LICENSE)
