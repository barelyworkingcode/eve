# Front-End Security Audit — Browser ↔ Eve trust boundary

**Status: all findings resolved or mitigated** (see status table). This document is
retained as the rationale archive: source files and tests cite these issue IDs in
comments (e.g. `security-headers.js` "(C3)", `file-service.js` "(H1)",
`ws-origin.js` "(C1)"). Read it to understand *why* a given guard exists, not as a
list of open work.

**Scope (as reviewed):** Everything reachable from a browser to Eve and back — HTTP
routes, the WebSocket protocol, auth, file serving, the module iframe sandbox —
reviewed as if Eve were exposed directly to the internet.
**Out of scope:** Eve ↔ relay/relayLLM internals (separate boundary, Unix-socket +
bearer; see [authentication.md](authentication.md) "Eve ↔ backend").

**Original review:** 2026-05-30, static review at HEAD, branch
`security/frontend-internet-exposure-audit`.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low/Hardening

---

## Findings (all resolved — see table for the fixing commit/file)

### 🔴 C1 — Cross-Site WebSocket Hijacking (no Origin validation on upgrade)

WebSocket upgrades are not subject to same-origin policy or CORS the way `fetch`
is. As found, `handleUpgrade` accepted any connection regardless of `Origin`, so
any page the victim visited could open `new WebSocket("ws://eve.host:3000")` from
the victim's browser. Combined with the trusted-subnet bypass (C2) or
`EVE_NO_AUTH=1`, the connection authenticated with **no token**. The WS protocol
exposes `terminal_create` / `terminal_input` (PTYs proxied to relayLLM) plus
`write_file` / `read_file` / `delete_file` / `module_invoke_ai` — i.e. a drive-by
page on a trusted client meant **host RCE**. This is why an Origin gate on the
upgrade is load-bearing, not redundant with the token.

**Resolved:** `ws-origin.js` + `server.js handleUpgrade` reject cross-site
browser Origins (same-origin by default; exact-match to `EVE_PUBLIC_ORIGIN` when
set, for proxies; native/non-browser clients with no Origin allowed).

### 🔴 C2 — Default trusted-subnet bypass trusts the whole NIC subnet

`trusted-network.js` `computeTrustedCidrs` (used by `requireAuth`, `/auth/status`,
and the WS handler) defaults — when `EVE_TRUSTED_SUBNETS` is unset — to loopback
**plus every non-internal NIC's entire subnet**. On a LAN that's the whole
`192.168.x.0/24`; on an internet-exposed host the primary NIC's subnet may be a
provider-shared public range, so the trusted set could include unrelated internet
hosts, short-circuiting all auth (per C1, unauthenticated RCE). The IP source is
correct (`req.socket.remoteAddress` only — the old Host-header bypass is genuinely
closed); the issue was default *scope*.

**Resolved (mitigated):** `trusted-network.js` logs a loud startup WARN when the
trusted set contains a public IPv4 range, names it, and points at
`EVE_DISABLE_SUBNET_BYPASS=1` / `EVE_TRUSTED_SUBNETS`. The default trust behavior
is intentionally unchanged (loopback-only would break local dev / Chrome
automation); operator action is required before internet exposure.

### 🔴 C3 — No Content-Security-Policy / no security headers

As found: no `helmet`, no `res.set` security headers, no CSP `<meta>`. CSP is the
backstop that keeps any HTML-injection bug (C4/C5, or a future one) from becoming
session-token theft and WS takeover; its absence made every injection maximally
severe, and missing `frame-ancestors`/X-Frame-Options allowed clickjacking.

**Resolved:** `security-headers.js` emits global `securityHeaders()` (nosniff,
X-Frame-Options SAMEORIGIN, Referrer-Policy, COOP, HSTS-on-TLS) plus a strict
app-shell CSP with the two inline bootstrap scripts pinned by SHA-256 hash (no
`'unsafe-inline'`). `EVE_DISABLE_CSP=1` escape hatch. Module iframes (already
opaque-origin sandboxed) and the `/auth/safari-login` page are intentionally
excluded. Note the two-place CSP added a footgun — see [learned.md](learned.md)
("blank file preview").

### 🟠 H1 — Path traversal via prefix match (missing path separator)

