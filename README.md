# Home|Work

A browser-based LLM chat interface — AI for Home and for Work (and your homework). Proxies to [relayLLM](https://github.com/barelyworkingcode/relayLLM) (via the [relay](https://github.com/barelyworkingcode/relay) orchestrator) for all LLM concerns and provides the UI layer: chat, file editing, terminals, voice, and authentication. Codenamed `eve` internally.

> **Deploying on a LAN / WireGuard / the internet?** → [docs/setup.md](docs/setup.md) — one runbook for certs, the iOS trust profile, DNS/Firewalla, `.env`, the Relay service, and first-passkey enrollment. For local hacking: `npm install && npm start` (loopback, no passkey).

## Features

- **Multi-provider chat** — any LLM provider configured in relayLLM (Claude, Gemini, LM Studio, …).
- **Projects** — group sessions under a named project with a default model, directory, and allowed tools.
- **File browser & editor** — browse project files and edit them in a Monaco editor; rename/move/delete via context menu.
- **Integrated terminal** — open a shell in the project directory (xterm.js in the browser; the PTY runs in relayLLM and survives Eve restarts).
- **Voice** — on-device text-to-speech (Kokoro) and speech-to-text (Whisper), with a hands-free voice mode.
- **Scheduled tasks** — run LLM prompts on a schedule via relayScheduler.
- **Modules** — AI-backed mini-apps that live in a project (`<project>/modules/<name>/`) and run in a sandboxed iframe with a small `window.eve` SDK ([docs/modules.md](docs/modules.md)).
- **Passkey authentication** — WebAuthn passkeys; the first visitor becomes the owner.
- **File attachments** — drag/drop, click, or paste files and images into a prompt.

## Requirements

- Node.js 18+
- A running [relay](https://github.com/barelyworkingcode/relay) orchestrator (which fronts relayLLM). For standalone dev, relayLLM reachable at `http://localhost:3001`.

## Install & run

```bash
npm install
npm start          # or: npm run dev  (auto-reload)
```

Open http://localhost:3000.

Local persistent data (passkey enrollment, session tokens, local settings) defaults to `./data`. Override with `--data`:

```bash
node server.js --data /var/eve/data
```

## Configuration

Eve makes **one** outbound connection — to the relay orchestrator's frontend — and relay proxies onward to relayLLM/relayScheduler.

- **Orchestrator-managed (preferred):** relay injects `RELAY_FRONTEND_SOCKET` + `RELAY_FRONTEND_TOKEN` at spawn; no configuration needed.
- **Standalone/dev:** set `RELAY_FRONTEND_URL` (default `http://localhost:3001`).

Provider configuration (models, API keys) lives in relayLLM. An optional `data/settings.json` overrides only Eve-local bits, e.g. the `/claude` terminal command path:

```json
{ "providerConfig": { "claude": { "path": "/custom/path/to/claude" } } }
```

## Run as a Relay service

Register Eve so the Relay app launches it automatically (also registers the `eve-control` MCP):

```bash
npm run register
```

Requires the Relay macOS app at `/Applications/Relay.app`. Autostart is enabled at `EVE_PUBLIC_ORIGIN` (default `http://localhost:3000`).

## Authentication

Eve uses WebAuthn passkeys. The first visitor enrolls (Face ID / Touch ID / device PIN) and becomes the owner; everyone else signs in with a passkey. The passkey is exchanged for a 256-bit session token (7-day TTL) sent as `X-Session-Token` (HTTP) or the first `{type:'auth', token}` WebSocket frame.

- **Reset:** delete `data/auth.json`.
- **Disable (CI / dev containers only):** `EVE_NO_AUTH=1`.
- **Trusted-subnet bypass:** Eve can skip the passkey for clients whose raw TCP source IP sits on a trusted subnet — never the `Host` header or `X-Forwarded-For`. Defaults to loopback + local interface subnets; pin with `EVE_TRUSTED_SUBNETS`, or require a passkey everywhere with `EVE_DISABLE_SUBNET_BYPASS=1`.

WebAuthn needs a secure context, so any non-loopback deployment needs HTTPS. See [docs/https-setup.md](docs/https-setup.md) for mkcert, and [docs/authentication.md](docs/authentication.md) for the full model.

### Deploying over WireGuard or the internet

Both paths run the **same hardened config** — terminate TLS and pin one origin (`EVE_PUBLIC_ORIGIN`), then reach Eve at that one hostname from everywhere (split-horizon DNS: the hostname resolves to the LAN IP at home and the public IP outside). The runbook walks it end to end:

```bash
EVE_PUBLIC_ORIGIN=https://eve.example.com \
HTTPS_KEY=./certs/server-key.pem HTTPS_CERT=./certs/server.pem \
npm run start:secure
```

Full setup (certs, DNS, Firewalla, WireGuard-only and plaintext-over-tunnel variants): [docs/setup.md](docs/setup.md) and [docs/remote-access.md](docs/remote-access.md).

## Working in a project

Create a project from the sidebar **+**: name, directory, default model, and optional allowed tools (space-separated, e.g. `Read Glob Grep "Bash(git:*)"`). Allowed tools pre-approve CLI tools; anything else triggers permission forwarding.

- **Permission forwarding** — when an LLM hits a tool that isn't pre-approved, relayLLM sends a `permission_request`; Eve shows a modal and relays the Allow/Deny back.
- **Slash commands** (handled locally): `/clear`, `/zsh`, `/bash`, `/claude`, `/help`. Provider commands like `/model`, `/compact`, `/cost` are handled by relayLLM.
- **Attachments** — files are sent inline wrapped in `<file name="...">`; images go inline; oversized binaries are skipped.
- **Stats** — the header shows context-window % (green/yellow/red) and cumulative session cost.

## Architecture

Eve is a relay proxy: it owns no LLM providers, sessions, or projects. **Every** browser call that touches backend state goes through the Eve server — the only direct external fetch from the browser is the Kokoro TTS model download from `huggingface.co` (`public/tts-worker.js`), which carries no user data.

```
Browser ──WS──►  Eve ──WS──► relay ──► relayLLM        (sessions, messages, permissions, terminals)
Browser ──WS──►  Eve ──local─► FileService             (file ops)
Browser ──HTTP─► Eve ──HTTP─► relay ──► relayLLM        (models, sessions list)
Browser ──HTTP─► Eve ──HTTP─► relay                     (projects, MCPs — served by relay)
Browser ──HTTP─► Eve ──HTTP─► relay ──► relayScheduler  (tasks)
```

## Security model

Eve sits between one browser user and the relay orchestrator, which fronts the trusted backends. Two boundaries are hardened:

- **Browser ↔ Eve** — WebAuthn passkey + session token; fail-closed `requireAuth` on every route; the WS upgrade blocks all frames until the token validates. Cross-site WebSocket and clickjacking/XSS hardening (CSP, `nosniff`, frame/COOP headers); no cookies (so no CSRF surface). The trusted-IP check reads the raw TCP source address only. A public source IP can never bootstrap the first passkey.
- **Eve ↔ backend** — Eve's single egress is the relay frontend Unix socket (`0600`) + ephemeral bearer token, both injected by relay; TCP fallback (`RELAY_FRONTEND_URL`) is HTTPS-only with cert verification. `RelayTransport.assertStartupConfig()` refuses to start on any insecure combination — no skip-verify, no downgrade.

Operator reference: [docs/authentication.md](docs/authentication.md). Design rationale & verification: [docs/security-review-auth-transport.md](docs/security-review-auth-transport.md). Internet-exposure audit: [docs/security-audit-frontend.md](docs/security-audit-frontend.md).

## Common configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port. |
| `HTTPS_KEY` / `HTTPS_CERT` | – | TLS key/cert paths (enables HTTPS). |
| `EVE_PUBLIC_ORIGIN` | – | The single HTTPS origin Eve is reached at; pins WebAuthn + WebSocket origin. **Set this for any networked deployment.** |
| `RELAY_FRONTEND_URL` | `http://localhost:3001` | TCP fallback to relay when not socket-managed (HTTPS required off-loopback). |
| `EVE_NO_AUTH` | – | `1` disables auth (CI / dev only). |

Full variable reference (browser-auth, Eve↔relay, deployment): [docs/setup.md](docs/setup.md) and [docs/authentication.md](docs/authentication.md).

## Ecosystem

Part of the Relay ecosystem — each project runs independently, but together they give LLMs secure access to macOS.

- **[Relay](https://github.com/barelyworkingcode/relay)** — orchestrator. Runs Eve as a managed service and fronts all of Eve's backend traffic.
- **[relayLLM](https://github.com/barelyworkingcode/relayLLM)** — LLM engine (sessions, models, permissions). Reached through relay, not directly.
- **[relayScheduler](https://github.com/barelyworkingcode/relayScheduler)** — runs LLM prompts on a schedule; reached via relay's `/api/tasks` dispatch.
- **[relayTelegram](https://github.com/barelyworkingcode/relayTelegram)** — Telegram bot bridge.
- **[macMCP](https://github.com/barelyworkingcode/macMCP)** — Swift MCP server, 42 macOS-native tools.
- **[fsMCP](https://github.com/barelyworkingcode/fsmcp)** — file system MCP server (read, write, edit, glob, grep, bash).

## License

[MIT](./LICENSE)
