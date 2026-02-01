# Eve Workspace

A multi-provider LLM web interface that provides a browser-based chat experience with persistent sessions.

## Features

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

## Installation

```bash
npm install
```

## Configuration

### Provider Settings

Create `data/settings.json` to enable/disable providers:

```json
{
  "providers": {
    "claude": true,
    "gemini": true,
    "lmstudio": false
  }
}
```

Disabled providers will not appear in model dropdowns. Existing projects using a disabled provider will be grayed out in the sidebar and cannot be accessed.

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

| Command | Description |
|---------|-------------|
| `/model` | Show current model |
| `/model <name>` | Switch model - restarts session |
| `/clear` | Clear conversation history - restarts session |
| `/cost` | Show usage/billing info (provider-specific) |
| `/context` | Show context window usage details (provider-specific) |
| `/compact` | Compact conversation to reduce context usage (provider-specific) |
| `/help` | Show available commands |

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

## Architecture

```
server.js          - Express + WebSocket server, session management
providers/
  llm-provider.js     - Base provider class
  claude-provider.js  - Claude CLI integration
  gemini-provider.js  - Gemini CLI integration
  lmstudio-provider.js - LM Studio HTTP API integration
public/
  index.html       - Main page structure
  app.js           - Client-side WebSocket handling and UI
  styles.css       - Styling
data/
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
