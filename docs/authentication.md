# Authentication & Transport Security

Eve has two trust boundaries that need to be hardened independently:

1. **Browser ↔ Eve** — human user with a WebAuthn passkey.
2. **Eve ↔ backend** — Eve server talking to the `relay` orchestrator's frontend socket, which reverse-proxies onward to `relayLLM` (sessions, models, permissions) and `relayScheduler` (tasks), and serves project/MCP routes itself.

This document explains both. Full design rationale, threat model, and verification results live in [`plans/cozy-honking-toast.md`](../plans/cozy-honking-toast.md). The implementation shipped end-to-end across `eve/`, `../relayLLM/`, and `../relay/` — each section below describes the live behavior.

---

## Browser ↔ Eve

### WebAuthn passkey + session token

- The first visitor enrolls a passkey using Face ID / Touch ID / device PIN and becomes the owner (`data/auth.json`).
- Subsequent visitors prove possession of the passkey to obtain a 256-bit hex session token (`session-store.js`). The token is generated with `crypto.randomBytes(32)`, stored server-side in an in-memory map, and persisted alongside auth data with mode `0600`.
- Tokens live for 7 days and are sent on every subsequent call:
  - **HTTP**: `X-Session-Token: <token>` header.
  - **WebSocket**: the first frame after connect must be `{"type":"auth","token":"<token>"}`. All other frames are rejected until the auth frame validates.
- Invalid or expired tokens return HTTP `401` on routes and close the WebSocket with code `4001`.
- There are **no cookies** in this scheme — the explicit header carries the token, so the usual CSRF surface doesn't exist.

### Trusted-subnet bypass

Eve can skip the passkey prompt for clients sitting on a trusted subnet. This is how Claude-driven Chrome automation can hit Eve's UI without a passkey interstitial when it runs on the same machine / LAN.

The check uses **only** `req.socket.remoteAddress` — the raw TCP source address. `Host` and `X-Forwarded-For` headers are explicitly ignored for authorization purposes, because both are attacker-controllable.

**Default trusted set** (computed once at startup):

- `127.0.0.0/8`
- `::1`
- Every non-internal IPv4 interface's `/CIDR`, derived from `os.networkInterfaces()`

**Controls:**

| Variable | Purpose |
|---|---|
| `EVE_TRUSTED_SUBNETS` | Comma-separated CIDR list (e.g. `10.0.0.0/24,192.168.1.0/24`) that **replaces** the default set. Useful for multi-NIC hosts, VPN overlays, or container networks. |
| `EVE_DISABLE_SUBNET_BYPASS` | Set to `1` to ignore the trusted-subnet list entirely (including loopback) and require a passkey on every request. |
| `EVE_NO_AUTH` | Set to `1` to disable auth completely. **CI / dev containers only.** |

### Session lifetime

Session tokens default to **7 days**. Configurable via `EVE_SESSION_TTL_DAYS` (e.g. `EVE_SESSION_TTL_DAYS=30` for 30-day sessions). After expiry the user must re-authenticate — on a browser that means the passkey prompt, on the iOS app it means the Safari auth sheet (one Face ID tap).

### iOS native app (Relay Client)

iOS WKWebView blocks the WebAuthn API for local/dynamic hostnames (it requires an Associated Domains entitlement verified by Apple's CDN, which can't reach `eve.lan`). Eve handles this with a Safari-based fallback:

1. The web auth page calls `navigator.credentials.get()` in WKWebView — this fails with `NotAllowedError`.
2. The catch block detects the error + the `SafariAuth` Capacitor plugin → calls `SafariAuth.login()`.
3. The native plugin opens `ASWebAuthenticationSession` — a Safari sheet slides up pointing at `https://eve.lan/api/auth/safari-login`.
4. Eve serves a standalone page that runs the full WebAuthn ceremony in Safari's context (where passkeys work natively).
5. On success, the page redirects to `relayclient://auth-callback?token=<session-token>`.
6. `ASWebAuthenticationSession` captures the callback URL, extracts the token, and returns it to JavaScript.
7. The token is stored in WKWebView `localStorage` — the app is authenticated for `EVE_SESSION_TTL_DAYS` without re-prompting.

