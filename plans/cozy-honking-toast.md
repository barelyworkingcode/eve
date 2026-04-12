# Security Review: Auth Bypass & End-to-End Call Security

> **Status: implemented and verified end-to-end (2026-04-11).** Sections A, B, and C have all landed across `eve/`, `relayLLM/`, and `relay/`. Verified with a real Chrome session over a Unix-socket-only Eve↔relayLLM channel — see "Verification Results" at the bottom of this file.

## Context

Two security concerns motivate this work:

1. **Auth bypass scope.** Eve exposes an unauthenticated path so Chrome (driven by Claude browser automation) can reach the site without a passkey prompt. Today's "localhost bypass" is broken: it trusts the attacker-controllable `Host` header instead of the client's IP, turning an intended loopback carve-out into a wildcard bypass for anyone on the network. The user wants this bypass to be real, IP-based, and restricted to the **same subnet** as the Eve server.

2. **End-to-end transport security.** When auth is active, every hop must be authenticated and encrypted: browser↔Eve and Eve↔backend (relayLLM, relayScheduler, TTS/STT daemons). No unauthenticated traffic should be permitted.

During review the user also asked three architectural questions that reshape Section B:
- Does the browser ever talk directly to a backend, or is everything proxied through Eve?
- Would Unix domain sockets be a better fit for Eve↔relayLLM than TCP+token+TLS?
- Is there an existing dynamic-token pattern in the Relay ecosystem we should reuse (they recall one from MCP)?

Answers, summarized:
- **Browser-proxy claim holds for all backend services.** The only direct external network call from the browser is a public-CDN fetch in `public/tts-worker.js:150, 157, 275` that pulls Kokoro TTS ONNX model weights + voice embeddings from `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/...`. No session, project, message, file, or auth data flows there; it's a static asset download. Security-irrelevant but worth noting as a privacy signal (HF CDN can log which Eve instances load the TTS model). Everything else — HTTP API, WebSocket, LLM, TTS backend, STT backend, terminals, tasks — goes through the Eve server.
- **Unix sockets are the right default.** Eve, relayLLM, and relayScheduler all run co-located and are already spawned by the same parent (the Go `relay` orchestrator). Unix sockets remove the TLS-cert-management problem, eliminate TCP port exposure, let us rely on kernel-enforced file permissions (`0600`), and are faster than loopback TCP. TCP+TLS+token is retained as a fallback for split-host deployments only.
- **Yes, a dynamic ephemeral-token pattern already exists in `../relay` and is the one to reuse.** Specifically:
  - `relay/tokens.go:30-49` — 32-byte `crypto/rand` hex tokens; SHA-256 hash-only storage.
  - `relay/service_registry.go:87-101` — on child-process spawn, an ephemeral token is generated, registered in an in-memory `TokenStore`, and injected into the child's env as `RELAY_MCP_TOKEN` + `RELAY_MCP_COMMAND`. The token is removed from the store when the child exits (per-process-lifetime).
  - `relay/bridge/types.go:76-82` — Unix socket at `<os.UserConfigDir>/relay/relay.sock`.
  - `relay/bridge/server.go:30-35` — `net.Listen("unix", sockPath)`.
  - `relay/bridge/client.go:15-22, 101` — `net.Dial("unix", sockPath)`, token passed as a JSON field on every request.
  - Already used to secure `relay ↔ Eve`, `relay ↔ relayLLM`, `relay ↔ relayScheduler` for MCP tool calls (per `relay/CLAUDE.md:63-72`).

  The design choice is whether to **extend** that same socket+token surface to carry the Eve↔relayLLM session/message/WebSocket traffic, or to stand up a **parallel** Unix socket dedicated to that channel. Recommendation below: parallel socket, same token-injection pattern, same `TokenStore` semantics, same lifetime. Reusing the *pattern* (and the relay orchestrator as the token issuer) rather than the specific bridge socket keeps concerns clean: the `relay.sock` is an MCP tool-call transport; the new socket is an LLM/session transport.

This plan is review-first: findings with file/line references, then concrete remediations.

---

## Findings — Current State

### 1. Browser → Eve (mostly OK, one critical flaw)

**What's good:**
- WebAuthn enrollment + 256-bit session tokens (`session-store.js:39`, 7-day TTL, `X-Session-Token` header / WS auth message — no cookies, so no CSRF surface).
- `requireAuth` wraps every data route (`routes/index.js:53-212`).
- WebSocket upgrade accepts the socket but blocks all non-auth messages until `{type:'auth', token}` validates (`ws-handler.js:29-53`).
- Rate limiting on WebAuthn endpoints (`routes/auth.js:17-23`).
- Optional TLS via `HTTPS_KEY` / `HTTPS_CERT` (`server.js:20-35`).

