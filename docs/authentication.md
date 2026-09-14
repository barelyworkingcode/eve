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

### Adding another browser

A second browser (phone, laptop, fresh profile) enrolls its own passkey through a five-minute window opened at the console — tray → **Allow Eve Passkey Enrolment…**, or `relay eve enrol` — rather than by deleting `data/auth.json` and re-bootstrapping. Eve never decides the window is open on its own: `enrollment-window.js` asks relay's frontend socket on every enrol request and caches the answer for 2 seconds. Full design, the wire contract, and why relay (not eve) owns the window: [`../relay/docs/eve-passkey-enrolment.md`](../../relay/docs/eve-passkey-enrolment.md).

### Revoking a browser

Eve doesn't have its own "remove this passkey" UI — that lives in relay's Settings → Passkeys (*Eve passkeys* section) and `relay eve list` / `relay eve revoke`, the same place an operator already manages relay's own passkeys. Eve's side is `passkey-sync.js`: it reports its credential list (id/label/created/last-used, never a public key or counter) at startup and after every enrolment, login, or applied revocation, and pulls pending revocations on a 30-second poll and, decisively, on every login attempt — so a revoked passkey stops working on its very next use rather than waiting for the poll. A relay-unreachable login check fails **open** (accepts the assertion) rather than locking every device out during a relay restart. Eve refuses to apply a revocation that would remove its last passkey. Full design and wire contract: [`../relay/docs/eve-passkey-enrolment.md`](../../relay/docs/eve-passkey-enrolment.md) ("Listing and revoking eve passkeys").

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

Separately, each authenticated WebSocket connection has its own limiter for expensive ops (search, transcription, TTS, AI invocation, session creation): **30 requests / 10 seconds** by default, configurable via `EVE_RATELIMIT_MAX` / `EVE_RATELIMIT_WINDOW_MS` (`ws-handler.js`). Excess requests get a `{type:'error'}` frame, not a disconnect.

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
| **Socket (preferred)** | `RELAY_FRONTEND_SOCKET` set — by the orchestrator when it launches Eve | Unix domain socket (mode `0600`) | None on the wire — relay authenticates the connection by Eve's process identity (launch Hello, below) | N/A |
| **TCP (fallback)** | Split-host / dev: not relay-launched | HTTPS + WSS | Explicit `RELAY_FRONTEND_TOKEN` bearer + TLS cert validation | Required. Plain `http://` to an off-loopback host is refused at startup. |

Both modes go through a single `RelayTransport` (`relay-transport.js`); call sites never pick between them.

### Launch identity (relay-launched Eve)

Eve holds no relay credential in its environment or argv — on macOS any same-user process can read both. Contract: `../spec-launch-identity.md`; Eve's side is `launch-identity.js`.

1. relay writes a one-shot 64-hex secret into a pipe, passes the read end as fd 3, and sets `RELAY_LAUNCH_FD=3` alongside `RELAY_BRIDGE_SOCKET`, `RELAY_SERVICE_ID` and `RELAY_FRONTEND_SOCKET`. No `RELAY_FRONTEND_TOKEN` / `RELAY_SERVICE_TOKEN` / `RELAY_MCP_TOKEN` is set.
2. At the top of `server.js`, before anything that can spawn a child, Eve reads fd 3 to EOF, closes it, validates the shape, and removes `RELAY_LAUNCH_FD` from its environment so no child inherits it.
3. Eve sends `{"type":"Hello","name":"<RELAY_SERVICE_ID>","token":"<secret>"}` on `RELAY_BRIDGE_SOCKET` and waits for `{"type":"OK","data":{"service_id":…,"relay_pid":…}}`. relay binds the connection peer's kernel audit token (pid + pidversion) as Eve's identity and spends the secret.
4. Only then does Eve make its first frontend call and start listening. Every frontend-socket request and WS upgrade goes out with **no** `Authorization` header; relay recognises Eve's process. A stray `RELAY_FRONTEND_TOKEN` is ignored in socket mode.
5. relay injects each managed service's own **internal** token when it proxies onward, so Eve never sees a backend credential.

Any failure while `RELAY_LAUNCH_FD` is set — unreadable fd, wrong shape, missing bridge socket or service id, Hello refused, malformed, or timed out — logs `Refusing to start: relay launch identity failed: …` (never the secret) and exits `1`. There is no fallback to an environment token.

### Startup validation

`relayTransport.assertStartupConfig()` hard-fails the process if:

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

**"Relay service unavailable" / 502** — Check the `relay` orchestrator is running (relay returns `502` if the upstream service for a route is down). Under the orchestrator, confirm `RELAY_FRONTEND_SOCKET` is in Eve's environment and the log shows `Relay launch identity bound`. In TCP mode, confirm `RELAY_FRONTEND_URL` is `https://` off loopback with `RELAY_FRONTEND_TOKEN` set.

**Startup fails with insecure relay config** — `RELAY_FRONTEND_URL` points at a remote host over plain `http://`, or `RELAY_FRONTEND_TOKEN` is missing for an off-loopback TCP relay. Fix the config — do not bypass the check.

**"Refusing to start: relay launch identity failed"** — Eve was started with `RELAY_LAUNCH_FD` set but could not complete the Hello. Start Eve through relay (`npm run relay:restart`), not by hand with that variable copied from another process: the secret is one-shot per launch.

**Passkey prompt on a LAN client you expected to trust** — Its IP isn't in the trusted set. Eve logs the resolved trusted CIDRs at boot; add the subnet to `EVE_TRUSTED_SUBNETS` or fix the NAT/routing that makes the client appear from an unexpected source address.

**Provider errors / model not in list** — Provider authentication is configured in relayLLM, not Eve. Check relayLLM logs and settings.