The flow is transparent to the user: they tap "Sign In", see Face ID, and they're in. The Safari sheet appears and dismisses automatically.

**Relevant code:**
- `../relayClient/ios/App/App/Plugins/SafariAuth/SafariAuthPlugin.swift` — native plugin wrapping `ASWebAuthenticationSession`
- `../relayClient/ios/App/App/RelayViewController.swift` — provides the presentation anchor (`ASWebAuthenticationPresentationContextProviding`)
- `eve/routes/auth.js` — `/api/auth/safari-login` standalone passkey page
- `eve/public/auth.js` — `NotAllowedError` catch → `SafariAuth.login()` fallback

### Rate limiting

WebAuthn enrollment and login endpoints are rate-limited at **10 attempts per 15 minutes per client IP**, using `req.socket.remoteAddress` as the key. Excess attempts return `429`.

### TLS

WebAuthn requires a "secure context". `localhost` is special-cased by browsers and works over HTTP, but any LAN / remote access requires HTTPS. See [`docs/https-setup.md`](https-setup.md) for mkcert instructions.

When `HTTPS_KEY` / `HTTPS_CERT` are set, `DUAL_LISTEN=true` enables a secondary HTTP listener. That listener binds to `127.0.0.1` only — it does **not** expose plaintext to the LAN. Override with `EVE_ALLOW_PLAINTEXT_REMOTE=1` (not recommended).

---

## Eve ↔ backend

Eve's only outbound channel is a single connection to the `relay` orchestrator's **frontend socket**. relay authenticates each request, then reverse-proxies it to whichever managed service registered the route — `relayLLM` for sessions/models/permissions, `relayScheduler` for tasks — over that service's own internal socket; relay serves project/MCP routes itself. Eve never dials relayLLM or relayScheduler directly. The on-device TTS / STT daemons bind to `127.0.0.1` only. So securing Eve↔relay covers the full outbound surface.

### Transport modes

| Mode | When it applies | Transport | Authentication | TLS |
|---|---|---|---|---|
| **Socket (preferred)** | `RELAY_FRONTEND_SOCKET` is set — typically by the `relay` orchestrator when it spawns Eve | Unix domain socket (`AF_UNIX`) with mode `0600` | Ephemeral bearer token in `Authorization` header | Not applicable — kernel FS permissions anchor authorization |
| **TCP (fallback)** | Split-host deployments where Eve and relay run on different machines | HTTPS + WSS | Ephemeral bearer token + TLS certificate validation | Required. Plain `http://` to an off-loopback host is refused at startup. |

Both modes go through a single `RelayTransport` abstraction on the Eve side — call sites never pick between them.

### Ephemeral bearer token

The token model mirrors the Go `relay` orchestrator's existing MCP-token scheme (`relay/service_registry.go`, `relay/frontend_server.go`, `relay/bridge/server.go`):

1. At spawn time, the orchestrator generates a fresh 32-byte hex frontend token via `crypto/rand`.
2. relay's frontend listener is configured with that token, and the plaintext is injected into the Eve process via `RELAY_FRONTEND_TOKEN`. Eve is the only holder of the frontend token — it is **not** shared with relayLLM.
3. Every outbound HTTP request from Eve carries `Authorization: Bearer <token>`.
4. WebSocket upgrades carry the same header, so relay's `frontendBearerAuth` rejects unauthenticated upgrades **before** protocol-switching — no half-open session allocation.
5. relay then strips Eve's token and injects each managed service's own **internal** token before dialing it (`enhanced_services.go`), so the Eve↔relay and relay↔service hops never share a credential.
6. When Eve exits, the orchestrator tears down the frontend listener. The token never touches disk and is not valid beyond the process lifetime that created it.