As found, `validatePath` and four sibling checks in `file-service.js`, plus the
HTTP route in `routes/index.js`, used `resolved.startsWith(projectPath)` with no
trailing separator — so a project at `/home/u/proj` also matched sibling
`/home/u/proj-secrets`, and `../proj-secrets/.env` passed. Worsened because
`readFile` didn't deny dotfiles and the extension allowlist included
`env`/`config`/`log`/`json`/`lock`. `module-service.js` already had the correct
separator-aware check.

**Resolved:** `file-service.js` `_isWithin()` (separator-aware containment:
`target === base || target.startsWith(base + path.sep)`) used in all five checks;
same fix inlined in `/api/files`. Regression tests in
`test/unit/file-service.test.js` and `files-route.test.js`.

### 🟠 H2 — Same-origin serving of user/agent-authored HTML (stored XSS)

`uploadFile` intentionally bypasses the extension allowlist ("any type"), so
`.html`/`.svg` can land in a project; `/api/files/...` served them via `sendFile`
with the extension's Content-Type and no nosniff/CSP/Content-Disposition. Result:
`GET /api/files/<proj>/evil.html` rendered as `text/html` from Eve's own origin →
script with access to the session token and authenticated WS. The module serve
route (`routes/modules.js`) was already MIME-restricted + nosniff + sandboxed
iframe; the raw `/api/files` route had neither.

**Resolved:** `/api/files` sets `nosniff` + a locked-down `default-src 'none'` CSP
on every file; script-capable types (html/svg/xml/xhtml) additionally get the CSP
`sandbox` directive + `Content-Disposition: attachment`. (Sandbox is scoped to
those types — applied to a PDF it blanks Chrome's built-in viewer; see
[learned.md](learned.md).)

### 🟠 H3 — Known-vulnerable production dependencies

The original `npm audit --omit=dev` reported 17 vulnerabilities (1 critical,
8 high, 8 moderate), including the `ws` server library itself.

**Resolved (mostly):** `npm audit fix` brought it to 1 moderate. The remaining
`uuid@9` advisory is a `buf` bounds check in v3/v5/v6; Eve only calls `v4()`
without `buf`, so it is **not exploitable** — the breaking bump to `uuid@14` was
deferred. Durable follow-up: add `npm audit` (or Dependabot) to CI so this can't
regress.

### 🟡 M1 — WebAuthn origin/RP derived from the `Host` header

`expectedOrigin` (used in `verifyLogin` / `verifyEnrollment`) was built from
`req.get('host')` + `x-forwarded-proto`, both attacker-controllable. RP-ID was
partially protected because login uses the *stored* `rpId` and the authenticator
won't sign for a different RP, but `expectedOrigin` should still be pinned for
internet deployment.

**Resolved:** `auth.js` pins the expected **origin** to `EVE_PUBLIC_ORIGIN`
when set. For the **RP-ID**, login uses the stored `rpId` from enrollment first
and falls back to the pinned/derived value; enrollment uses the pinned/derived
RP-ID directly. Legacy host-derived behavior only when `EVE_PUBLIC_ORIGIN` is unset.

### 🟡 M2 — Plaintext HTTP was a warning, not a refusal

As found, without `HTTPS_KEY`/`HTTPS_CERT` Eve bound plain HTTP on all interfaces
and only logged a warning, exposing the bearer session token on the wire.

**Resolved:** `server.js` binds the plaintext listener to `127.0.0.1` only unless
`EVE_ALLOW_PLAINTEXT_REMOTE=1`; HTTPS still binds all interfaces.

### 🟡 M3 — No rate-limiting / size limits on expensive authenticated surface

`express.json({ limit: '50mb' })` plus unbounded WS volume on CPU/memory-heavy ops
(`search_project`, `transcribe_audio`, `tts_speak`, `module_invoke_ai`). Auth
routes were rate-limited; nothing else was.

**Resolved:** `rate-limiter.js` + `ws-handler.js` apply a per-connection
fixed-window cap (default 30 / 10s, tunable via `EVE_RATELIMIT_*`) on the
expensive ops. (Complements the auth-endpoint limiter documented in
[authentication.md](authentication.md) "Rate limiting".)

### 🟡 M4 — `read_plan_file` widens read surface to operator's home

Any authenticated browser can read `~/.claude/plans/*.md`. The path check is
correct, but this exposes operator files outside any project. Intended (the orb
and plan-review flows need it).

**Resolved (hardened):** `ws-handler.js` keeps the intended scope but resolves the
realpath and re-checks containment, defeating a symlink inside the plans dir
pointing elsewhere.

### ⚪ Low / Hardening

