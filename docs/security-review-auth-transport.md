# Security Review: Auth Bypass & Eve↔Backend Transport

> Design record for Eve's two trust boundaries. Implemented across `eve/`, `../relay/`, and `../relayLLM/`.
> For the live operator reference (env vars, transport modes, troubleshooting) see [`authentication.md`](authentication.md); for browser-boundary findings see [`security-audit-frontend.md`](security-audit-frontend.md). This file keeps the threat model and rationale.

## Context

Two concerns motivated this work:

1. **Auth bypass scope.** Eve exposes an unauthenticated path so Chrome (driven by Claude browser automation) can reach the UI without a passkey prompt. The original "localhost bypass" was broken: it trusted the attacker-controllable `Host` header instead of the client IP, turning an intended loopback carve-out into a wildcard bypass for anyone on the network. The bypass must be real, IP-based, and restricted to the **same subnet** as the Eve server.
2. **Eve↔backend transport security.** When auth is active, every hop must be authenticated and encrypted: browser↔Eve and Eve↔backend.

Three architectural questions shaped the transport design:

- **Does the browser ever talk directly to a backend, or is everything proxied through Eve?** Proxied. The only direct external call from the browser is a public-CDN fetch in `public/tts-worker.js` (`HF_BASE`) pulling Kokoro TTS ONNX weights + voice embeddings from `huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX`. No session, project, message, file, or auth data flows there — a static asset download. Security-irrelevant but a privacy signal (the HF CDN can log which Eve instances load the model). Everything else — HTTP API, WebSocket, LLM, TTS/STT, terminals, tasks — goes through Eve.
- **Are Unix sockets a better fit than TCP+token+TLS?** Yes, for the co-located case. Eve and the relay orchestrator are spawned by the same parent. Unix sockets remove TLS-cert management, eliminate TCP port exposure, rely on kernel-enforced file permissions (`0600`), and beat loopback TCP on latency. TCP+TLS+token is retained as a fallback for split-host deployments only.
- **Is there an existing ephemeral-token pattern in the Relay ecosystem to reuse?** Yes — the Go orchestrator already mints per-process tokens: `relay/service_registry.go` generates a 32-byte `crypto/rand` hex token (`generateRandomHex`) at child spawn, injects it via env, and removes it on exit; `relay/tokens.go` does the SHA-256 hash-only storage (`hashToken`); the Unix-socket bridge is `relay/bridge/{types,server,client}.go`. The Eve↔backend channel reuses this *pattern* (orchestrator as token issuer, per-spawn injection, per-process lifetime) on a **separate** socket from the MCP bridge, so a leak in one channel does not grant access to the other.

---

## Findings — original state

### 1. Browser → Eve (one critical flaw)

Already sound: WebAuthn enrollment + 256-bit session tokens (`session-store.js`, 7-day TTL, `X-Session-Token` header / `{type:'auth'}` WS frame — no cookies, no CSRF surface); `requireAuth` on every data route; WS upgrade blocks all non-auth frames until `{type:'auth',token}` validates (`ws-handler.js`); rate-limited WebAuthn endpoints; optional TLS via `HTTPS_KEY`/`HTTPS_CERT`.

**CRIT-1 — the "localhost bypass" trusted the `Host` header, not the client IP.** `auth.js#isLocalhost()` and `ws-handler.js` derived "is localhost" from `req.headers.host`. An off-subnet attacker setting `Host: localhost` on an HTTP request or WS upgrade got unauthenticated access to every proxied data route, the full WebSocket surface (file read/write/delete/move, terminal create/input/close), and an `/api/auth/status` that reported `authenticated:true` — short-circuiting the UI login. This is the cautionary tale the replacement exists to prevent.

**CRIT-2 — no real same-subnet bypass existed.** The intended "allow Chrome on the same LAN" behavior had no implementation; the only CIDR-aware code was a rate-limit helper.

**MINOR — `DUAL_LISTEN` opened a plaintext listener on all interfaces.** With HTTPS on and `DUAL_LISTEN=true`, the secondary HTTP server listened without a host argument, binding `0.0.0.0` and exposing the full app over cleartext.

### 2. Eve → backend (was completely open)

All outbound Eve→backend traffic was unauthenticated and, by default, unencrypted: the generic HTTP proxy, session create, project-cache refresh, and the relay WebSocket bridge all dialed `RELAY_LLM_URL` (default `http://localhost:3001`) with no token, no TLS, no mutual identification. An operator pointing it off-loopback would stream every prompt, message, attachment, and terminal I/O in cleartext. The TTS/STT daemons defaulted to localhost but `TTS_HOST`/`STT_HOST` permitted remote hosts with zero auth.