The `RELAY_FRONTEND_TOKEN` channel is **separate** from the `RELAY_MCP_TOKEN` bridge channel (relayLLM/MCP servers → relay) — distinct sockets with distinct tokens, so a leak in one channel does not grant access to the other.

### Startup validation

On startup, Eve calls `relayTransport.assertStartupConfig()` which hard-fails the process if:

- Socket mode is selected (`RELAY_FRONTEND_SOCKET` set) but `RELAY_FRONTEND_TOKEN` is missing.
- TCP mode (`RELAY_FRONTEND_URL`) points off-loopback and `RELAY_FRONTEND_TOKEN` is missing.
- TCP mode points off-loopback and does not use `https://`.

The one tolerated case is loopback TCP (`http://localhost:*`) with no token: it prints a loud warning instead of failing, for local dev. There is **no** "skip TLS verify" option and **no** silent HTTPS → HTTP downgrade.

### Certificate verification (TCP mode)

TLS uses Node's default `rejectUnauthorized: true`. For operators running an internal CA, set `RELAY_FRONTEND_CA` to a PEM bundle path; it is loaded into a shared `https.Agent` used by both HTTP and WebSocket calls.

### TTS / STT daemons

Kokoro (`:9997`) and Whisper (`:9998`) are hard-pinned to `127.0.0.1`. They are not reachable from the network and do not participate in the relay token scheme.

---

## Provider authentication (relayLLM)

Provider credentials (Anthropic API keys, Google API keys, LM Studio config, Claude CLI OAuth) are configured in **relayLLM**, not Eve. Eve never sees them.

Common patterns:

- **Claude**: `ANTHROPIC_API_KEY` environment variable or `claude login` (CLI OAuth).
- **Gemini**: `GOOGLE_GENAI_API_KEY` environment variable.
- **LM Studio**: No authentication by default; token auth is available in relayLLM config.

### Pro / Max subscription limitation

As of January 2026, Anthropic restricts third-party tools from using Claude.ai Pro/Max subscription credentials. This applies to all third-party applications.

If you authenticate via `claude login` (CLI OAuth):

- Works for personal local use on your machine.
- Will fail if used via Eve / relayLLM on a shared server or remote access.

**For shared or remote usage**, use an Anthropic API key instead.

---

## Troubleshooting

**"Unauthorized" on every request**
- You probably enrolled a passkey and are now hitting Eve from a client whose IP is not in the trusted-subnet set. Either sign in with the passkey, or add the client subnet to `EVE_TRUSTED_SUBNETS`.

**"Relay service unavailable"**
- Check that the `relay` orchestrator is running (and that relayLLM/relayScheduler are registered — relay returns `502` if the upstream service for a route is down).
- If you're running under the `relay` orchestrator, confirm `RELAY_FRONTEND_SOCKET` and `RELAY_FRONTEND_TOKEN` are present in Eve's environment.
- If you're running in TCP mode, confirm `RELAY_FRONTEND_URL` is `https://` off loopback and `RELAY_FRONTEND_TOKEN` is set.

**Startup fails with "insecure relay configuration"**
- Eve refused to start because `RELAY_FRONTEND_URL` points at a remote host over plain `http://`, or `RELAY_FRONTEND_TOKEN` is missing. Fix the config — do not try to bypass the check.

**Passkey prompt appears on LAN client you expected to trust**
- The client's IP isn't in the trusted set. Log the resolved trusted CIDRs at startup (Eve prints them at boot) and either add the client subnet to `EVE_TRUSTED_SUBNETS` or fix whatever NAT / routing makes the client appear from an unexpected source address.

**"API key not found" or provider errors**
- Provider authentication is configured in relayLLM, not Eve. Check relayLLM logs for details.

**Provider not appearing in model list**
- Provider may be disabled in relayLLM settings.
- Check provider authentication is set up in relayLLM.
- Restart relayLLM after changing authentication.
