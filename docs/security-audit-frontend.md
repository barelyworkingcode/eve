# Front-End Security Audit — Browser ↔ Eve trust boundary

**Scope:** Everything reachable from a browser to Eve and back — HTTP routes, the
WebSocket protocol, auth, file serving, and the module iframe sandbox. Reviewed
**as if Eve were to be exposed directly to the internet.**
**Out of scope:** Eve ↔ relayLLM internals (separate trust boundary, Unix-socket +
bearer), relayLLM/relay/relayScheduler code.

**Branch:** `security/frontend-internet-exposure-audit`
**Date:** 2026-05-30
**Reviewer:** Claude (static review of source at HEAD)

---

## TL;DR

Eve's *content-rendering* hygiene is genuinely good (marked + DOMPurify with an
image-source allowlist; sandboxed, opaque-origin module iframes; server-side
path/symlink defense for modules; relay token injected server-side). The
authentication primitives are sound (256-bit tokens, one-time WebAuthn
challenges, raw-socket IP trust that already fixed the old Host-header bypass).

**However, Eve is not currently safe to expose to the internet.** The blocking
issues are about *network exposure and headers*, not crypto:

1. **No Origin check on the WebSocket upgrade** → cross-site WebSocket hijacking.
   Because every privileged action (terminal I/O = shell, file read/write) flows
   over that socket, this is a path to **remote code execution** on the host.
2. **The default "trusted subnet" auto-trusts the whole NIC subnet** — on an
   internet-facing box that can mean *other internet hosts* get passwordless,
   full access.
3. **No Content-Security-Policy or any security headers at all.**
4. A real **path-traversal prefix bug** and **same-origin serving of
   user/agent-authored HTML** that, without CSP, become full origin compromise.
5. **17 known-vulnerable production dependencies** (1 critical, 8 high),
   including the `ws` WebSocket server itself.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low/Hardening

---

## 🔴 C1 — Cross-Site WebSocket Hijacking (no Origin validation on upgrade)

**Where:** `server.js:47-53` (`handleUpgrade`), `ws-handler.js:13-19`.

The upgrade handler accepts any WebSocket connection regardless of the `Origin`
header:

```js
function handleUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}
```

WebSocket connections are **not** subject to the same-origin policy or CORS the
way `fetch` is. Any web page the victim visits can open
`new WebSocket("ws://eve.host:3000")` from the victim's browser. Two ways it
becomes authenticated:

- If the victim's IP is in the trusted subnet (see **C2**) or `EVE_NO_AUTH=1`,
  `ws-handler.js:18` sets `isAuthenticated = true` with **no token at all** — the
  attacker's JS is immediately authenticated.
- Otherwise the attacker needs the session token; but combined with C2/C3 the
  no-token path is the realistic one.

**Impact:** The WS protocol exposes `terminal_create` / `terminal_input`
(`ws-handler.js:206-211`) which proxy straight to relayLLM PTYs — i.e. **arbitrary
shell command execution** — plus `write_file`, `read_file`, `delete_file`,
`module_invoke_ai`, etc. A drive-by page on a trusted client = host compromise.

**Fix:** Validate `req.headers.origin` against an explicit allowlist
(`EVE_PUBLIC_ORIGIN`, plus loopback) **inside `handleUpgrade`** and destroy the
socket on mismatch *before* `wss.handleUpgrade`. Do not rely on the token alone.

---

## 🔴 C2 — Default trusted-subnet bypass trusts the whole NIC subnet

**Where:** `trusted-network.js:130-180` (`computeTrustedCidrs`), used by
`requireAuth` (`routes/index.js:23`), `/auth/status` (`routes/auth.js:49`), and
the WS handler (`ws-handler.js:18`).

When `EVE_TRUSTED_SUBNETS` is unset, the trusted set is loopback **plus every
non-internal NIC's entire subnet** (derived from `iface.cidr` / netmask). On a
typical LAN that's `192.168.x.0/24` — every device on the network gets
passwordless access. **On an internet-exposed host, the primary NIC's subnet may
be a provider-shared public range**, so the "trusted" set can include *unrelated
internet hosts*. `isTrusted()` then short-circuits all auth (including the WS auth
gate), and per C1/terminals that means unauthenticated RCE.

