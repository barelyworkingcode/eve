# Eve Workspace

A multi-provider LLM web interface that provides a browser-based chat experience with persistent sessions.

## Features

- **Passkey authentication** - Secure access with WebAuthn passkeys (first visitor becomes owner)
- **Projects** - Group sessions under named projects with a default model per project
- **Persistent provider processes** - Maintains long-running LLM processes per session instead of spawning per message
- **File attachments** - Drag/drop or click to attach text files to your prompts
- **Session stats** - Real-time display of context usage % and session cost
- **Multi-session support** - Create and switch between multiple concurrent sessions
- **Model switching** - Change models mid-session with `/model` command

## Requirements

- Node.js 18+
- At least one LLM provider:
  - Claude CLI (`claude` command available in PATH)
  - Gemini CLI (`gemini` command available in PATH)
  - LM Studio server running locally (HTTP API)

## Authentication

Eve Workspace requires authentication credentials to use LLM providers. See [docs/authentication.md](docs/authentication.md) for detailed setup by provider.

**Quick start:**
- Claude: Set `ANTHROPIC_API_KEY` environment variable
- Gemini: Set `GOOGLE_GENAI_API_KEY` environment variable
- LM Studio: No authentication needed

**Important note:** Anthropic restricts third-party tools from using Claude.ai Pro/Max subscription credentials (as of January 2026). Use an Anthropic API key for Eve Workspace instead.

## Installation

```bash
npm install
```

## Configuration

### Provider Settings

Create `data/settings.json` to configure providers:

```json
{
  "providers": {
    "claude": true,
    "gemini": true,
    "lmstudio": false
  },
  "providerConfig": {
    "claude": {
      "path": "/custom/path/to/claude",
      "responseTimeout": 120000,
      "debug": false
    },
    "gemini": {
      "path": null,
      "responseTimeout": 120000,
      "debug": false
    }
  },
  "debug": false
}
```

**Provider options:**
- `providers` - Enable/disable providers (disabled providers won't appear in model dropdowns)
- `providerConfig.*.path` - Custom CLI path (overrides `CLAUDE_PATH`/`GEMINI_PATH` env vars)
- `providerConfig.*.responseTimeout` - Response timeout in ms (default: 120000)
- `providerConfig.*.debug` - Enable debug logging for the provider

Existing projects using a disabled provider will be grayed out in the sidebar and cannot be accessed.

### LM Studio

Create `data/lmstudio-config.json` to use local LM Studio models:

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "models": [
    {
      "id": "llama-3.1-8b",
      "label": "Llama 3.1 8B",
      "contextWindow": 32768
    }
  ]
}
```

**Required fields:**
- `baseUrl` - LM Studio server URL (default: `http://localhost:1234/v1`)
- `models` - Array of available models with `id`, `label`, and `contextWindow`

Models configured here appear in the model selector grouped under "LM Studio".

## Usage

```bash
npm start
# or for development with auto-reload:
npm run dev
```

Open http://localhost:3000 in your browser.

### Custom Data Directory

All persistent data (projects, settings, sessions, auth) defaults to `./data`. Override with `--data`:

```bash
node server.js --data /var/eve/data
node server.js --data ../shared-data
npm start -- --data /custom/path
```

## Testing

```bash
npm test                  # Unit tests (no external deps required)
npm run test:integration  # Integration tests (needs CLI tools / LM Studio)
npm run test:all          # Both suites
```

Integration tests auto-skip when the required CLI (`claude`, `gemini`) or server (LM Studio) is unavailable.

## Passkey Authentication

Eve Workspace uses WebAuthn passkeys to secure access. The first person to visit the app enrolls their passkey and becomes the owner. Subsequent visitors must authenticate.

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
3. Select the default model (haiku, sonnet, or opus)

Projects persist to `data/projects.json` and survive server restarts. Sessions can optionally be associated with a project when created.

## How It Works

The server uses a provider system to support multiple LLM backends:

**CLI-based providers (Claude, Gemini):** Spawn persistent processes per session. For Claude:
```
claude --print --output-format stream-json --input-format stream-json --verbose --model <model>
```
Messages go to stdin as JSON, responses stream from stdout. Process stays alive for session lifetime.

