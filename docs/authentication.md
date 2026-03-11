# Authentication Guide

Eve proxies to relayLLM for all LLM operations. Provider authentication (API keys, CLI logins) is configured in relayLLM, not in Eve.

## Eve Authentication

Eve itself uses WebAuthn passkeys to secure browser access. See the README for passkey setup.

## Provider Authentication (relayLLM)

Provider authentication is configured in relayLLM. Refer to relayLLM documentation for setup details.

Common patterns:
- **Claude**: `ANTHROPIC_API_KEY` environment variable or `claude login`
- **Gemini**: `GOOGLE_GENAI_API_KEY` environment variable
- **LM Studio**: No authentication required by default; token auth available in relayLLM config

## Important Limitation: Pro/Max Subscriptions

**As of January 2026**, Anthropic restricts third-party tools from using Claude.ai Pro/Max subscription credentials. This applies to all third-party applications.

If you authenticate via `claude login` (CLI OAuth):
- Works for personal local use on your machine
- Will fail if used via Eve/relayLLM on a shared server or remote access

**For shared or remote usage**: Use an Anthropic API key instead.

## Troubleshooting

**"Relay service unavailable"**
- Check that relayLLM is running on the configured URL
- Default: `http://localhost:3001`

**"API key not found" or provider errors**
- Provider authentication is configured in relayLLM, not Eve
- Check relayLLM logs for details

**Provider not appearing in model list**
- Provider may be disabled in relayLLM settings
- Check provider authentication is set up in relayLLM
- Restart relayLLM after changing authentication