The IP source itself is correct (`req.socket.remoteAddress` only — the old
Host-header bypass is genuinely fixed, good). The problem is the *default scope*.

**Fix for internet exposure:** ship with the bypass **off by default** and require
explicit opt-in. Concretely: set `EVE_DISABLE_SUBNET_BYPASS=1`, or pin
`EVE_TRUSTED_SUBNETS` to a loopback/VPN range you control. Consider changing the
default to loopback-only and making any wider subnet an explicit operator choice.

---

## 🔴 C3 — No Content-Security-Policy / no security headers

**Where:** `server.js` (no `helmet`, no `res.set` for security headers);
`public/index.html` (no CSP `<meta>`). Confirmed: zero CSP / X-Frame-Options /
HSTS / global nosniff / Referrer-Policy anywhere.

CSP is the backstop that keeps an HTML-injection bug (C4/C5 below, or any future
one) from becoming full session-token theft and WS takeover. Its absence means
*any* injection is maximally severe. Also missing:

- **`frame-ancestors` / X-Frame-Options** → clickjacking of the whole UI.
- **HSTS** → downgrade once TLS is in front (see M3).
- **Referrer-Policy**, global **nosniff**.

**Fix:** Add `helmet` with a strict policy: `default-src 'self'`,
`connect-src 'self' wss:`, `img-src 'self' data:`, `frame-src 'self'`,
`object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. The inline
`<script>`/`onclick` in `routes/auth.js:115` (`/auth/safari-login`) needs a
per-response nonce or extraction to a file — handle that page's policy separately.

---

## 🟠 H1 — Path traversal via prefix match (missing path separator)

**Where:** `file-service.js:27` (`validatePath`) and the same pattern in
`renameFile:187`, `moveFile:216`, `uploadFile:269`, `createDirectory:309`, and
the HTTP route `routes/index.js:296`.

```js
if (!resolved.startsWith(path.resolve(projectPath))) throw new Error('Path traversal not allowed');
```

`startsWith` without a trailing separator means a project at `/home/u/proj` also
matches sibling `/home/u/proj-secrets`. A client-supplied relative path like
`../proj-secrets/.env` resolves to `/home/u/proj-secrets/.env`, which *passes*
the check. Reachable by any authenticated/trusted WS client and over HTTP
`/api/files/:projectId/*`.

Worsened by: `readFile` does **not** deny dotfiles, and the extension allowlist
includes `env`, `config`, `log`, `json`, `lock` — so `.env`/secrets are readable.

Note `module-service.js:81,94` already does this correctly
(`candidate.startsWith(moduleRoot + path.sep) && candidate !== moduleRoot`).
Apply that exact pattern everywhere.

**Fix:** `const base = path.resolve(projectPath); if (resolved !== base && !resolved.startsWith(base + path.sep)) throw ...`

---

## 🟠 H2 — Same-origin serving of user/agent-authored HTML (stored XSS)

**Where:** `routes/index.js:287-306` (`/api/files/:projectId/*`) +
`file-service.js:258-293` (`uploadFile`).

- `uploadFile` **intentionally bypasses the extension allowlist** ("any type"),
  so `.html` / `.svg` can be written into a project.
- `/api/files/...` serves them with `res.sendFile`, which sets `Content-Type`
  from the extension and sets **no `nosniff`, no CSP, no `Content-Disposition`**.

Result: `GET /api/files/<proj>/evil.html` renders as `text/html` **from Eve's own
origin** → script runs with access to the session token and the authenticated WS.
SVG (`image/svg+xml`) is equally scriptable. The file can arrive via upload, via
the agent writing it, or via a synced/shared project.

Contrast: the *module* serve route (`routes/modules.js:14-32`) correctly restricts
to a MIME allowlist and sets nosniff — but loads in a sandboxed iframe anyway.
The raw `/api/files` route has neither protection and renders in the top origin.

**Fix:** For `/api/files`, force `Content-Disposition: attachment` +
`X-Content-Type-Options: nosniff` + a sandboxing CSP, and never serve `text/html`
/ `image/svg+xml` inline. Or route binary viewers through a restricted MIME
allowlist like the module route does.

---

## 🟠 H3 — Known-vulnerable production dependencies

`npm audit --omit=dev`: **17 vulnerabilities (1 critical, 8 high, 8 moderate)**,
including:

- **`ws` 8.0.0–8.20.0** — uninitialized memory disclosure. This is the
  internet-facing WebSocket server library itself.
- **`express` / `body-parser` / `qs`** — `qs` DoS chain.
- `uuid` (via mermaid) — bounds-check issue.

**Fix:** `npm audit fix` (most are non-breaking), retest, and add `npm audit` (or
Dependabot) to CI so this doesn't regress before exposure.

---

## 🟡 M1 — WebAuthn origin/RP derived from the `Host` header

**Where:** `auth.js:170-179` (`getRpId`, `getOrigin`), used as `expectedOrigin`
in `verifyLogin:288` and `verifyEnrollment:211`.

`expectedOrigin` is built from `req.get('host')` and `x-forwarded-proto`, both
attacker-controllable. RP-ID binding is partially protected because login uses
the *stored* `rpId` (`auth.js:254,287`) and the authenticator won't sign for a
different RP — but `expectedOrigin` should still be pinned, not header-derived,
for an internet deployment (and `x-forwarded-proto` shouldn't be trusted without
a known proxy).

**Fix:** Introduce `EVE_PUBLIC_ORIGIN` and verify against it; only honor
`x-forwarded-*` when the peer is a configured trusted proxy.

---

## 🟡 M2 — Plaintext HTTP is a warning, not a refusal

**Where:** `server.js:288-293`. Without `HTTPS_KEY/HTTPS_CERT`, Eve binds plain
HTTP on all interfaces and only logs a warning. The session token is a bearer in
the `X-Session-Token` header / WS `auth` frame — sniffable on the wire.

**Fix for internet exposure:** fail closed — refuse to bind a non-loopback
address without TLS (mirror the fail-closed stance already used for the relay
transport in `assertStartupConfig`). Terminate TLS at a proxy only if that proxy
is the sole listener.

---

## 🟡 M3 — No rate-limiting / size limits on expensive authenticated surface

`express.json({ limit: '50mb' })` (`server.js:236`) plus unbounded WS message
volume. Endpoints like `search_project`, `transcribe_audio`/`/api/transcribe`,
`tts_speak`, and `module_invoke_ai` are CPU/memory heavy and have no per-
connection throttle. Auth routes *are* rate-limited (`auth.js:99-114`), but
nothing else is. An authenticated/trusted client can exhaust the host.

**Fix:** Per-connection WS message throttling; lower JSON/body limits to what
attachments actually need; cap concurrent searches/invocations per connection.

---

## 🟡 M4 — `read_plan_file` widens read surface to operator's home

**Where:** `ws-handler.js:395-415`. Any authenticated browser can read any
`~/.claude/plans/*.md`. The path check itself is correct
(`startsWith(plansDir + path.sep)` + `.md`), but this exposes operator files
outside any project to the browser. Information disclosure.

**Fix:** Confirm this is intended; if so, document it; otherwise scope to the
active project.

---

## ⚪ Low / Hardening

- **L1 — Debug logging of credential material:** `routes/auth.js:72-73,85-87`,
  `auth.js` log `credential.id`, `rawId`, `rpId`, `allowCredentials`. Default
  `LOG_LEVEL=debug` (`server.js:22`). Not secrets, but lower the default to
  `info` for production and trim these.
- **L2 — `Allow All` permission button** (per git log `cf8a28f`) auto-approves
  subsequent tool permissions for the connection — increases blast radius if a
  session is hijacked (C1). Consider scoping/expiring it.
- **L3 — Static `public/` served before auth** (`server.js:223`): fine today
  (only client assets live there), but keep `data/`, `certs/`, and any secret
  out of `public/` — currently they are, good. Add a test to keep it that way.
- **L4 — `target="_blank"` only hardened on generated links**
  (`message-renderer.js:1062`); other markdown links rely on DOMPurify defaults.
  Add a global `rel="noopener"` pass.

---

## What's already done well (keep it)

- **LLM/markdown rendering** goes through `marked` → `DOMPurify.sanitize` with an
  image-source allowlist that strips non-`/api/generated/` images
  (`message-renderer.js:1045-1066`). Tool names, agent personas, file names, and
  structured-question options are all `escapeHtml`'d.
- **Module iframes** use `sandbox="allow-scripts"` only (opaque origin), and the
  postMessage bridge authenticates by `event.source` WeakMap lookup, never trusting
  iframe-supplied scope (`module-host.js`).
- **Module file/path resolution** resolves realpaths and blocks symlink escape
  with the *correct* separator-aware prefix check (`module-service.js`).
- **Network trust** reads only `req.socket.remoteAddress` — the documented
  Host-header auth bypass is genuinely closed (`trusted-network.js`).
- **Relay credentials** — as of the project-token brokering refactor
  (relay ADR-007), eve no longer handles project tokens at all. relay strips the
  token from every frontend HTTP response (its `projectView` DTO) and eve drops
  any `token` field in `normalizeProject`, so the secret no longer reaches the
  browser or eve's cache. Sessions/terminals are created with a `projectId` only;
  relayLLM resolves the scoped token just-in-time from relay's bridge. This
  closes both the inbound (browser can't supply/widen) and the previously
  unaddressed outbound (token reaching the browser) exposures.

---

## Suggested remediation order before any internet exposure

1. **C1** WS Origin allowlist on upgrade.
2. **C2** Turn off / pin the subnet bypass (`EVE_DISABLE_SUBNET_BYPASS=1` or
   explicit `EVE_TRUSTED_SUBNETS`).
3. **C3** Add `helmet` + strict CSP (special-case the safari-login page).
4. **M2** Fail-closed on non-loopback without TLS.
5. **H1** Fix the prefix-match traversal across `file-service.js` + `/api/files`.
6. **H2** Stop serving user HTML/SVG inline from `/api/files`.
7. **H3** `npm audit fix` and add audit to CI.
8. **M1/M3/M4 + L\*** as hardening.

---

## Remediation status (branch `security/frontend-internet-exposure-audit`)

| ID | Status | What changed |
|----|--------|--------------|
| **C1** | ✅ Fixed | `ws-origin.js` + `server.js handleUpgrade` reject cross-site browser Origins (same-origin by default; exact-match to `EVE_PUBLIC_ORIGIN` when set, for proxies). Verified live: cross-origin WS → 403, same-origin / native → connect. |
| **C2** | ⚠️ Mitigated | `trusted-network.js` now logs a loud startup WARN when the trusted set contains a public IPv4 range, naming it and pointing at `EVE_DISABLE_SUBNET_BYPASS=1` / `EVE_TRUSTED_SUBNETS`. Default trust behavior unchanged (would break local dev); operator action still required for internet exposure. |
| **C3** | ✅ Fixed | `security-headers.js`: global `securityHeaders()` (nosniff, X-Frame-Options SAMEORIGIN, Referrer-Policy, COOP, HSTS-on-TLS) + strict app-shell CSP with the two inline bootstrap scripts pinned by SHA-256 hash (no `'unsafe-inline'`). `EVE_DISABLE_CSP=1` escape hatch. Module iframes / safari-login intentionally excluded. |
| **H1** | ✅ Fixed | `file-service.js` `_isWithin()` separator-aware containment used in all 5 checks; same fix inlined in `/api/files`. Regression tests added. |
| **H2** | ✅ Fixed | `/api/files` sets `nosniff` + a locked-down `default-src 'none'` CSP on every file; script-capable types (html/svg/xml/xhtml) additionally get the `sandbox` directive + `Content-Disposition: attachment`. The `sandbox` directive is scoped to those types because applied to a PDF it blanks Chrome's built-in viewer. |
| **H3** | ✅ Mostly | `npm audit fix`: 17 vulns (1 crit / 8 high) → 1 moderate. Remaining `uuid@9` advisory is a `buf` bounds check in v3/v5/v6; Eve only calls `v4()` without `buf`, so it is **not exploitable** — breaking bump to uuid@14 deferred. Recommend adding `npm audit` to CI. |
| **M1** | ✅ Fixed | `auth.js` pins WebAuthn RP-ID and expected origin to the single `EVE_PUBLIC_ORIGIN` when set, instead of the `Host` header (stored rpId kept as the login fallback). Legacy host-derived behavior unchanged when unset. Verified: spoofed Host ignored under pinning. |
| **M2** | ✅ Fixed | `server.js` binds the plaintext listener to `127.0.0.1` only unless `EVE_ALLOW_PLAINTEXT_REMOTE=1` is set; HTTPS still binds all interfaces. Verified live via `lsof` (loopback vs `*`). |
| **M3** | ✅ Fixed | `rate-limiter.js` + `ws-handler.js`: per-connection fixed-window cap (default 30 / 10s, tunable via `EVE_RATELIMIT_*`) on expensive ops (session create, search, AI summarize, module invoke, transcribe, TTS). |
| **M4** | ✅ Hardened | `read_plan_file` keeps its (intended) `~/.claude/plans/*.md` scope but now resolves the realpath and re-checks containment, defeating a symlink inside the plans dir pointing elsewhere. |
| **L1** | ✅ Fixed | Removed debug logging of credential IDs / rawId / rpId / allowCredentials (`routes/auth.js`, `auth.js`); default `LOG_LEVEL` lowered from `debug` to `info`. |
| **L2** | ⬜ Accepted | "Allow All" is a deliberate UX feature, not a fallback; left as-is. CSWSH is now closed (C1), which was the main escalation path. Revisit if multi-user. |
| **L3** | ✅ Guarded | Added `static-exposure.test.js` asserting no secret/state files (auth.json, sessions.json, *.pem, .env) or `data/`/`certs/` ever live under the unauthenticated `public/` root. |
| **L4** | ✅ Fixed | All chat links now get `target="_blank" rel="noopener noreferrer"` (reverse-tabnabbing defense + stops link clicks from navigating the SPA away). |

**New deployment switches:** `EVE_PUBLIC_ORIGIN`, `EVE_BIND_HOST`,
`EVE_ALLOW_PLAINTEXT_REMOTE`, `EVE_DISABLE_SUBNET_BYPASS`, `EVE_DISABLE_CSP`,
`EVE_RATELIMIT_*`. `npm run start:secure` (internet + WireGuard) and
`npm run start:wireguard` (trust the tunnel, passkey on public ingress) encode
the hardened posture; both refuse to start without `EVE_PUBLIC_ORIGIN`. See
README "Deployment: WireGuard and/or the internet".

**Tests:** 218 passing (160 prior + new suites `ws-origin`, `security-headers`,
`files-route`, `rate-limiter`, `auth-origin`, `ip-host-guard`, `static-exposure`,
plus additions to `file-service` / `trusted-network`). The headers, WS origin
gate, C2 warning, M1 origin pin, M2 bind behavior, the bare-IP guard, and the
full hardened HTTPS posture were all verified against live server boots.

---

## Access paths: WireGuard + internet

Both run the **same** hardened config (`npm run start:secure`): TLS bound to all
interfaces, `EVE_PUBLIC_ORIGIN` pinned, subnet bypass off, passkey everywhere.
Reach Eve at one hostname (`eve.example.com`) over both paths via split-horizon
DNS so the single passkey (bound to one RP-ID) works on each. Verified live:
HTTPS posture, HSTS, pinned-origin WS accepted, cross-origin WS rejected (403),
and loopback NOT auto-authed with the bypass disabled. WireGuard-only operators
can instead trust the tunnel subnet (`npm run start:wireguard`). Full setup
(split-horizon DNS, Firewalla steps, certs): [remote-access.md](remote-access.md).