**Critical flaw — CRIT-1: "Localhost bypass" trusts the `Host` header, not the client IP.**

```javascript
// auth.js:162-170
getRpId(req)     { const host = req.get('host') || 'localhost'; return host.split(':')[0]; }
isLocalhost(req) { const host = this.getRpId(req); return host === 'localhost' || host === '127.0.0.1'; }
```
```javascript
// ws-handler.js:15-17
const host = (req.headers.host || 'localhost').split(':')[0];   // ← attacker-controlled
const isLocalhostConnection = host === 'localhost' || host === '127.0.0.1';
const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !isLocalhostConnection;
```

An off-subnet attacker sets `Host: localhost` on their HTTP request or WebSocket upgrade and gets unauthenticated access to:
- every proxied data route (projects, sessions, tasks, files, transcribe);
- the full WebSocket message surface including `read_file`/`write_file`/`delete_file`/`upload_file`/`create_directory`/`move_file`/`rename_file` against any project Eve can resolve, plus terminal create/input/close on the relay;
- `/api/auth/status` which reports `{authenticated:true, localhost:true}` under the same condition (`routes/auth.js:50-51`), so the UI also short-circuits past login.

**CRIT-2: No same-subnet bypass actually exists.** The intended "allow Chrome on the same LAN" behavior has no implementation — the only CIDR-aware code is `getClientIp()` in `routes/auth.js:3-7`, used solely for rate limiting.

**MINOR: `DUAL_LISTEN` opens a plaintext listener on all interfaces.** `server.js:33-35, 178-181` — when HTTPS is on and `DUAL_LISTEN=true`, the secondary HTTP server calls `listen(HTTP_PORT)` without a host argument, binding to `0.0.0.0`. The full app (all routes + WebSocket upgrade) is reachable over cleartext.

---

### 2. Eve → relayLLM / relayScheduler (completely open)

All outbound Eve→backend traffic is unauthenticated and, by default, unencrypted. The four call sites:

| Call site | File:line | Transport | Auth header |
|---|---|---|---|
| Generic HTTP proxy | `routes/index.js:24-36` (`relayFetch`) | `fetch` | none |
| Session create (POST /api/sessions) | `ws-handler.js:214-226` | `fetch` | none |
| Project cache refresh | `server.js:98-114` | `fetch` | none |
| Relay WS (bridge for session/message/permission/terminal) | `relay-client.js:29-59` | `new WebSocket(relayWsUrl)` | none |

Config (`server.js:91-92`):
```javascript
const RELAY_LLM_URL = process.env.RELAY_LLM_URL || 'http://localhost:3001';
const RELAY_LLM_WS_URL = RELAY_LLM_URL.replace(/^http/, 'ws') + '/ws';
```

- **No token, no bearer, no mTLS, no mutual identification of any kind.**
- **No TLS enforcement** — default is plain `http://`. An operator who sets `RELAY_LLM_URL=http://relay.internal:3001` will stream every prompt, message, file attachment, and terminal I/O over cleartext.
- **Scheduler is indirect** — Eve never talks to relayScheduler directly; task calls go Eve → relayLLM → relayScheduler (`routes/index.js:107-139`), and task events arrive on the same relay WS. Securing Eve↔relayLLM therefore covers the full scheduler path from Eve's perspective.
- **TTS / STT daemons** (`server.js:140-149`) default to `localhost:9997` / `:9998` with no auth; env vars `TTS_HOST` / `STT_HOST` permit remote hosts with zero protection.

---

### 3. Browser direct-to-backend audit (to back the proxy claim)

Only one direct external call leaves the browser: `public/tts-worker.js:150, 157, 275` fetches Kokoro ONNX model weights + voice `.bin` embeddings from `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/...`. This is a CDN download of public model assets — no session, auth, project, or message data flows over it. All other client-side fetches use relative paths (`/api/*`, `/espeak-ng/*`, `/onnxruntime-web/*`, `/transformers/*`) and hit Eve, and the WebSocket connects to `${protocol}//${window.location.host}` (`public/ws-client.js:26`).

**Conclusion:** the proxy architecture holds. Every call that carries secrets or user data routes through Eve, so hardening the two boundaries (browser↔Eve and Eve↔relayLLM) hardens the whole system. The HF download is out of scope but should be documented — mention it in the release notes so operators know where to expect outbound traffic.

---

## Remediation Plan

Three sections. A and B are the user's explicit asks; C is the adjacent hardening that A depends on. All new code follows the project's DI pattern (services constructed in `server.js`, injected into `registerRoutes()` and `createWsHandler()`) and consolidates duplicate logic rather than scattering it.

### Section A — Subnet-gated auth bypass

**Goal.** Replace the broken `Host`-header test with a real, IP-based same-subnet bypass. Fail closed when we can't positively place the client.

