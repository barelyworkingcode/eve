# Eve — Secure Deployment Setup (start here)

End-to-end runbook for standing up Eve so it's reachable from home (LAN /
WireGuard) and the internet, behind a passkey, with one quiet loopback door for
on-box automation. Follow it top to bottom for a fresh box.

**Deeper references:** [remote-access.md](remote-access.md) (DNS / Firewalla
detail), [authentication.md](authentication.md) (the trust model),
[https-setup.md](https-setup.md) (mkcert basics),
[security-audit-frontend.md](security-audit-frontend.md) (the *why* behind every
control). This doc is the glue.

---

## Topology at a glance

```
                     ┌─────────────────────────── one Eve process (DUAL_LISTEN) ──┐
  Internet ──:443──▶ │ HTTPS  *:443   ── passkey required (WG / LAN / internet)   │
  WireGuard ─:443──▶ │                                                            │
  LAN ──────:443──▶  │ HTTP   127.0.0.1:3000 ── loopback only, NO passkey         │
  on-box ───:3000──▶ │                          (browser automation, tooling)    │
                     └────────────────────────────────────────────────────────────┘
```

- **One hostname everywhere** (e.g. `eve.example.org`) via split-horizon DNS:
  it resolves to the LAN IP at home and the public IP outside. One cert, one
  passkey. (We use the Firewalla DDNS name.)
- **localhost:3000** is loopback-bound, so it's unreachable from any other
  machine (kernel-enforced) and needs no passkey.

---

## Prerequisites

- The Relay ecosystem running (relayLLM etc.); Eve registers as a Relay service.
- Node ≥ 20.6 (for `--env-file`). `node --version`.
- `mkcert` (`brew install mkcert`, then `mkcert -install` once on the host).
- A hostname you can point at the box — here, the Firewalla DDNS name.
- A Firewalla (or router) that can do a NAT port-forward and a local DNS
  override. **Must be a NAT forward that preserves the client IP — NOT a
  loopback-terminating reverse proxy/tunnel** (that would make every internet
  visitor look like `127.0.0.1` and silently break the whole trust model).

---

## Step 1 — TLS certificate + device trust

Eve serves HTTPS on :443 with a cert from your local mkcert CA. Generate the
leaf for your hostname (the script also covers localhost/loopback/LAN):

```bash
scripts/gen-cert.sh eve.example.org          # → certs/server.pem + certs/server-key.pem
```

Because mkcert is a **private** CA, each device must trust its root. Build the
iOS/macOS profile and install it on every device that will use Eve:

```bash
scripts/make-ios-ca-profile.sh               # → ~/Documents/HomeWork-Eve-CA.mobileconfig
```

