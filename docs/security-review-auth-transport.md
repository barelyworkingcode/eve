# Security Review: Auth Bypass & Eve↔Backend Transport

Design record for Eve's two trust boundaries — browser↔Eve and Eve↔relay.
Operator reference (env vars, transport modes, troubleshooting):
[authentication.md](authentication.md). Browser-boundary invariants:
[security-audit-frontend.md](security-audit-frontend.md).

## Section A — subnet-gated auth bypass

Trust must be computed from `req.socket.remoteAddress` only — never
`req.headers.host` or `X-Forwarded-For`, both attacker-set off-loopback (see
[learned.md](learned.md) "Never use `req.headers.host` for authorization" for
the failure mode this replaced). `TrustedNetworkService.isTrusted(req)` is the
one place that computation happens; a route handler must call it rather than
inlining an IP/hostname check.

`ws-handler.js`'s WS-upgrade auth requirement is `isEnrolled() && EVE_NO_AUTH
!== '1' && !isTrusted(req)` — three independent conditions, not one. Dropping
any of them changes behavior: no credentials enrolled yet, the explicit
CI/dev kill switch, and the IP-based bypass are different reasons a
connection can skip the passkey check, and only the last one is
subnet-scoped. `EVE_DISABLE_SUBNET_BYPASS=1` forces the third to `false`
without touching the other two.

## Section B — Eve ↔ relay frontend transport

`RelayTransport` is the single egress point for Eve→relay traffic; no other
module opens a raw `fetch()`/`WebSocket` to relay (voice is the one
exception — see `tts-service.js`/`stt-service.js` in [CLAUDE.md](../CLAUDE.md),
a separate, unauthenticated loopback-only channel to the local TTS/STT
daemons, not to relay).

Eve dials **relay**, never relayLLM/relayScheduler directly, because relay is
where per-project policy relayLLM can't see (e.g. the `allowed_models`
allowlist) is enforced in-path, and because it lets Eve hold exactly one
credential regardless of how many backends sit behind relay — dialing
backends directly would mean N credentials and no policy chokepoint.

Socket mode (`RELAY_FRONTEND_SOCKET` set) is preferred: the Unix socket's
kernel-enforced `0600` permission is the actual authorization boundary; the
bearer token on top is defense in depth, not the primary one. TCP mode
(`RELAY_FRONTEND_URL`) exists only for a split-host deployment and hard-fails
at `assertStartupConfig()` on any off-loopback plaintext URL —
`rejectUnauthorized: true` is not configurable, so there is no skip-verify
escape to (re)introduce. The one deliberately-tolerated soft spot is loopback
TCP with no token, which warns instead of refusing, for local dev; anything
off-loopback with no token still hard-fails at startup, not at first request.
