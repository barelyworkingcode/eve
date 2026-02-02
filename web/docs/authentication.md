# Authentication Guide

Eve Workspace supports multiple LLM providers with different authentication methods.

## Authentication Options

### Claude CLI

Two authentication methods:

**1. API Key (Recommended for Eve Workspace)**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```
- API usage is metered separately and billed to your Anthropic account
- No special setup required - works out of the box
- Supports all Claude models

**2. CLI OAuth (Local Use)**
```bash
claude login
```
- Authenticates using your Claude.ai account
- For **local personal use only** - suitable if you run Eve Workspace on your own machine
- See important limitation below

### Gemini CLI

API Key only:
```bash
export GOOGLE_GENAI_API_KEY="..."
```
- Requires API key from Google AI Studio (https://aistudio.google.com)
- API usage is metered and billed separately

### LM Studio

No authentication required:
- Runs entirely locally
- No API key or account needed
- See `docs/` for LM Studio configuration

## Important Limitation: Pro/Max Subscriptions

**As of January 2026**, Anthropic restricts third-party tools from using Claude.ai Pro/Max subscription credentials. This applies to all third-party applications, including Eve Workspace.

If you authenticate via `claude login` (CLI OAuth):
- Works for personal local use on your machine
- Will fail if used via Eve Workspace on a shared server or remote access
- Anthropic blocks third-party apps from Pro/Max authentication

**For shared or remote usage**: Use an Anthropic API key instead. API key authentication has no such restrictions.

## Setup by Provider

### Claude with API Key

1. Generate an API key at https://console.anthropic.com/
2. Set environment variable:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   npm start
   ```
3. Eve Workspace will use your API key for all Claude models

### Claude with CLI OAuth

1. Run `claude login` in your terminal
2. Follow prompts to authenticate with your Claude.ai account
3. Start Eve Workspace:
   ```bash
   npm start
   ```
4. Works for local personal use only

### Gemini

1. Create API key at https://aistudio.google.com
2. Set environment variable:
   ```bash
   export GOOGLE_GENAI_API_KEY="..."
   npm start
   ```
3. Models starting with "gemini" will use this key

### LM Studio

1. Download LM Studio from https://lmstudio.ai
2. Start the LM Studio server
3. Configure `data/lmstudio-config.json` (see README)
4. No authentication required

## Billing & Usage

- **API Key usage**: Metered and billed separately to your Anthropic account
- **CLI OAuth usage**: Uses your Claude.ai subscription (local only)
- **LM Studio**: No billing - uses your local GPU/CPU only
- **Gemini API**: Metered and billed to your Google Cloud account

## Troubleshooting

**"API key not found" error**
- Check `ANTHROPIC_API_KEY` environment variable is set
- For Claude OAuth, ensure `claude login` completed successfully

**"Not authorized for Pro/Max"**
- You're running Eve Workspace remotely with CLI OAuth authentication
- Solution: Use an Anthropic API key instead

**Provider not appearing in model list**
- Provider may be disabled in `data/settings.json`
- Check provider authentication is set up (API key or login completed)
- Restart Eve Workspace after changing authentication
