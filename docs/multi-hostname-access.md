# Two-hostname access: `eve.lan` + Firewalla DDNS

**Goal.** Reach Eve at home (LAN / WireGuard) and from the internet, with the
browser always presenting a **hostname, never a raw IP**, and the hardened
posture (passkey, Origin pinning, TLS) intact on every path.

---

## Recommended: one hostname via split-horizon DNS

**Use your Firewalla DDNS name (`xxx.firewalla.org`) everywhere** and make it
resolve to the internal IP at home and the public IP outside. This collapses the
whole problem: **one name → one cert → one passkey** that works on LAN,
WireGuard, and the internet. You don't need `eve.lan` or two passkeys at all.

```
At home / on WireGuard:   xxx.firewalla.org → 10.20.20.10   (Firewalla local DNS)
On the internet:          xxx.firewalla.org → your WAN IP   (Firewalla DDNS)
                                              → port-forward 443 → 10.20.20.10
```

The name never changes, so the TLS cert (issued for `xxx.firewalla.org`) is valid
at both IPs, and the WebAuthn RP-ID is stable. Eve config is just:

```bash
EVE_PUBLIC_ORIGIN=https://xxx.firewalla.org \
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:secure
```

**This is feasible on Firewalla without SSH** — it ships a "Custom DNS Rules"
feature that does exactly this override. There are a few real-world gotchas
(encrypted DNS on the client is the big one); see "Firewalla: split-horizon
setup" below. If you genuinely need two *distinct* names (`eve.lan` +
`xxx.firewalla.org`), skip to "Two distinct hostnames" — but try the single-name
path first.

---

## Firewalla: split-horizon setup

### The supported way (app, no SSH)

Firewalla has a built-in **Custom DNS Rules** feature — this is the officially
supported override and needs no command line ([guide][fw-customdns]):

> **Services → Custom DNS Rules → Add Custom DNS Rule** → domain
> `xxx.firewalla.org`, IP `10.20.20.10` → save.

Notes from Firewalla's docs:
- Works on A (IPv4) and AAAA (IPv6) records. Entering a bare TLD includes
  subdomains; for a specific subdomain pointing somewhere different, add a rule
  for that exact name ([guide][fw-customdns]).
- This is the documented mechanism for "point a domain at an internal service
  while the same name resolves to a different external IP from outside" — i.e.
  split-horizon ([guide][fw-customdns], [DNS config overview][fw-demystify]).
- The public DDNS record is untouched; only clients using Firewalla as their
  resolver see the internal answer.

### WireGuard clients

Custom DNS Rules **do** apply to WireGuard VPN clients — *but only if the WG
client's DNS points at Firewalla*. Set the `DNS = <Firewalla>` line in the
WireGuard client config (device rules don't apply over VPN; the VPN connection's
DNS does) ([WireGuard + DNS][fw-wg-dns]). Also make sure WG pushes a route to
`10.20.20.10`.

### Gotchas others hit (this is the "others must have this issue" part)

1. **Encrypted DNS on the client bypasses Firewalla — the #1 failure, and it
   bites iPhones.** If the device uses **iCloud Private Relay** or a **DoH/DoT**
   profile, its DNS never reaches Firewalla, so your override is ignored and the
   phone resolves `xxx.firewalla.org` to the **public** IP — then it depends on
   hairpin NAT (unreliable on Firewalla). Fix: block **Apple Private Relay** and
   the **"DoH Services"** target list for that device so it's forced onto
   Firewalla's resolver ([Private Relay][fw-relay], [DoH/DoT][fw-doh]).
2. **DNS Booster** generally makes Firewalla win — *except* when the client uses
   on-device DoH (see #1). A few users also report Booster interfering with
   custom entries; toggle it if a rule won't take ([DNS config][fw-demystify]).
3. **"Works on wired, not Wi-Fi"** and **"still returns the external IP"** are
   reported and almost always trace back to #1/#2 or a stale client DNS cache —
   reconnect the device / toggle airplane mode after adding the rule
   ([wired vs Wi-Fi][fw-wired]).
4. **Hairpin NAT is the fallback, and it's flaky on Firewalla.** The community
   consensus is to do the **DNS override** rather than rely on NAT loopback
   ([NAT loopback thread][fw-hairpin]).

### The SSH fallback (only if the app feature misbehaves)

Firewalla runs **dnsmasq**, so you *can* set this at the CLI — unofficial, not
guaranteed across firmware updates ([dnsmasq on Firewalla][fw-dnsmasq]):

```sh
# ssh pi@<firewalla-ip>
echo 'address=/xxx.firewalla.org/10.20.20.10' \
  > ~/.firewalla/config/dnsmasq_local/eve.conf
# make it survive reboots/updates: re-assert from a post_main.d hook
```

`address=/name/ip` forces the A-record; drop a script in
`~/.firewalla/config/post_main.d/` so it's re-applied after Firewalla regenerates
its DNS config on boot/update. Prefer the app's Custom DNS Rules — only reach for
this if the UI rule won't stick.

### Verify it

```sh
# On a LAN/WireGuard client — should return the INTERNAL IP:
dig +short xxx.firewalla.org        # → 10.20.20.10
# From cellular (Firewalla not in path) — should return your WAN IP.
```

### Certificate for `xxx.firewalla.org`

One name → one cert. Get a **Let's Encrypt** cert via **HTTP-01** (forward inbound
`:80` → `10.20.20.10` during issuance/renewal). DNS-01 needs API control of the
`firewalla.org` zone, which you don't have, so HTTP-01 is the path. The cert
validates the *name*, so it's valid whether the name resolved to `10.20.20.10` or
the WAN IP.