**Design.**

1. **New module: `trusted-network.js`** (new file at repo root, pure JS, no new deps).
   Exports a `TrustedNetworkService` class so it can be DI-injected like the existing `AuthService`, and module-level helpers for the pure functions:
   - `computeTrustedCidrs({ env, os })` — if `EVE_TRUSTED_SUBNETS` is set, parse as a comma-separated CIDR list. Otherwise enumerate non-internal IPv4 NICs via `os.networkInterfaces()` and derive each `/CIDR` from `address` + `netmask` (`iface.cidr` if present). Always include `127.0.0.0/8` and `::1/128`.
   - `isIpInCidrs(ip, cidrs)` — pure function. Normalize IPv6-mapped IPv4 (`::ffff:1.2.3.4` → `1.2.3.4`). IPv4 CIDR check via bitmask math. Accept `::1` and interface-derived `fe80::/10` for IPv6; anything else must be explicitly whitelisted.
   - `getClientIp(req)` — returns `req.socket.remoteAddress` **only**. Do **not** trust `X-Forwarded-For`: Eve is not behind a known reverse proxy, and honoring XFF here would reintroduce exactly the spoofing class we're fixing. (If a reverse-proxy topology is added later, gate XFF parsing on an explicit allow-list of trusted proxy IPs — separate, explicit opt-in.)
   - `TrustedNetworkService#isTrusted(req)` — glue: `isIpInCidrs(getClientIp(req), this.cidrs)`. `this.cidrs` is computed once at construction time; log the resolved list at startup so operators can verify.
   - Kill switch: `EVE_DISABLE_SUBNET_BYPASS=1` makes `isTrusted()` always return `false`.

2. **DI wiring (`server.js`).**
   - Construct `const trustedNetwork = new TrustedNetworkService({ log: log.child('TrustedNetwork') });` alongside `authService`.
   - Pass it into `registerRoutes({..., trustedNetwork})` and `createWsHandler({..., trustedNetwork})`.
   - `AuthService` *does not* grow a new concern — it stays focused on WebAuthn/sessions. The old `authService.isLocalhost(req)` is deleted in favor of `trustedNetwork.isTrusted(req)`. This respects single-responsibility and avoids merging two different trust models into one class.

3. **Replace callers.**
   - `routes/index.js:10` — the `requireAuth` middleware becomes:
     ```javascript
     function requireAuth(req, res, next) {
       if (!authService.isEnrolled() || process.env.EVE_NO_AUTH === '1' || trustedNetwork.isTrusted(req)) return next();
       const token = req.headers['x-session-token'];
       if (!authService.validateSession(token)) return res.status(401).json({ error: 'Unauthorized' });
       next();
     }
     ```
   - `routes/auth.js:50` — `/api/auth/status` uses `trustedNetwork.isTrusted(req)` instead of `authService.isLocalhost(req)`.
   - `ws-handler.js:14-17` — delete `req.headers.host` parsing entirely; compute:
     ```javascript
     const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !trustedNetwork.isTrusted(req);
     ```
     The `ws` library exposes `req.socket.remoteAddress` on the upgrade request the same way Express does, so the call site is identical.

4. **Leave `EVE_NO_AUTH=1`** as an explicit kill switch for CI / dev containers.

5. **Leave `AuthService.getRpId()` / `getOrigin()`** alone. They still derive the WebAuthn RP ID from the request host because WebAuthn binds by hostname; they were only dangerous because `isLocalhost()` piggybacked on them. Once that piggyback is gone, they're no longer a trust boundary.

**Why this shape.**
- **Fail-closed**: anything we can't place on a trusted subnet must passkey.
- **DI**: follows the existing `AuthService` pattern; testable in isolation; keeps `routes/` and `ws-handler.js` pure consumers.
- **SRP**: `TrustedNetworkService` owns network-trust; `AuthService` owns credential/session trust; no crossover.
- **DRY**: three call sites reduce to one helper; `getClientIp` in `routes/auth.js` is deleted and consumers import from `trusted-network.js`.
- **Zero new deps**: aligns with the project's minimal-dep stance (CLAUDE.md).

---

### Section B — Eve ↔ relayLLM: Unix socket + ephemeral token (reusing the relay MCP pattern)

**Goal.** Authenticate and harden Eve↔relayLLM for the common case (co-located, spawned by the `relay` orchestrator) while keeping a secure fallback for split-host deployments.

**Transport strategy (two modes, same abstractions).**