**HTTP-based providers (LM Studio):** Make streaming HTTP POST requests to a local server. No persistent process needed - conversation history is maintained in-memory and sent with each request.

## Commands

Commands are split into two layers: **global commands** handled by the server regardless of provider, and **provider-specific commands** defined by each provider. `/help` shows both. Unrecognized commands pass through to the LLM.

### Global

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history - restarts session |
| `/zsh` | Open terminal in session directory |
| `/claude` | Open Claude CLI in session directory |
| `/help` | Show available commands |

### Claude

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch model |
| `/compact` | Compact conversation to reduce context usage |
| `/cost` | Show usage/billing info |
| `/context` | Show context window usage |
| `/args` | Show current CLI args |
| `/args-edit` | Add/remove CLI args - restarts process |
| `/cli-help` | Show `claude --help` output |

### Gemini

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch model |

### LM Studio

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch model |

### CLI Args Management (Claude)

Control Claude CLI flags at runtime without leaving the UI:

```
/args-edit --dangerously-skip-permissions     Add a flag
/args-edit --max-turns 5                      Add a flag with value
/args-edit --system-prompt "Be concise"       Quoted values supported
/args-edit --remove --max-turns               Remove a flag
/args-edit --clear                            Remove all custom args
/args-edit --model opus                       Shortcut for model switch
```

Custom args persist across server restarts. Internal flags (`--print`, `--output-format`, `--input-format`, `--verbose`, `--resume`) are protected and cannot be modified.

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
- **Browse** - Click folders to expand/collapse, click files to open in the editor
- **Rename** - Right-click a file or folder and select "Rename", or type directly inline
- **Delete** - Right-click and select "Delete" (files go to system trash for recovery)
- **New Folder** - Right-click and select "New Folder" to create a subdirectory
- **Move** - Drag files or folders onto a directory to move them

The file browser respects a whitelist of editable extensions (code, config, text files) and hides dotfiles.

## Scheduled Tasks

Projects can define automated tasks that run prompts on a schedule. Tasks are stored in `.tasks.json` in the project directory.

**Schedule types:**
- `daily` - Run at a specific time each day
- `hourly` - Run at a specific minute each hour
- `interval` - Run every N minutes
- `weekly` - Run on a specific day and time

**Example `.tasks.json`:**
```json
{
  "version": 1,
  "tasks": [
    {
      "id": "daily-review",
      "name": "Daily Code Review",
      "prompt": "Review recent changes and summarize",
      "schedule": { "type": "daily", "time": "09:00" },
      "enabled": true,
      "createdAt": "2026-02-06T10:00:00.000Z"
    }
  ]
}
```

The task scheduler watches for file changes and picks up updates automatically. Disabled tasks (`enabled: false`) are skipped.

## Architecture

```
server.js          - Express + WebSocket server, session management
auth.js            - WebAuthn passkey authentication service
providers/
  llm-provider.js     - Base provider class
  claude-provider.js  - Claude CLI integration
  gemini-provider.js  - Gemini CLI integration
  lmstudio-provider.js - LM Studio HTTP API integration
public/
  index.html       - Main page structure
  app.js           - Client-side WebSocket handling and UI
  auth.js          - Client-side WebAuthn authentication
  styles.css       - Styling
data/
  auth.json            - Passkey credentials (created on enrollment)
  settings.json        - Provider enable/disable settings (optional)
  projects.json        - Persisted projects (created automatically)
  lmstudio-config.json - LM Studio configuration (optional)
```

### Provider System

LLM providers are abstracted through the `LLMProvider` base class. Each provider implements:
- `startProcess()` - Initialize the LLM subprocess (CLI providers only)
- `sendMessage(text, files)` - Send user messages
- `handleEvent(event)` - Process LLM responses
- `kill()` - Terminate the subprocess or clear state

Provider selection based on model name:
- Models starting with "gemini" → GeminiProvider
- Models in `lmstudio-config.json` → LMStudioProvider
- All others → ClaudeProvider

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HTTPS_KEY` | - | Path to SSL private key file (enables HTTPS) |
| `HTTPS_CERT` | - | Path to SSL certificate file (enables HTTPS) |
| `EVE_NO_AUTH` | - | Set to `1` to disable passkey authentication |
