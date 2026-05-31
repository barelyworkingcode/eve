# Two-hostname access: `eve.lan` + Firewalla DDNS

**Goal.** Reach Eve at two names — `eve.lan` (local / WireGuard) and a Firewalla
DDNS name (internet) — with the browser always presenting a **hostname, never a
raw IP**. Keep the hardened posture (passkey, Origin pinning, TLS) intact on both.

> If you can instead point **one** real domain at both addresses with
> split-horizon DNS (e.g. `eve.example.com` → LAN/WG IP internally, public IP
> externally), do that — it sidesteps everything in the "WebAuthn constraint"
> section below: one name, one cert, one passkey. The rest of this doc is for the
> genuine two-distinct-names case you asked for.

---

## The WebAuthn constraint (read this first)

A passkey is cryptographically bound to **one RP-ID** (a single registrable
domain). The browser will only use a credential when the page's origin matches
that RP-ID, or is a subdomain of it.

- `eve.lan` and `home.firewalla.net` (or whatever your DDNS name is) **do not
  share a registrable parent**. `.lan` isn't a public-suffix domain at all, and
  the DDNS name lives under a different parent. So there is **no single RP-ID
  that covers both** — one passkey cannot work on both names.
- A bare **IP cannot be an RP-ID** — WebAuthn ceremonies against `https://1.2.3.4`
  fail. That's *why* "the browser must present a hostname, not an IP." Eve now
  enforces this (see "Enforcement" below).

This leaves two viable models. Pick one.

---

## Model B — Passkey on the internet name, trusted network on `eve.lan` (recommended, works today)

The DDNS name (exposed to the internet) is protected by a passkey. `eve.lan`
(reached only over the LAN or the WireGuard tunnel) is trusted at the network
layer — the tunnel/LAN *is* the auth boundary, so no passkey prompt there.