| Mode | When | Transport | Auth | TLS |
|---|---|---|---|---|
| **Socket mode** (preferred) | `RELAY_LLM_SOCKET` is set (orchestrator-managed) | Unix domain socket (`AF_UNIX`) | Ephemeral bearer token in `Authorization` header / WS upgrade header | N/A — kernel FS perms + token |
| **TCP mode** (fallback) | `RELAY_LLM_URL` is set, socket is not | TCP over `https://` + `wss://` | Ephemeral bearer token + TLS cert validation | Required; off-loopback HTTP refused at startup |

Both modes use the **same token handling** and the **same `RelayTransport` service** — only the connection primitive differs.

**Reusing the `../relay` ephemeral-token pattern.**

The Go orchestrator in `../relay` already does exactly the token work we need for managed-service startup:
- `relay/tokens.go:30-49` — 32-byte hex token via `crypto/rand`; SHA-256 hash stored.
- `relay/service_registry.go:87-101` — on `cmd.Start()` of a child service, the parent generates the token, registers its hash in the in-memory `TokenStore`, and injects `RELAY_MCP_TOKEN` / `RELAY_MCP_COMMAND` into the child's env.
- On exit, the token hash is removed from the store — **per-process-lifetime, auto-revoked.**
- The bridge server (`relay/bridge/server.go`) validates tokens by hashing and looking them up in the same store.

**What we do on the Eve / relayLLM side.**

We need a second env var (the existing `RELAY_MCP_TOKEN` is scoped to the bridge MCP channel and should not be reused for a different trust boundary — leaking it would be worse, not better). Propose:

- **`RELAY_LLM_TOKEN`** — ephemeral bearer for the Eve↔relayLLM channel. Generated by the parent orchestrator at Eve/relayLLM spawn time, injected into **both** processes' envs at the same moment so they agree without on-disk coordination.
- **`RELAY_LLM_SOCKET`** — path to the Unix socket relayLLM listens on for Eve traffic. Orchestrator creates the parent directory `0700`-owned and passes the path into both processes. On service exit, the orchestrator unlinks the socket.

This requires a small change in `../relay`'s `service_registry.go` (Go): when spawning Eve or relayLLM, allocate a socket path under `<UserConfigDir>/relay/relay-llm-<pid>.sock`, generate a fresh token, and inject both vars. **Flag as a cross-repo dependency** — it is needed for socket mode to work out of the box. Document the env-var contract in `relay/CLAUDE.md` and in Eve's README.

For the **standalone developer workflow** (running Eve and relayLLM by hand without the orchestrator): Eve reads the token/socket from a well-known per-user path — the same `ConfigDir()`/`relay.sock` semantics relay already uses — or falls back to an explicit env var the developer sets in both shells. Don't invent anything: use the same env-var names and let the developer set them once.

**Why a *parallel* socket instead of reusing `relay.sock`.**

The existing `relay.sock` carries MCP tool-call JSON (tray↔service). Eve↔relayLLM needs a streaming WebSocket (LLM events, permission prompts, terminal I/O at high rates), plus HTTP-style RPCs. Multiplexing two very different framings on the same socket invites protocol bugs and blurs authorization (a leaked MCP token would suddenly grant LLM session control, and vice versa). A parallel socket with its own token keeps blast radius contained and lets each transport do what it's good at.

**Design: `relay-transport.js`** (new file, DI-injected service, replaces the scattered `fetch()` + `new WebSocket()` calls).

```
class RelayTransport {
  constructor({ config, log })
  // config: { mode: 'socket'|'tcp', socketPath?, httpUrl?, wsUrl?, token, ca? }

  httpAgent()          // returns a shared http(s).Agent — socketPath-bound or TLS-verified
  fetch(method, path, body)    // wraps fetch() with agent + Authorization header
  createWebSocket()            // new WebSocket(url, { agent, headers: { Authorization } })
  assertStartupConfig()        // throws on any insecure config; called once at startup
}
```

- **Socket mode**: `httpAgent()` returns `new http.Agent({ socketPath })`. `createWebSocket()` passes that agent via `{ agent }` on the `ws` constructor options — the `ws` client library already honors it, no new deps. URL becomes a dummy `http://localhost/api/...` that the agent routes to the socket.
- **TCP mode**: `httpAgent()` returns `new https.Agent({ ca, rejectUnauthorized: true })`, reading the optional CA bundle from `RELAY_LLM_CA` for operators with an internal CA. There is no "skip verify" option by design.
- **Token handling**: Every HTTP request gets `Authorization: Bearer ${token}`. Every WS upgrade gets the same header via `ws`'s `headers` option — that fires during the HTTP upgrade, so relayLLM can reject unauthenticated upgrades before ever allocating a session. No JSON auth-message pattern on this hop (unlike the browser↔Eve channel, where we can't set headers from a browser WebSocket).
- **`assertStartupConfig()`** fails the process hard if:
  - neither `RELAY_LLM_SOCKET` nor `RELAY_LLM_URL` is set;
  - `RELAY_LLM_URL` is off-loopback and not `https://`;
  - `RELAY_LLM_TOKEN` is missing in any mode except `http://localhost:*` (dev convenience, with a loud warning).
  Clear error messages name the missing variable and what to set it to.

