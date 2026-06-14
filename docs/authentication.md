# Authentication & Transport Security

Eve has two trust boundaries, hardened independently:

1. **Browser ↔ Eve** — human user with a WebAuthn passkey.
2. **Eve ↔ backend** — Eve talking to the `relay` orchestrator's frontend socket, which reverse-proxies onward to `relayLLM` (sessions, models, permissions) and `relayScheduler` (tasks), and serves project/MCP routes itself.

---

## Browser ↔ Eve

### WebAuthn passkey + session token

- The first visitor enrolls a passkey (Face ID / Touch ID / device PIN) and becomes the owner (`data/auth.json`, mode `0600`).
- Subsequent visitors prove possession of the passkey to obtain a 256-bit hex session token (`session-store.js`): `crypto.randomBytes(32)`, stored server-side in an in-memory map and persisted to `data/sessions.json` (mode `0600`).
- Tokens default to **7 days** (configurable via `EVE_SESSION_TTL_DAYS`) and are sent on every call:
  - **HTTP**: `X-Session-Token: <token>` header.
  - **WebSocket**: after connect the client sends `{"type":"auth","token":"<token>"}`. Any other frame before auth is answered with an error and ignored; a valid token replies `{type:"auth_success"}`.
- Invalid or expired tokens return HTTP `401` on routes and close the WebSocket with code `4001`.
- There are **no cookies** — the explicit header carries the token, so the usual CSRF surface doesn't exist.

### Pre-enrollment gate

Until the first passkey is enrolled, Eve refuses **remote** traffic with a plain `404` (HTTP and WebSocket upgrade) — only loopback / trusted-subnet clients can reach the enrollment flow, so an internet scanner can't poke the auth code or race to claim ownership of a fresh box (`enrollment-gate.js`).

A public (internet) source IP can **never** bootstrap the first passkey — a hard rule that holds even with `EVE_ALLOW_ENROLLMENT=1` (that escape hatch only broadens enrollment to private networks). Bootstrap from the LAN / WireGuard; loopback always works. This assumes Eve sees the real client IP (a NAT port-forward), not a loopback-terminating reverse proxy. Once enrolled, the gate is a no-op.

### Trusted-subnet bypass

Eve can skip the passkey prompt for clients on a trusted subnet — e.g. Claude-driven Chrome automation hitting Eve's UI from the same machine / LAN.

The check uses **only** `req.socket.remoteAddress` — the raw TCP source address. `Host` and `X-Forwarded-For` are ignored for authorization; both are attacker-controllable (`trusted-network.js`).

**Default trusted set** (computed once at startup): `127.0.0.0/8`, `::1`, and every non-internal network interface's `/CIDR` from `os.networkInterfaces()` (IPv4 by mask, IPv6 by exact literal). Public ranges in the resolved set are flagged with a loud startup warning.