Install on a device:
- Get the file onto it via **AirDrop**, or serve it and open in **Safari**.
  (The Files app only *previews* `.mobileconfig` — it won't install.)
- **Settings → General → VPN & Device Management** → Install (shows "Unverified"
  — normal for a self-made profile).
- **Required:** **Settings → General → About → Certificate Trust Settings** →
  enable full trust for the mkcert root. iOS won't trust the cert without this.

On other Macs: double-click the profile → System Settings → Profiles → Install.

> A real public cert (Let's Encrypt, no per-device install) is the alternative —
> see "Certificates" in [remote-access.md](remote-access.md). For personal
> devices the mkcert + profile route is simplest.

---

## Step 2 — DNS + network (Firewalla)

Make the one hostname resolve correctly inside and out, and forward 443 in.
Full detail (with the community gotchas) is in
[remote-access.md](remote-access.md#firewalla-split-horizon-setup); the short
version:

1. **Split-horizon (local) DNS:** Firewalla **Services → Custom DNS Rules** →
   map `eve.example.org` → the box's **LAN IP**. (Internal clients now get the
   LAN IP; the public DDNS record still resolves to your WAN IP outside.)
2. **WireGuard:** set the WG client config's `DNS = <Firewalla>` and push a
   route to the box, so tunnel clients also resolve the name internally.
3. **Port-forward:** Firewalla forwards external **443/tcp → box:443** (and
   80/tcp only during Let's Encrypt issuance, if you go that route).
4. **Watch out:** on-device **encrypted DNS** (iCloud Private Relay / DoH) on a
   phone bypasses Firewalla and breaks the local override — block Private Relay +
   the "DoH Services" target list on that device. Verify with
   `dig +short eve.example.org` (LAN → LAN IP; cellular → WAN IP).

---

## Step 3 — Configure `.env`

All deployment specifics live in a **gitignored** `.env` (never committed),
loaded by Node's `--env-file`. Copy the template and fill it in:

```bash
cp .env.example .env
```

Edit `.env` for the single-service hardened model:

```ini
EVE_PUBLIC_ORIGIN=https://eve.example.org      # your hostname; pins WebAuthn + WS origin
EVE_TRUSTED_SUBNETS=127.0.0.0/8,::1            # loopback-only trust → only localhost skips the passkey
DUAL_LISTEN=true                               # one process: HTTPS :443 + HTTP loopback :3000
PORT=443
HTTP_PORT=3000
HTTPS_KEY=./certs/server-key.pem
HTTPS_CERT=./certs/server.pem
# EVE_ALLOW_ENROLLMENT=1                        # leave OFF; only flip ON briefly to enroll (see Step 5)
```

What this produces: **localhost:3000 → no passkey**; **WireGuard / LAN / internet
→ passkey required**; origin pinned to the hostname; bare-IP access refused. See
the full env reference in [`../README.md`](../README.md#environment-variables).

> Trust model nuance: `EVE_TRUSTED_SUBNETS` here is loopback-only, so LAN/WG
> *also* require the passkey. If you'd rather LAN/WG skip the passkey, add their
> CIDRs to `EVE_TRUSTED_SUBNETS`. Either way the internet always needs it.

---

## Step 4 — Register the Relay service

Eve runs as a Relay-managed service that loads `.env`:

```bash
npm run register        # registers service id "eve": node --env-file=.env server.js
```

This registers `--id eve` with `--url http://localhost:3000` (Relay health-checks
the loopback door) and `--autostart`. Start/restart it with:

```bash
relay service restart --id eve
relay service list                   # confirm it's running
```

To change config later: edit `.env` and `relay service restart --id eve` (no
re-register needed unless the command/flags change). To re-register from scratch:
`relay service unregister --id eve && npm run register`.

---

## Step 5 — Enroll the first passkey

A fresh box has no passkey. With loopback-only trust, the enroll screen only
appears to an *untrusted* (LAN/WG) client — but the pre-enrollment gate 404s
those unless you open the one-shot hatch. So:

1. In `.env`, uncomment `EVE_ALLOW_ENROLLMENT=1`, then `relay service restart --id eve`.
2. From a device **on WireGuard or the LAN** (a private IP — the internet can
   **never** enroll, hatch or not), open `https://eve.example.org` → "Set Up
   Passkey" → enroll with Face ID / Touch ID. The passkey binds to the hostname.
3. Re-comment `EVE_ALLOW_ENROLLMENT` and `relay service restart --id eve` to
   close the hatch.

Now: enrolled, and `/api/auth/enroll/start` returns `400 Already enrolled`.
From anywhere on the internet, `https://eve.example.org` shows the passkey login.

---

## Security model recap

| From | Reaches | Passkey? |
|------|---------|----------|
| The box itself | `http://localhost:3000` (loopback) | **No** (automation/tooling) |
| WireGuard / LAN | `https://eve.example.org` → :443 | **Yes** |
| Internet | `https://eve.example.org` → :443 | **Yes** |
| Any bare IP (`https://<ip>`) | — | Refused (`421`, use the hostname) |
| Internet, before any passkey exists | — | **Can never enroll** (hard rule) |

Layered controls (details + rationale in
[security-audit-frontend.md](security-audit-frontend.md)): origin pinning,
WS-origin/CSWSH gate (loopback origins allowed for on-box automation), bare-IP
guard, pre-enrollment gate (internet can never bootstrap), CSP + security
headers, per-connection rate limiting.

---

## Operations & troubleshooting

**Restart / apply config:** `relay service restart --id eve` (loads `.env` + the
current code). Logs: `relay service list`, or the Relay app.

**Cert renewal / new name:** re-run `scripts/gen-cert.sh <names...>`, then
`relay service restart --id eve`. (No device re-trust needed — same root. If the
mkcert *root* ever changes, re-run `scripts/make-ios-ca-profile.sh` and re-install
on devices.) Check expiry: `openssl x509 -in certs/server.pem -noout -dates`.

**Reset / re-enroll a passkey:** stop being able to log in? Remove the
enrollment and redo Step 5:
```bash
rm -f data/auth.json data/sessions.json     # back them up first if unsure
```
Then flip `EVE_ALLOW_ENROLLMENT=1`, restart, enroll from LAN/WG, flip it back.

**"Cert not trusted" on a device:** the mkcert root profile isn't installed, or
full trust isn't enabled (Certificate Trust Settings). Re-do Step 1's install.

**Can reach by IP but not by name / wrong IP returned:** split-horizon DNS isn't
applying — usually on-device encrypted DNS (Private Relay / DoH) or a stale DNS
cache. See Step 2's "Watch out".

**Locked out (can't enroll):** loopback always bootstraps; or set
`EVE_ALLOW_ENROLLMENT=1` from a private network. You can't truly brick it.

**Don't:** put a loopback-terminating reverse proxy/tunnel in front of Eve — it
makes every internet client look like `127.0.0.1` and defeats the source-IP trust
model (passkey bypass + the "internet can't enroll" rule both break). Use a NAT
port-forward that preserves the client IP.

---

## What's committed vs local

- **Committed:** code, `scripts/`, `docs/`, `.env.example` (placeholders only).
- **Local only (gitignored):** `.env` (your hostname + ranges), `certs/`
  (your TLS cert/key), `data/` (passkey + sessions). Nothing deployment-specific
  is ever committed.