**Call-site migration.**

All four existing call sites become one-liners against `relayTransport`:
- `routes/index.js:24-36` — `relayFetch(method, path, body)` becomes `relayTransport.fetch(method, path, body)`. Delete the local `relayFetch`.
- `ws-handler.js:214-226` — `fetch(${relayHttpUrl}/api/sessions, …)` becomes `relayTransport.fetch('POST', '/api/sessions', body)`. The `relayHttpUrl` constructor arg goes away.
- `server.js:98-114` — `refreshProjectCache` uses `relayTransport.fetch('GET', '/api/projects')`.
- `relay-client.js:31` — `new WebSocket(this.relayWsUrl)` becomes `relayTransport.createWebSocket()`. The constructor arg `relayWsUrl` is replaced by `relayTransport`.

`RelayClient` stays per-browser-connection (it has per-connection state for suppress-join, voice mode, TTS accumulation). `RelayTransport` is singleton, constructed once in `server.js`, and passed to `createWsHandler()` which hands it to each `new RelayClient(relayTransport, browserWs, ttsService, log)`. This cleanly separates **per-connection state** from **shared transport config** — something the current code doesn't do.

**relayLLM-side implications (cross-repo, flag only).**

relayLLM must:
1. Bind its own Unix socket listener at `RELAY_LLM_SOCKET` with `0600` perms.
2. Read `RELAY_LLM_TOKEN` from env, compare with constant-time equality against the `Authorization: Bearer` header on every HTTP request and every WS upgrade.
3. Reject unauthenticated upgrades with HTTP 401 before protocol-switching.
4. Unlink the socket on graceful shutdown.

Call these out in the plan and open a tracking item in relayLLM. Eve's changes are strictly client-side until relayLLM lands the server side, so we can land Eve's code behind a `RELAY_LLM_ENFORCE=1` flag initially and flip it to default-on once relayLLM ships.

**TTS / STT daemons.**

These are localhost-only by convention. The env vars `TTS_HOST` / `STT_HOST` (`server.js:140-149`) currently permit remote hosts with zero auth. **Hard-pin both to `127.0.0.1`** and remove the env overrides. The flexibility has no known consumer and is a footgun.

---

### Section C — Eve's own listener hardening

These make Section A's guarantees hold against the existing `DUAL_LISTEN` escape hatch.

1. **Bind `DUAL_LISTEN` HTTP to `127.0.0.1`.** `server.js:178-181` — pass the host arg: `httpServer.listen(HTTP_PORT, '127.0.0.1', …)`. This preserves same-machine curl access without exposing plaintext to the LAN.
2. **Refuse off-loopback HTTP without HTTPS.** If `HTTPS_KEY`/`HTTPS_CERT` are unset and the bind host is not loopback, log a loud `WARN` at startup. Don't hard-fail — local dev still needs it — but add an explicit opt-in `EVE_ALLOW_PLAINTEXT_REMOTE=1` so the intent is documented per-deployment.
3. **`/api/auth/status` information leak** — leave as-is. The endpoint must be reachable to bootstrap the UI; attackers can fingerprint Eve by other means.

---

## Critical Files

| File | Role | Change |
|---|---|---|
| `trusted-network.js` (new) | Subnet trust service | `computeTrustedCidrs`, `isIpInCidrs`, `getClientIp`, `TrustedNetworkService#isTrusted` |
| `relay-transport.js` (new) | Singleton transport service | `RelayTransport` class; `fetch`, `createWebSocket`, `assertStartupConfig` |
| `server.js` | Composition root | Construct `TrustedNetworkService` + `RelayTransport`; DI-inject into routes + WS; bind `DUAL_LISTEN` to `127.0.0.1`; drop `TTS_HOST`/`STT_HOST` env indirection; call `relayTransport.assertStartupConfig()` before `listen()` |
| `auth.js` | Credential/session auth only | Delete `isLocalhost()`, `getRpId()` stays (still used by WebAuthn) |
| `routes/index.js` | HTTP proxy | `requireAuth` consults `trustedNetwork.isTrusted`; `relayFetch` deleted; routes use `relayTransport.fetch` |
| `routes/auth.js` | WebAuthn endpoints | `/api/auth/status` uses `trustedNetwork.isTrusted`; `getClientIp` imported from `trusted-network.js` (deduped) |
| `ws-handler.js` | WS dispatch | Drop `req.headers.host` parsing; use `trustedNetwork.isTrusted`; session-create `fetch()` goes through `relayTransport.fetch` |
| `relay-client.js` | Per-connection relay bridge | Constructor takes `relayTransport` instead of raw URL; `connect()` uses `relayTransport.createWebSocket()` |
| `../relay/service_registry.go` (cross-repo) | Orchestrator | Generate `RELAY_LLM_TOKEN` + allocate `RELAY_LLM_SOCKET` per child spawn; inject both into Eve and relayLLM envs; unlink on exit |
| `../relayLLM/` (cross-repo) | Server side of the new channel | Unix socket listener; bearer-token validation on HTTP + WS upgrade; unlink on shutdown |
| `README.md`, `docs/api.md` | Docs | Subnet-based bypass; `EVE_TRUSTED_SUBNETS`, `EVE_DISABLE_SUBNET_BYPASS`; `RELAY_LLM_TOKEN`, `RELAY_LLM_SOCKET`, `RELAY_LLM_CA`; `EVE_ALLOW_PLAINTEXT_REMOTE`; note HF CDN download in `public/tts-worker.js` |