[fw-customdns]: https://help.firewalla.com/hc/en-us/articles/360056024294-Guide-How-to-configure-Custom-DNS-Rules
[fw-demystify]: https://help.firewalla.com/hc/en-us/community/posts/4403172242451-Demystifying-Firewalla-s-DNS-Configurations
[fw-wg-dns]: https://help.firewalla.com/hc/en-us/community/posts/4444687726867-WireGuard-VPN-and-DNS-Resolution
[fw-relay]: https://help.firewalla.com/hc/en-us/articles/16524616298771-Blocking-Apple-Private-Relay-Using-Firewalla
[fw-doh]: https://help.firewalla.com/hc/en-us/articles/360060661873-Dealing-DNS-over-HTTPS-and-DNS-over-TLS-on-your-network
[fw-wired]: https://help.firewalla.com/hc/en-us/community/posts/31614139482259-Custom-DNS-works-only-in-wired-lan-not-in-WIFI
[fw-hairpin]: https://help.firewalla.com/hc/en-us/community/posts/8004354470803-NAT-Loopback-hairpin-route-fix
[fw-dnsmasq]: https://help.firewalla.com/hc/en-us/community/posts/9215620130195-Does-Firewalla-use-dnsmasq-Assign-specific-DNS-to-certain-hosts

---

## Two distinct hostnames (only if you can't use one)

Everything below applies **only if** you insist on two separate names
(`eve.lan` + `xxx.firewalla.org`) instead of the single-name path above.

### The WebAuthn constraint (read this first)

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

### Model B — passkey on the internet name, trusted network on `eve.lan`

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

### Model A — a passkey on each hostname (passkey everywhere)

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

### Certificates (two distinct names)

Public CAs **cannot** issue for `.lan`, so the two names need different cert
sources. (The single-hostname path above avoids this entirely — one LE cert for
`xxx.firewalla.org`.) Three ways, simplest first:

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

### DNS for the two-name case

(For the single-name path, see "Firewalla: split-horizon setup" above.)

- **`eve.lan`** — serve it from Firewalla's Custom DNS Rules (mapping
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

**First choice — one hostname (split-horizon DNS).** Set up the Firewalla Custom
DNS Rule (above) and run:

```bash
EVE_PUBLIC_ORIGIN=https://xxx.firewalla.org \
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:secure
```
One passkey, one cert, works on LAN/WireGuard/internet. This is the path to try.

**Fallback — two distinct names.** If you keep `eve.lan` separate and a passkey
on the LAN path isn't required → **Model B**:

```bash
EVE_PUBLIC_ORIGIN="https://eve.lan,https://xxx.firewalla.org" \
EVE_WG_SUBNET="<wireguard-cidr>" \
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:wireguard
```
For a passkey on **both** names → **Model A**: `npm run start:secure` with both
origins, plus the two-passkey enrollment flow (ask me to finish it).

---

## Status

| Piece | State |
|-------|-------|
| Single hostname via Firewalla split-horizon DNS (recommended) | ✅ Supported by Firewalla Custom DNS Rules (app, no SSH); Eve config works today |
| Host-aware RP-ID / origin selection (multi-value `EVE_PUBLIC_ORIGIN`) | ✅ Implemented + tested |
| WS Origin allowlist accepts every configured hostname | ✅ Implemented + tested |
| Bare-IP refusal (HTTP 421 + WS 403) | ✅ Implemented + tested |
| Model B (passkey on DDNS, trusted network on `eve.lan`) | ✅ Works today with the config above |
| Model A two-passkey enrollment (per-cred RP-ID, add-device route, login-per-host) | ⬜ Designed, not built — see "Remaining work" |
| SNI two-cert serving in `server.js` | ⬜ Optional, not built (use one-cert-both-SANs or a proxy meanwhile) |

Verified live: `eve.lan` and the DDNS name both serve (HTTP 200 + WS accepted),
a bare-IP `Host` returns the 421 "use the hostname" page, loopback stays exempt,
and a cross-origin WS is rejected 403.