### 3. Browser direct-to-backend audit

Confirms the proxy claim: the only direct external call from the browser is the Kokoro HF CDN download (above). All other client fetches use relative paths to Eve, and the WebSocket connects to `${protocol}//${window.location.host}` (`public/ws-client.js`). Hardening the two boundaries — browser↔Eve and Eve↔backend — hardens the whole system. The HF download is out of scope but worth noting in release notes so operators know where outbound traffic originates.

---

## Section A — Subnet-gated auth bypass

Replace the `Host`-header test with an IP-based same-subnet bypass that fails closed when the client can't be positively placed.

**`trusted-network.js`** (`TrustedNetworkService`, DI-injected like `AuthService`, plus pure helpers):

- `computeTrustedCidrs({ env, osModule })` — if `EVE_TRUSTED_SUBNETS` is set, parse it as a comma-separated CIDR list (it **replaces** the default). Otherwise enumerate non-internal IPv4 NICs via `os.networkInterfaces()` and derive each `/CIDR`. Always include `127.0.0.0/8` and `::1`.
- `isIpInCidrs(ip, cidrs)` — pure. Normalizes IPv6-mapped IPv4 (`::ffff:1.2.3.4` → `1.2.3.4`); IPv4 via bitmask math; IPv6 by exact-literal match (only loopback/link-local are ever trusted).
- `getClientIp(req)` — returns `req.socket.remoteAddress` **only**. `X-Forwarded-For` is deliberately not consulted; honoring it would reintroduce the spoofing class CRIT-1 represents. (A reverse-proxy topology would gate XFF on an explicit trusted-proxy allow-list — separate opt-in.)
- `isTrusted(req)` — `isIpInCidrs(getClientIp(req), this.cidrs)`, computed once at construction; resolved list logged at startup.
- Kill switch: `EVE_DISABLE_SUBNET_BYPASS=1` forces `isTrusted()` to `false`.
- Public-range warning: trusting a NIC subnet that resolves to a public range would grant passwordless access to unrelated internet hosts; the service logs a loud `WARN` when that happens (see `security-audit-frontend.md` C2).

`AuthService` does **not** absorb this concern — it stays focused on WebAuthn/sessions. `isLocalhost()` was deleted; `getRpId()`/`getOrigin()` remain because WebAuthn binds the RP ID by hostname, but they are no longer a trust boundary (the dangerous piggyback is gone). `EVE_NO_AUTH=1` remains an explicit kill switch for CI / dev containers.

Callers consume `trustedNetwork.isTrusted(req)`: `routes/index.js` `requireAuth`, `routes/auth.js` `/api/auth/status` (which returns `trusted: true`, not the old `localhost: true`), and `ws-handler.js` (`req.headers.host` parsing removed entirely).