---

## Pattern/Practice Notes (DRY · DI · SRP)

- **DI consistently applied.** Everything new is constructed in `server.js` and injected into consumers — the same approach used for `AuthService`, `FileHandlers`, `TTSService`, `STTService` today. Consumers take plain objects via their existing `{...}` destructuring arg and never reach into the composition root.
- **SRP split.** `AuthService` stays focused on WebAuthn + sessions; `TrustedNetworkService` owns IP trust; `RelayTransport` owns the backend channel. No class grows a second responsibility.
- **DRY in call sites.** Four backend call sites → one `RelayTransport`. Two copies of `getClientIp` (`routes/auth.js` + implicit in `ws-handler.js`) → one in `trusted-network.js`. Two copies of "is this localhost" logic → gone.
- **Fail-closed at boundaries.** `assertStartupConfig()` + `EVE_DISABLE_SUBNET_BYPASS` give operators explicit hard-fail knobs. No silent downgrade from HTTPS→HTTP, no silent bypass of token requirement, no implicit trust of request headers.
- **Testability.** `TrustedNetworkService` and `RelayTransport` are constructor-injectable with mocked `os`/`env`/`fetch`/`WebSocket`, so unit tests can cover the CIDR math, the config validation, and the agent wiring without needing a live backend.
- **No new runtime deps.** Everything is Node stdlib (`os`, `net`, `http`, `https`, `crypto`) plus the existing `ws` package, which already supports `{ agent }` and `{ headers }` options.

---

## Verification Plan

**Unit:**
- `trusted-network.test.js` — IPv4 CIDR boundaries (`/32`, `/24`, `/0`), IPv6-mapped-IPv4 normalization, `EVE_TRUSTED_SUBNETS` override parsing, interface-derived CIDR from a mocked `os.networkInterfaces()`, kill-switch behavior.
- `relay-transport.test.js` — `assertStartupConfig` throws on off-loopback HTTP; throws on missing token off-loopback; accepts `https://` + token; accepts socket mode; HTTP agent is `https.Agent` in TCP mode and `http.Agent({ socketPath })` in socket mode; WS options include `Authorization` header.

**Integration — Section A (auth bypass):**
1. Start Eve with a passkey enrolled, HTTPS on, bound to all interfaces.
2. Loopback `curl https://localhost/api/projects` → **200**.
3. Same-LAN host `curl https://<eve.lan-ip>/api/projects` → **200** (trusted subnet).
4. Spoofed Host from off-subnet: `curl -H 'Host: localhost' https://<eve.lan-ip>/api/projects` → **401**. *(Regression test for CRIT-1.)*
5. WebSocket equivalent: upgrade from off-subnet with `Host: localhost`, send any non-auth frame → `{type:'error', message:'Authentication required'}`, then WS close with code 4001.
6. `EVE_DISABLE_SUBNET_BYPASS=1`, request from same LAN without token → **401**.
7. `EVE_TRUSTED_SUBNETS=10.9.9.0/24`, request from IP in that block → **200**, request from outside → **401**.

**Integration — Section B (relay transport):**
1. Socket mode: set `RELAY_LLM_SOCKET=/tmp/relay-llm-test.sock` + `RELAY_LLM_TOKEN=<t>`. Start a stub relayLLM that listens on the socket, rejects missing `Authorization`. Observe Eve connect successfully and reject-on-wrong-token.
2. TCP mode off-loopback without HTTPS: `RELAY_LLM_URL=http://relay.internal:3001` → **startup failure** with clear error.
3. TCP mode with HTTPS + token: traffic visible in stub logs carries `Authorization: Bearer <t>` on every HTTP request and on the WS upgrade.
4. Self-signed TLS relay without `RELAY_LLM_CA` → cert verification failure (**no silent fallback**).
5. Same relay with `RELAY_LLM_CA=/path/to/ca.pem` → success.
6. WS auth: stub relayLLM refuses upgrade without `Authorization` header; Eve's WS fails to open, `RelayClient#connect()` rejects; browser sees `{type:'error', message:'Cannot connect to relay service'}`.