- **L1 — Debug logging of credential material.** Removed credential-id / rawId /
  rpId / allowCredentials logging (`routes/auth.js`, `auth.js`); default
  `LOG_LEVEL` lowered from `debug` to `info`.
- **L2 — "Allow All" permission button.** Accepted as a deliberate UX feature, not
  a fallback. The main escalation path (CSWSH) is closed by C1. Revisit if Eve
  becomes multi-user.
- **L3 — Static `public/` served before auth.** Guarded by
  `test/unit/static-exposure.test.js`, which asserts no secret/state files
  (auth.json, sessions.json, *.pem, .env) or `data/`/`certs/` ever live under the
  unauthenticated `public/` root.
- **L4 — `target="_blank"` reverse-tabnabbing.** All chat links now get
  `target="_blank" rel="noopener noreferrer"` (`message-renderer.js`).

---

## What's already done well (design notes — keep these intact)

- **LLM/markdown rendering** goes through `marked` → `DOMPurify.sanitize` with an
  image-source allowlist that strips non-`/api/generated/` images. Tool names,
  personas, file names, and structured-question options are all `escapeHtml`'d.
- **Module iframes** use `sandbox="allow-scripts"` only (opaque origin); the
  postMessage bridge authenticates by `event.source` WeakMap lookup, never
  trusting iframe-supplied scope (`module-host.js`).
- **Module file/path resolution** resolves realpaths and blocks symlink escape with
  the separator-aware prefix check (`module-service.js`) — the pattern H1 adopted.
- **Network trust** reads only `req.socket.remoteAddress`; the documented
  Host-header auth bypass is genuinely closed (`trusted-network.js`).
- **Relay credentials.** Since the project-token brokering refactor, Eve no longer
  handles project tokens: relay strips the token from frontend HTTP responses and
  Eve drops any `token` field in `normalizeProject`, so the secret never reaches
  the browser or Eve's cache. Sessions/terminals are created by `projectId` only;
  relayLLM resolves the scoped token just-in-time from relay's bridge. (Cross-repo
  rationale: see `../relay/docs/decisions/`.)

---

## Remediation status

| ID | Status | Fixing file(s) |
|----|--------|----------------|
| **C1** | ✅ Fixed | `ws-origin.js`, `server.js` handleUpgrade — cross-origin WS → 403; same-origin / native connect. |
| **C2** | ⚠️ Mitigated | `trusted-network.js` startup WARN on public range; default trust unchanged. Operator opt-in required. |
| **C3** | ✅ Fixed | `security-headers.js` — global headers + hash-pinned strict CSP; `EVE_DISABLE_CSP=1`. |
| **H1** | ✅ Fixed | `file-service.js` `_isWithin()` in all 5 checks; inlined in `/api/files`. Regression tests added. |
| **H2** | ✅ Fixed | `/api/files` nosniff + `default-src 'none'`; script types get `sandbox` + `attachment`. |
| **H3** | ✅ Mostly | `npm audit fix` (17 → 1 moderate); remaining `uuid@9` not exploitable (`v4()` only). Add `npm audit` to CI. |
| **M1** | ✅ Fixed | `auth.js` pins origin to `EVE_PUBLIC_ORIGIN`; login RP-ID = stored `rpId`, pin/derived as fallback. |
| **M2** | ✅ Fixed | `server.js` binds plaintext to `127.0.0.1` unless `EVE_ALLOW_PLAINTEXT_REMOTE=1`. |
| **M3** | ✅ Fixed | `rate-limiter.js` + `ws-handler.js` per-connection cap (default 30 / 10s; `EVE_RATELIMIT_*`). |
| **M4** | ✅ Hardened | `ws-handler.js` realpath re-check on `read_plan_file`. |
| **L1** | ✅ Fixed | Credential-material logging removed; default `LOG_LEVEL=info`. |
| **L2** | ⬜ Accepted | "Allow All" left as-is; CSWSH closed by C1. |
| **L3** | ✅ Guarded | `static-exposure.test.js`. |
| **L4** | ✅ Fixed | `message-renderer.js` `rel="noopener noreferrer"`. |

Deployment switches and the hardened run scripts (`npm run start:secure`,
`npm run start:wireguard`) are documented in [authentication.md](authentication.md)
and [remote-access.md](remote-access.md); both scripts refuse to start without
`EVE_PUBLIC_ORIGIN`. The headers, WS-origin gate, the C2 warning, the M1 origin
pin, the M2 bind behavior, and the full hardened HTTPS posture were verified
against live server boots.