**Why this shape:** fail-closed (anything we can't place must passkey); DI + SRP (network-trust vs credential-trust kept in separate classes); DRY (one helper replaces scattered "is localhost" logic); zero new deps.

---

## Section B — Eve ↔ relay frontend: Unix socket + ephemeral token

Eve's single outbound channel is to the `relay` orchestrator's **frontend socket**. relay authenticates the frontend bearer, then reverse-proxies each request to whichever managed service registered the route — `relayLLM` for sessions/models/permissions, `relayScheduler` for tasks — over that service's own internal socket + internal token. relay serves project/MCP routes itself. **Eve never dials relayLLM or relayScheduler directly.** Securing Eve↔relay therefore covers the full outbound surface.

This is a gateway model, chosen over a direct Eve↔relayLLM socket so that per-project policy relay owns (e.g. the `allowed_models` allowlist enforced by `../relay/frontend_model_guard.go` on `POST /api/sessions`) can be applied in-path, and so Eve holds exactly one credential regardless of how many backends sit behind relay.

**Transport modes (one `RelayTransport` abstraction, call sites never choose):**

| Mode | When | Transport | Auth | TLS |
|---|---|---|---|---|
| **Socket** (preferred) | `RELAY_FRONTEND_SOCKET` set (orchestrator-managed) | Unix socket (`AF_UNIX`), mode `0600` | Bearer token in `Authorization` | N/A — kernel FS perms anchor it; token is defense-in-depth |
| **TCP** (fallback) | split-host; `RELAY_FRONTEND_URL` set | HTTPS + WSS | Bearer + cert validation | Required; off-loopback `http://` refused at startup |

**Token model** (reuses the relay orchestrator pattern):

- The orchestrator mints a fresh frontend token at spawn and injects it as `RELAY_FRONTEND_TOKEN` into Eve only — it is **not** shared with relayLLM. (`../relay/relay_llm_channel.go` provisions the generic `FrontendChannel`: socket path `relay-frontend-<pid>.sock` + token; injected into frontend consumers, and into backends **by default** too — backward-compatible. A backend keeps the bearer out of the shells it spawns by opting out with `service register --no-frontend-creds` (sets `frontend_consumer:false`).)
- Every Eve HTTP request and WS upgrade carries `Authorization: Bearer <token>`, so relay's frontend bearer middleware (`../relay/frontend_server.go`) rejects unauthenticated upgrades **before** protocol-switching — no half-open session allocation.
- relay strips Eve's token and injects each downstream service's own internal token before dialing it (`../relay/frontend_dispatcher.go`, `enhanced_services.go`), so the Eve↔relay and relay↔service hops never share a credential. relayLLM's own internal socket+bearer is `../relayLLM/auth.go` + `main.go` (`RELAY_LLM_SOCKET`/`RELAY_LLM_TOKEN` — relay's channel to relayLLM, distinct from Eve's frontend channel).
- The frontend channel is separate from the MCP bridge channel (`RELAY_BRIDGE_SOCKET`, authenticated with `RELAY_SERVICE_TOKEN` / project-scoped `RELAY_PROJECT_TOKEN`): distinct sockets, distinct tokens, contained blast radius.

**`relay-transport.js`** (singleton, DI-injected, replaces the scattered `fetch()` + `new WebSocket()` calls):

- Socket mode: shared `http.Agent({ socketPath })`; WS via `ws`'s `{ agent }` option; URL is a dummy that the agent routes to the socket.
- TCP mode: `https.Agent({ ca, rejectUnauthorized: true })`, reading an optional CA bundle from `RELAY_FRONTEND_CA`. There is **no** skip-verify option.
- `fetch()` for JSON, `fetchRaw()` for binary (generated images); `createWebSocket()` for the relay bridge.
- `assertStartupConfig()` hard-fails the process if: socket mode without a token; `RELAY_FRONTEND_URL` off-loopback without a token; or `RELAY_FRONTEND_URL` off-loopback over plain `http://`. The one tolerated case is loopback TCP with no token (dev convenience, loud warning). No silent HTTPS→HTTP downgrade.

`RelayClient` stays per-browser-connection (per-connection state: suppress-join, voice mode, TTS accumulation). `RelayTransport` is the singleton, constructed once in `server.js` and handed to each `RelayClient`. This separates per-connection state from shared transport config.

**TTS / STT daemons.** Hard-pinned to `127.0.0.1`; the `TTS_HOST`/`STT_HOST` overrides were removed (only `TTS_PORT`/`STT_PORT` remain). The remote-host flexibility had no consumer and was a footgun.

---

## Section C — Eve's own listener hardening

These make Section A's guarantees hold against the old `DUAL_LISTEN` escape hatch:

1. **`DUAL_LISTEN` HTTP binds `127.0.0.1`.** Same-machine curl access without exposing plaintext to the LAN.
2. **Off-loopback plaintext is opt-in.** With no `HTTPS_KEY`/`HTTPS_CERT`, Eve binds loopback only and warns. `EVE_ALLOW_PLAINTEXT_REMOTE=1` is the explicit, per-deployment opt-in to bind all interfaces over plain HTTP (with a loud warning).
3. **`/api/auth/status` is left reachable** — it must bootstrap the UI; attackers can fingerprint Eve by other means.

---

## Design principles

- **Fail-closed at boundaries.** `assertStartupConfig()` + `EVE_DISABLE_SUBNET_BYPASS` are explicit hard-fail knobs. No silent HTTPS→HTTP downgrade, no silent token-requirement bypass, no implicit trust of request headers.
- **SRP.** `AuthService` (WebAuthn + sessions), `TrustedNetworkService` (IP trust), `RelayTransport` (backend channel) each own one responsibility.
- **DRY.** Four backend call sites collapse to one `RelayTransport`; duplicate "is this localhost" logic is gone; `getClientIp` lives once in `trusted-network.js`.
- **No new runtime deps.** Node stdlib (`os`, `net`, `http`, `https`, `crypto`) plus the existing `ws` package, which already supports `{ agent }` / `{ headers }`.