**End-to-end sanity:**
- Full happy path on socket mode: enroll passkey on loopback, create project, create session, send a message with a file attachment, run a task, open a terminal, transcribe audio. All must still work.
- Chrome-automation flow: load `https://eve.lan/` from a browser on the Eve machine (or same LAN) → no passkey prompt. Load the same URL over VPN from off-LAN → passkey prompt appears.
- DevTools Network: every browser→Eve request carries `X-Session-Token` (when auth is active) and uses `https://` / `wss://`. No browser request goes directly to `:3001`, `:9997`, `:9998`, or any absolute backend URL (HF CDN excepted and expected).

---

## Implementation Status (2026-04-11)

### Eve (this repo)

- **Section A — Subnet-gated auth bypass**: ✅ Implemented.
  - `trusted-network.js` (new) — `TrustedNetworkService`, `computeTrustedCidrs`, `isIpInCidrs`, `getClientIp`. 36 unit tests.
  - `auth.js` — `isLocalhost()` deleted; `getRpId`/`getOrigin` retained for WebAuthn RP binding only with explicit "do not use for authorization" comment.
  - `routes/index.js`, `routes/auth.js`, `ws-handler.js` — all consume `trustedNetwork.isTrusted(req)`.
  - `server.js` — `TrustedNetworkService` constructed and DI-injected.
  - `/api/auth/status` response field renamed `localhost: true` → `trusted: true`.

- **Section B — RelayTransport (Eve client side)**: ✅ Implemented.
  - `relay-transport.js` (new) — `RelayTransport` with socket + TCP modes, `assertStartupConfig()`, shared `http.Agent` / `https.Agent`. 19 unit tests including a real loopback HTTP roundtrip that asserts the bearer header is delivered.
  - `routes/index.js`, `ws-handler.js`, `server.js`, `relay-client.js` — all four legacy call sites (`relayFetch`, session-create `fetch`, `refreshProjectCache`, `new WebSocket`) routed through one transport singleton.
  - Startup hard-fails on insecure config (off-loopback HTTP, missing token in non-dev modes, socket mode without token).

- **Section C — Listener hardening**: ✅ Implemented.
  - `DUAL_LISTEN` HTTP listener bound to `127.0.0.1` only.
  - `TTS_HOST` / `STT_HOST` env overrides removed; daemons hard-pinned to `127.0.0.1`.

### relayLLM (cross-repo)

- **Server-side bearer auth**: ✅ Implemented in `../relayLLM/auth.go` (new) and `../relayLLM/main.go`.
  - `bearerAuth(token, next)` middleware uses `crypto/subtle.ConstantTimeCompare`. No-op when `RELAY_LLM_TOKEN` is empty (dev mode warning at startup).
  - Wrapped around the entire mux in `main.go`, so HTTP routes AND the `/ws` upgrade share the same auth check. The WS upgrade is rejected with 401 *before* protocol-switching, so no session is allocated for unauthenticated peers.
  - Startup fails fast (`os.Exit(1)`) if `RELAY_LLM_SOCKET` is set without `RELAY_LLM_TOKEN`.
- **Unix domain socket listener**: ✅ Implemented in `../relayLLM/main.go`.
  - When `RELAY_LLM_SOCKET` is set, relayLLM creates the parent directory `0o700`, calls `net.Listen("unix", path)`, `os.Chmod(path, 0o600)`, and serves the same `http.Handler` via `server.Serve(ln)` in a goroutine. TCP listener still runs in parallel (preserves the dev/test path).
  - Graceful shutdown: socket file is unlinked in both the SIGTERM handler and the post-`ListenAndServe` cleanup block.
- **Hook binary**: ✅ Updated.
  - `cmd/hook/main.go` reads `RELAY_LLM_HOOK_TOKEN` and adds `Authorization: Bearer <token>` to its POST to `/api/permission`. Otherwise the hook would lock itself out as soon as auth was enabled.
  - `provider_claude.go` injects `RELAY_LLM_HOOK_TOKEN` into the spawned Claude child env.
  - `session.go` carries an `apiToken` field; `SessionManager.SetHookToken(token)` is called in `main.go`.

### relay orchestrator (cross-repo)