**Why this is the pragmatic default:** zero new features, it's the existing
trusted-subnet model, and it matches the real trust topology (you already trust
your LAN/WireGuard; the internet you don't).

```bash
EVE_PUBLIC_ORIGIN="https://eve.lan,https://home.firewalla.net" \
EVE_TRUSTED_SUBNETS="192.168.0.0/16,10.8.0.0/24" \   # your LAN + WireGuard CIDRs
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:wireguard            # or set the vars explicitly with `npm start`
```

What happens:
- **Over `eve.lan`** (LAN/WG): source IP is in `EVE_TRUSTED_SUBNETS` → no passkey.
  The WS Origin gate still accepts `https://eve.lan` because it's in
  `EVE_PUBLIC_ORIGIN`.
- **Over the DDNS name** (internet): source IP is *not* trusted → passkey
  required. The passkey is enrolled under the DDNS RP-ID. Eve selects that RP-ID
  automatically because you reached it on that hostname (host-aware selection,
  implemented — see below).

**Enroll the passkey once while visiting the DDNS name** (from outside, or via
Firewalla hairpin/split DNS so the DDNS name resolves internally too). That binds
the credential to the DDNS RP-ID, which is the path that actually needs it.

Trade-off: no passkey on the `eve.lan` path. If you want a passkey on **both**
names, use Model A.

---

## Model A — A passkey on each hostname (passkey everywhere)

Enroll **two** passkeys: one bound to `eve.lan`, one bound to the DDNS name. The
authenticator stores both; Eve picks the right RP-ID per request.

```bash
EVE_PUBLIC_ORIGIN="https://eve.lan,https://home.firewalla.net" \
EVE_DISABLE_SUBNET_BYPASS=1 \        # passkey on every request, including LAN
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:secure
```

**Implemented already (this branch):**
- Host-aware RP-ID/origin **selection** — `getRpId`/`getOrigin` pick the pinned
  entry matching the hostname the browser used, so a ceremony on `eve.lan` uses
  the `eve.lan` RP-ID and a ceremony on the DDNS name uses the DDNS RP-ID.
- **Verification accepts the full allowlist** — `_expectedOrigins`/`_expectedRpIds`
  return both, so a credential enrolled under either name validates.

**Remaining work to fully support two passkeys (not yet built):**
1. **Per-credential RP-ID storage.** `data/auth.json` currently keeps a single
   top-level `rpId` and `verifyEnrollment` *overwrites* the file. Change it to
   store `rpId` on each credential and to *append*. Keep reading the legacy
   top-level `rpId` for existing single-passkey installs.
2. **Authenticated "add passkey for this hostname" flow.** Today
   `/auth/enroll/*` is blocked once enrolled (`requireNotEnrolled`). Add
   `POST /api/auth/enroll/add/start` + `/finish` gated by `requireAuth` (you must
   already be signed in), generating options with the current host's RP-ID and
   appending the new credential. A small "Add this device / hostname" button in
   settings triggers it.
3. **Login options per host.** `generateLoginOptions` should request the
   host-selected RP-ID (`getRpId(req)`) instead of the single stored one, so the
   authenticator surfaces the credential bound to the name you're on.

This is a contained change (no client framework, ~1 route + schema tweak). Say
the word and I'll implement it.

---

## Certificates

Public CAs **cannot** issue for `.lan`, so the two names need different cert
sources. Three ways, simplest first:

1. **One self-signed/mkcert cert with both names as SANs (simplest).**
   `mkcert eve.lan home.firewalla.net` produces a single cert valid for both;
   point `HTTPS_KEY`/`HTTPS_CERT` at it. You must install the mkcert **root CA**
   on every client device (on iOS: install the profile, then enable it under
   Settings → General → About → Certificate Trust Settings). Fine for personal
   devices; not for sharing with others.

2. **Two certs via SNI (best browser trust).** mkcert (or self-signed) for
   `eve.lan`, **Let's Encrypt** for the public DDNS name. This needs Eve to pick
   the cert by SNI — a small `https.createServer({ SNICallback })` addition to
   `server.js` (not yet implemented; ~15 lines). LE issuance for the DDNS name
   uses HTTP-01 (forward inbound :80 → Eve) or DNS-01 (if you control the DNS for
   that name via an API).

3. **Reverse proxy terminates TLS (e.g. Caddy).** Caddy auto-provisions LE for
   the public name and serves your local cert for `eve.lan`, proxying to Eve on
   loopback. **Caveat:** behind a proxy, `req.socket.remoteAddress` becomes the
   proxy's IP, so the trusted-subnet check sees the proxy, not the real client.
   If you go this route, either rely on the passkey for everything
   (`EVE_DISABLE_SUBNET_BYPASS=1`) or add vetted `X-Forwarded-For` parsing gated
   to the proxy IP — Eve deliberately does **not** trust `X-Forwarded-For` today.

**Recommendation:** start with option 1 (one mkcert cert, both SANs) if it's just
your devices; move to option 2 when you want browser-trusted certs without
installing a root CA. Avoid option 3 unless you already run a proxy, because of
the source-IP caveat.

---

## DNS and Firewalla

- **`eve.lan`** — serve it from Firewalla's local DNS (a DNS rule mapping
  `eve.lan` → the Eve host's LAN IP). Make Firewalla the DNS server for your
  WireGuard peers too, so the name resolves over the tunnel. (mDNS/`.local` is an
  alternative but doesn't traverse WireGuard cleanly; a local DNS A-record is
  more reliable.)
- **DDNS name** — enable Firewalla's DDNS so the public name tracks your WAN IP.
  Port-forward **443/tcp** (and 80/tcp if using LE HTTP-01) from the Firewalla to
  the Eve host. Restrict the forward to 443 only.
- **Optional hairpin / split DNS** — add a local DNS rule so the DDNS name also
  resolves to the Eve host internally; lets you enroll/test the DDNS passkey from
  inside.

---

## Enforcement: "hostname, not IP" (implemented)

When `EVE_PUBLIC_ORIGIN` is set, Eve actively refuses bare-IP browser access:

- **HTTP**: a request whose `Host` is a non-loopback IP gets a `421` page telling
  the user to open Eve at one of its configured names (with clickable links).
  Loopback IPs are exempt so local tooling/health checks keep working.
  (`ip-host-guard.js`)
- **WebSocket**: an upgrade whose `Origin` is an IP (or any non-allowlisted
  origin) is rejected with `403` before the socket is accepted. (`ws-origin.js`)
- **WebAuthn**: RP-ID/origin are pinned to the configured hostnames, so even if a
  request slipped through, a passkey ceremony against an IP can't succeed.

Belt-and-suspenders: issue your TLS cert with **only the hostnames** as SANs (no
IP SAN). Then `https://<ip>` fails at the TLS layer too.

---

## Recommended config for your setup

If a passkey on the LAN path isn't required → **Model B** (works now):

```bash
EVE_PUBLIC_ORIGIN="https://eve.lan,https://<your-ddns-name>" \
EVE_WG_SUBNET="<wireguard-cidr>" \
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:wireguard
```
(`start:wireguard` also accepts extra LAN CIDRs — set `EVE_TRUSTED_SUBNETS`
directly with `npm start` if you need both LAN and WG ranges trusted.)

If you want a passkey on **both** names → **Model A**: run `npm run start:secure`
with the same `EVE_PUBLIC_ORIGIN`, and ask me to finish the two-passkey
enrollment flow (the 3 items above).

---

## Status

| Piece | State |
|-------|-------|
| Host-aware RP-ID / origin selection (multi-value `EVE_PUBLIC_ORIGIN`) | ✅ Implemented + tested |
| WS Origin allowlist accepts every configured hostname | ✅ Implemented + tested |
| Bare-IP refusal (HTTP 421 + WS 403) | ✅ Implemented + tested |
| Model B (passkey on DDNS, trusted network on `eve.lan`) | ✅ Works today with the config above |
| Model A two-passkey enrollment (per-cred RP-ID, add-device route, login-per-host) | ⬜ Designed, not built — see "Remaining work" |
| SNI two-cert serving in `server.js` | ⬜ Optional, not built (use one-cert-both-SANs or a proxy meanwhile) |

Verified live: `eve.lan` and the DDNS name both serve (HTTP 200 + WS accepted),
a bare-IP `Host` returns the 421 "use the hostname" page, loopback stays exempt,
and a cross-origin WS is rejected 403.