| Variable | Purpose |
|---|---|
| `EVE_TRUSTED_SUBNETS` | Comma-separated CIDR list that **replaces** the default set. For multi-NIC hosts, VPN overlays, or container networks. |
| `EVE_DISABLE_SUBNET_BYPASS` | `1` ignores the trusted-subnet list entirely (including loopback) and requires a passkey on every request. Does not affect the pre-enrollment gate (so it can't lock an un-enrolled box). |
| `EVE_NO_AUTH` | `1` disables auth completely (and the pre-enrollment gate). **CI / dev containers only.** |

### Origin pinning

By default the WebAuthn RP ID / expected origin derive from the request `Host`. Behind a reverse proxy, set `EVE_PUBLIC_ORIGIN` (e.g. `https://eve.lan`) to pin them to Eve's canonical origin instead — `Host` and `X-Forwarded-Proto` are attacker-controllable on a direct connection (`auth.js`).

### iOS native app (Relay Client)

iOS WKWebView blocks the WebAuthn API for local/dynamic hostnames (it requires an Associated Domains entitlement Apple's CDN can't verify for `eve.lan`). Eve provides a Safari-based fallback:

1. `navigator.credentials.get()` fails in WKWebView with `NotAllowedError`.
2. `public/auth.js` catches it and calls the `SafariAuth` Capacitor plugin.
3. The plugin opens `ASWebAuthenticationSession` pointing at `https://eve.lan/api/auth/safari-login`.
4. Eve serves a standalone page (`routes/auth.js`) that runs the full WebAuthn ceremony in Safari's context, where passkeys work.
5. On success the page redirects to `relayclient://auth-callback?token=<session-token>`; the session captures the callback, extracts the token, and hands it back to the app, which stores it in WKWebView `localStorage`.

To the user it's one "Sign In" tap and a Face ID prompt.

**Code:** `routes/auth.js` (`/api/auth/safari-login`), `public/auth.js` (fallback), and in the sibling repo `../relayClient/ios/App/App/Plugins/SafariAuth/SafariAuthPlugin.swift` + `RelayViewController.swift`.

### Rate limiting

WebAuthn enrollment and login endpoints are rate-limited at **10 attempts / 15 minutes per client IP** (`req.socket.remoteAddress` as the key). Excess attempts return `429` (`auth.js`).

### TLS

WebAuthn requires a secure context. `localhost` works over HTTP (browser special case); any LAN / remote access requires HTTPS. See [`docs/https-setup.md`](https-setup.md) for mkcert instructions.

- With no TLS configured, the primary listener binds `127.0.0.1` only. `EVE_ALLOW_PLAINTEXT_REMOTE=1` binds all interfaces (plaintext session tokens on the wire — not recommended). `EVE_BIND_HOST` pins the listen address explicitly (e.g. a WireGuard interface IP).
- With `HTTPS_KEY` / `HTTPS_CERT` set, `DUAL_LISTEN=true` adds a secondary HTTP listener bound to `127.0.0.1` only (no override) — for same-host curl scripts; it never exposes plaintext to the LAN.

---

## Eve ↔ backend

Eve's only outbound channel is a single connection to the `relay` orchestrator's **frontend socket**. relay authenticates each request, then reverse-proxies it to whichever managed service registered the route — `relayLLM` for sessions/models/permissions, `relayScheduler` for tasks — over that service's own internal socket; relay serves project/MCP routes itself. Eve never dials relayLLM or relayScheduler directly. The on-device TTS / STT daemons bind to `127.0.0.1` only. Securing Eve↔relay covers the full outbound surface.

### Transport modes

| Mode | When | Transport | Auth | TLS |
|---|---|---|---|---|
| **Socket (preferred)** | `RELAY_FRONTEND_SOCKET` set — typically by the orchestrator when it spawns Eve | Unix domain socket (mode `0600`) | Ephemeral bearer token in `Authorization` header | N/A — kernel FS permissions anchor authorization |
| **TCP (fallback)** | Split-host: Eve and relay on different machines | HTTPS + WSS | Ephemeral bearer token + TLS cert validation | Required. Plain `http://` to an off-loopback host is refused at startup. |

Both modes go through a single `RelayTransport` (`relay-transport.js`); call sites never pick between them.

### Ephemeral bearer token

Mirrors the Go orchestrator's MCP-token scheme (`../relay/service_registry.go`, `frontend_server.go`, `bridge/server.go`):

1. At spawn time the orchestrator generates a fresh 32-byte hex frontend token (`crypto/rand`).
2. relay's frontend listener is configured with it; the plaintext is injected into Eve via `RELAY_FRONTEND_TOKEN`. Eve is the only holder — it is **not** shared with relayLLM.
3. Every outbound HTTP request and WS upgrade from Eve carries `Authorization: Bearer <token>`, so relay's `frontendBearerAuth` rejects unauthenticated upgrades **before** protocol-switching.
4. relay strips Eve's token and injects each managed service's own **internal** token before dialing it (`../relay/enhanced_services.go`), so Eve↔relay and relay↔service never share a credential.
5. When Eve exits, the orchestrator tears down the listener. The token never touches disk and is invalid beyond that process lifetime.

`RELAY_FRONTEND_TOKEN` is **separate** from the `RELAY_MCP_TOKEN` bridge channel (relayLLM/MCP servers → relay) — distinct sockets, distinct tokens.

### Startup validation

`relayTransport.assertStartupConfig()` hard-fails the process if:

- Socket mode (`RELAY_FRONTEND_SOCKET` set) but `RELAY_FRONTEND_TOKEN` missing.
- TCP mode (`RELAY_FRONTEND_URL`) off-loopback and `RELAY_FRONTEND_TOKEN` missing.
- TCP mode off-loopback and not `https://`.

The one tolerated case is loopback TCP (`http://localhost:*`) with no token: a loud warning instead of a failure, for local dev. There is **no** "skip TLS verify" option and **no** silent HTTPS → HTTP downgrade.

### Certificate verification (TCP mode)

TLS uses Node's default `rejectUnauthorized: true`. For an internal CA, set `RELAY_FRONTEND_CA` to a PEM bundle path; it is loaded once into a shared agent used by both HTTP and WebSocket calls.

### TTS / STT daemons

Kokoro (TTS, `:9997`) and Whisper (STT, `:9998`) are pinned to `127.0.0.1` (ports overridable via `TTS_PORT` / `STT_PORT`). Not network-reachable; they don't participate in the relay token scheme.

---

## Provider authentication

Provider credentials (Anthropic, Gemini, OpenAI-compatible / LM Studio, Claude CLI OAuth) are configured in **relayLLM**, not Eve — Eve never sees them. See the relayLLM docs for setup and per-provider env vars.

---

## Troubleshooting

**"Unauthorized" on every request** — You enrolled a passkey and are now hitting Eve from an IP not in the trusted-subnet set. Sign in with the passkey, or add the client subnet to `EVE_TRUSTED_SUBNETS`.

**Remote client gets a bare 404** — No passkey is enrolled yet and the client isn't loopback / in a trusted subnet (pre-enrollment gate). Enroll from the LAN/WireGuard/loopback first; public IPs can never bootstrap.

**"Relay service unavailable" / 502** — Check the `relay` orchestrator is running (relay returns `502` if the upstream service for a route is down). Under the orchestrator, confirm `RELAY_FRONTEND_SOCKET` + `RELAY_FRONTEND_TOKEN` are in Eve's environment. In TCP mode, confirm `RELAY_FRONTEND_URL` is `https://` off loopback with `RELAY_FRONTEND_TOKEN` set.

**Startup fails with insecure relay config** — `RELAY_FRONTEND_URL` points at a remote host over plain `http://`, or `RELAY_FRONTEND_TOKEN` is missing. Fix the config — do not bypass the check.

**Passkey prompt on a LAN client you expected to trust** — Its IP isn't in the trusted set. Eve logs the resolved trusted CIDRs at boot; add the subnet to `EVE_TRUSTED_SUBNETS` or fix the NAT/routing that makes the client appear from an unexpected source address.

**Provider errors / model not in list** — Provider authentication is configured in relayLLM, not Eve. Check relayLLM logs and settings.