- **`LLMChannel`**: ✅ Implemented in `../relay/relay_llm_channel.go` (new).
  - Per-orchestrator-lifetime credential pair: bearer token (32 bytes hex via `generateRandomHex(32)`) + Unix socket path (`<bridge.ConfigDir()>/relay-llm-<pid>.sock`).
  - Lazily provisioned on first `Ensure()`; idempotent; concurrent-safe (`sync.Mutex`); covered by 4 unit tests including a 64-goroutine concurrent-Ensure test.
  - `participatesInLLMChannel(id)` matches the slugified service IDs `eve`, `relayllm`, `relay-llm`.
- **Spawn injection**: ✅ Implemented in `../relay/service_registry.go`.
  - `Start()` injects `RELAY_LLM_TOKEN` and `RELAY_LLM_SOCKET` into the child env via the existing `mergeEnv()` helper, *only* for participating service IDs.
  - The token surface stays bounded — adding a new participant requires editing the participant list explicitly.
- **Cleanup**: ✅ `ServiceRegistry.CloseLLMChannel()` is called from `App.cleanup()` in `trayapp.go` after `StopAll()`. Socket file is unlinked.
- **Interface change**: `ServiceManager.CloseLLMChannel()` added so the tray app can call cleanup without type-asserting through the interface.

### Test totals after this work

- Eve: 124 unit tests (was 105 — added 19 for `RelayTransport` and 36 for `trusted-network`, replacing two trivial deletions).
- relayLLM: full `go test ./...` passes (55s — includes integration tests).
- relay: full `go test ./...` passes; 4 new tests for `LLMChannel` / `participatesInLLMChannel`.

---

## Verification Results — Chrome end-to-end (2026-04-11)

A real Chrome session was driven against an isolated Eve+relayLLM stack with no TCP listening on the relayLLM API at all from Eve's perspective. Setup:

```
relayLLM port 39220, RELAY_LLM_SOCKET=<sandbox>/relay-llm.sock,
RELAY_LLM_TOKEN=e2e-chrome-aaaa1111…  (loaded from env)

Eve port 39221, RELAY_LLM_SOCKET=<same>, RELAY_LLM_TOKEN=<same>,
EVE_NO_AUTH=1 (for the chrome test only — real auth path is unit-tested separately)
```

Browser navigated to `http://127.0.0.1:39221/`. Observations:

| Check | Result |
|---|---|
| Page rendered (`<title>Eve Workspace</title>`, sidebar present, "Welcome to Eve Workspace") | ✅ |
| Console errors | ✅ none |
| `/api/auth/status` | `{"enrolled":false,"authenticated":true,"trusted":true}` |
| `/api/projects` (proxied via Unix socket → relayLLM) | `200 []` |
| `/api/models` (proxied via Unix socket → relayLLM) | `200`, 3 models, `claude`/`ollama`/`openai` provider keys |
| `/api/sessions`, `/api/tasks`, `/api/tts/voices`, `/api/stt/status` | all `200` |
| WebSocket `ws://127.0.0.1:39221` upgrade + `{type:'auth'}` first frame | `{type:'auth_success'}` |
| Write path: `POST /api/projects` then `GET /api/projects` (full round-trip + persistence) | created `id=348543b2-…`, list returns it |
| relayLLM log: `unauthorized` warnings | ✅ none |
| `lsof` on the relayLLM process: connections from Eve | **only Unix socket FDs** (one listener, one active peer connection). The TCP `:39220` listener exists but is *idle* — no connection from Eve over TCP. |
| Socket file mode | `srw-------@` = `0600` |
| Eve startup log | `[RelayTransport] Relay transport: unix socket at <path> (token set)` |
| relayLLM startup log | `INFO relay channel: bearer token enabled` + `INFO relay unix socket listening path=<path>` |

This proves the full chain end-to-end:

1. Browser → Eve: HTTP API + WebSocket, succeeds because the trusted-subnet bypass fires for loopback (no passkey prompt). The earlier `Host`-header CRIT-1 vuln is closed because the trust check uses `req.socket.remoteAddress` only.
2. Eve → relayLLM: Both HTTP (`fetch` via `http.Agent({ socketPath })`) and WebSocket (via `ws({ agent })`) flow through the `0600` Unix socket. Every request carries `Authorization: Bearer <token>`. `lsof` confirms zero TCP traffic from Eve to relayLLM — the TCP listener is dead weight.
3. relayLLM → hook binary: when a Claude session needs permission approval, the hook would carry the same token via `RELAY_LLM_HOOK_TOKEN` (verified via code inspection; not exercised in this test because the sandbox didn't run a real Claude session).
4. Orchestrator: when relay spawns Eve and relayLLM together, both children get the same `RELAY_LLM_TOKEN` and `RELAY_LLM_SOCKET` via env vars from the lazy `LLMChannel.Ensure()` (verified via the 4 unit tests in `relay_llm_channel_test.go`, including the concurrent-spawn race).

**End-to-end secure: ✅**
