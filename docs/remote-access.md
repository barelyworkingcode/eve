# Remote access: one hostname for LAN, WireGuard, and the internet

**Goal.** Reach Eve from home (LAN / WireGuard) and from the internet using a
**single hostname**, with the browser always presenting that hostname — **never a
raw IP** — and the hardened posture (passkey, Origin pinning, TLS) intact on
every path.

The whole design rests on one decision: **use one name everywhere** and make it
resolve to the internal IP at home and the public IP outside (split-horizon DNS).
One name → one cert → one passkey that works on LAN, WireGuard, and the internet.

```
At home / on WireGuard:   eve.example.com → 10.20.20.10   (Firewalla local DNS)
On the internet:          eve.example.com → your WAN IP   (Firewalla DDNS)
                                            → port-forward 443 → 10.20.20.10
```

The name never changes, so the TLS cert (issued for `eve.example.com`) is valid
at both IPs and the WebAuthn RP-ID is stable. If your only public name is the
Firewalla DDNS name (`xxx.firewalla.org`), use that as `eve.example.com` below.

## Eve config

```bash
EVE_PUBLIC_ORIGIN=https://eve.example.com \
HTTPS_KEY=./certs/eve.key HTTPS_CERT=./certs/eve.crt \
npm run start:secure
```

`start:secure` pins the origin (WebAuthn RP-ID + WebSocket origin), serves TLS on
all interfaces (reachable over the WireGuard interface and the public NIC),
requires a passkey on every request, and refuses bare-IP access. `EVE_PUBLIC_ORIGIN`
takes exactly one origin.

If you'd rather **not** prompt for a passkey over the trusted tunnel, use
`npm run start:wireguard` instead — it trusts your WireGuard CIDR (`EVE_WG_SUBNET`)
so tunnel clients skip the passkey while internet clients still need it. Same
single origin either way.

---

## Firewalla: split-horizon setup

### The supported way (app, no SSH)

Firewalla has a built-in **Custom DNS Rules** feature — the officially supported
override, no command line ([guide][fw-customdns]):

> **Services → Custom DNS Rules → Add Custom DNS Rule** → domain
> `eve.example.com`, IP `10.20.20.10` → save.

From Firewalla's docs:
- Works on A (IPv4) and AAAA (IPv6) records. A bare TLD includes subdomains; for
  a specific subdomain pointing elsewhere, add a rule for that exact name
  ([guide][fw-customdns]).
- This is the documented mechanism for "point a domain at an internal service
  while the same name resolves to a different external IP from outside" — i.e.
  split-horizon ([guide][fw-customdns], [DNS config overview][fw-demystify]).
- The public DDNS record is untouched; only clients using Firewalla as their
  resolver see the internal answer.

### WireGuard clients

Custom DNS Rules **do** apply to WireGuard VPN clients — *but only if the WG
client's DNS points at Firewalla*. Set `DNS = <Firewalla>` in the WireGuard client
config (device rules don't apply over VPN; the VPN connection's DNS does)
([WireGuard + DNS][fw-wg-dns]). Also push a route to `10.20.20.10`.

### Gotchas others hit

1. **Encrypted DNS on the client bypasses Firewalla — the #1 failure, and it
   bites iPhones.** If the device uses **iCloud Private Relay** or a **DoH/DoT**
   profile, its DNS never reaches Firewalla, so the override is ignored and the
   phone resolves `eve.example.com` to the **public** IP — then it depends on
   hairpin NAT (unreliable on Firewalla). Fix: block **Apple Private Relay** and
   the **"DoH Services"** target list for that device so it's forced onto
   Firewalla's resolver ([Private Relay][fw-relay], [DoH/DoT][fw-doh]).
2. **DNS Booster** generally makes Firewalla win — *except* when the client uses
   on-device DoH (see #1). A few users also report Booster interfering with
   custom entries; toggle it if a rule won't take ([DNS config][fw-demystify]).
3. **"Works on wired, not Wi-Fi"** and **"still returns the external IP"** are
   reported and almost always trace to #1/#2 or a stale client DNS cache —
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
echo 'address=/eve.example.com/10.20.20.10' \
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
dig +short eve.example.com        # → 10.20.20.10
# From cellular (Firewalla not in path) — should return your WAN IP.
```

### Certificate

One name → one **Let's Encrypt** cert via **HTTP-01** (forward inbound `:80` →
`10.20.20.10` during issuance/renewal). DNS-01 needs API control of the zone; if
your public name is a Firewalla DDNS name you won't have that, so HTTP-01 is the
path. The cert validates the *name*, so it's valid whether the name resolved to
`10.20.20.10` or the WAN IP. Port-forward **443/tcp** (and 80/tcp during cert
issuance) from the Firewalla to the Eve host; restrict the forward to those ports.

[fw-customdns]: https://help.firewalla.com/hc/en-us/articles/360056024294-Guide-How-to-configure-Custom-DNS-Rules
[fw-demystify]: https://help.firewalla.com/hc/en-us/community/posts/4403172242451-Demystifying-Firewalla-s-DNS-Configurations
[fw-wg-dns]: https://help.firewalla.com/hc/en-us/community/posts/4444687726867-WireGuard-VPN-and-DNS-Resolution
[fw-relay]: https://help.firewalla.com/hc/en-us/articles/16524616298771-Blocking-Apple-Private-Relay-Using-Firewalla
[fw-doh]: https://help.firewalla.com/hc/en-us/articles/360060661873-Dealing-DNS-over-HTTPS-and-DNS-over-TLS-on-your-network
[fw-wired]: https://help.firewalla.com/hc/en-us/community/posts/31614139482259-Custom-DNS-works-only-in-wired-lan-not-in-WIFI
[fw-hairpin]: https://help.firewalla.com/hc/en-us/community/posts/8004354470803-NAT-Loopback-hairpin-route-fix
[fw-dnsmasq]: https://help.firewalla.com/hc/en-us/community/posts/9215620130195-Does-Firewalla-use-dnsmasq-Assign-specific-DNS-to-certain-hosts

---

## Enforcement: "hostname, not IP" (implemented)

When `EVE_PUBLIC_ORIGIN` is set, Eve actively refuses bare-IP browser access:

- **HTTP**: a request whose `Host` is a non-loopback IP gets a `421` page telling
  the user to open Eve at its configured name (clickable link). Loopback IPs are
  exempt so local tooling/health checks keep working. (`ip-host-guard.js`)
- **WebSocket**: an upgrade whose `Origin` is an IP (or anything other than the
  pinned origin) is rejected with `403` before the socket is accepted.
  (`ws-origin.js`)
- **WebAuthn**: RP-ID/origin are pinned to the configured hostname, so even if a
  request slipped through, a passkey ceremony against an IP can't succeed.

Belt-and-suspenders: issue your TLS cert with **only the hostname** as a SAN (no
IP SAN). Then `https://<ip>` fails at the TLS layer too.

---

## Status

| Piece | State |
|-------|-------|
| Single-origin pinning of WebAuthn RP-ID + WebSocket origin (`EVE_PUBLIC_ORIGIN`) | ✅ Implemented + tested |
| Bare-IP refusal (HTTP 421 + WS 403) | ✅ Implemented + tested |
| Firewalla split-horizon override | ✅ Supported by Custom DNS Rules (app, no SSH) |
| `start:secure` (passkey everywhere) / `start:wireguard` (trust the tunnel) | ✅ Both work today |

Verified live: the configured hostname serves (HTTP 200 + WS accepted), a bare-IP
`Host` returns the 421 "use the hostname" page, loopback stays exempt, and a
non-pinned-origin WS is rejected 403.
