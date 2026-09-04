# Front-End Security Invariants — Browser ↔ Eve trust boundary

Scope: browser ↔ Eve (HTTP routes, WebSocket protocol, auth, file serving).
Eve ↔ relay/relayLLM is a separate boundary — see
[security-review-auth-transport.md](security-review-auth-transport.md).

Source comments across the codebase cite the IDs below. Each names a
constraint that looks safe to relax and isn't — read the one named before
touching the guard it points at.

## C1 — the WS-upgrade Origin gate is not redundant with the session token

WebSocket upgrades aren't subject to same-origin policy or CORS the way
`fetch` is — any page a victim's browser visits can open a WS connection to
Eve. The WS protocol reaches file read/write/delete and terminal
create/input, so an Origin check on the upgrade is a separate, necessary gate,
not belt-and-suspenders on top of the token.

## C2 — the default trusted-subnet bypass intentionally trusts the whole NIC subnet

Tightening the default to loopback-only would break local dev and Chrome
browser automation, which rely on the same-LAN bypass — so the wide default
is deliberate, not an oversight, and "just default to loopback" is the wrong
fix. What must not regress: trust is computed from `req.socket.remoteAddress`
only, never `req.headers.host` or `X-Forwarded-For` — either is
attacker-set off-loopback. Because the default can include a provider-shared
public range on an internet-facing host, the startup warning for that case
must stay loud; don't quiet it to `debug`.

## C3 — the app-shell CSP script-src has no `'unsafe-inline'`

The two inline bootstrap scripts in `index.html` are allowed only by exact
SHA-256 hash. Adding a third inline script without adding its hash breaks the
page at load; the fix is to add the hash, never to add `'unsafe-inline'` —
that reopens the exact injection class the CSP exists to close. Module
iframes and `/auth/safari-login` are deliberately outside this CSP — they
have their own isolation model (opaque origin / standalone page) and must not
be folded into the app-shell policy.

## H1 — path containment must be separator-aware

A plain `resolved.startsWith(projectPath)` containment check passes for a
sibling directory that merely shares a prefix (`/home/u/proj` matches
`/home/u/proj-secrets`) — `path.resolve` will happily hand back a path
outside the project that still starts with the right string. Any new
path-validation code must use the existing separator-aware helper —
`file-service.js`'s `isPathWithin()` (also reachable as its alias
`_isWithin`; `routes/index.js` calls it as `fileService.isPathWithin()`) —
rather than a bare `startsWith`.

## M1 — WebAuthn origin pinning and RP-ID pinning are not the same risk

`req.get('host')` is attacker-controllable, so the expected **origin** must
come from `EVE_PUBLIC_ORIGIN` for an internet-facing deployment. RP-ID is
lower risk by construction — login prefers the RP-ID recorded at enrollment
over any freshly-derived value, and an authenticator won't sign for a
mismatched RP anyway — so don't over-fix by forcing RP-ID through the same
pin; only origin needs it.

## M2 — plaintext HTTP has no default non-loopback bind

Binding to a non-loopback address without TLS puts the bearer session token
on the wire in cleartext to whatever network reaches that address. The
default bind is loopback-only; reaching wider than that needs an explicit
env var — `EVE_ALLOW_PLAINTEXT_REMOTE=1` (all interfaces) or `EVE_BIND_HOST`
(a specific address, e.g. a WireGuard interface IP, documented in
[authentication.md](authentication.md)) — never an inferred default. Don't
add a third path that reaches a non-loopback bind without going through one
of these two.

The startup warning keys on the address actually bound (`isLoopbackHost`),
not on `EVE_ALLOW_PLAINTEXT_REMOTE`. Testing the flag instead looks
equivalent and is not: `EVE_BIND_HOST` leaves loopback without setting the
flag, so a flag-keyed check reports that bind as "loopback only" and hides
the exposure.

## M3 — `descriptor.expensive` is the sole source of rate-limit truth

The per-connection cap on costly WS operations (search, transcription, TTS,
AI invocation) is driven entirely by each message descriptor's own
`expensive: true` flag — there is no second, separately-maintained list of
gated types. A new expensive operation that omits the flag is unlimited by
construction; that's the one place to check when adding one.
