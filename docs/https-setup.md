# HTTPS / TLS Certificate Setup (mkcert)

WebAuthn (passkeys) requires a "secure context". Browsers special-case `localhost` over HTTP, but any LAN / WireGuard / internet access needs HTTPS. This doc is the cert + device-trust reference. For the full deployment runbook (DNS, ports, `.env`, enrollment), see [`setup.md`](setup.md).

> A client on a trusted subnet skips the passkey prompt entirely (see "Trusted-subnet bypass" in [`../README.md`](../README.md) and [`authentication.md`](authentication.md)), so HTTPS is not strictly required for that client. It is still recommended for every non-loopback listener so session tokens and file I/O aren't sent in the clear. Configure HTTPS for any deployment that leaves the machine.

## Env-var contract

Eve serves HTTPS when both are set (`server.js`):

| Var | Meaning |
|-----|---------|
| `HTTPS_KEY` | path to the TLS private key (`certs/server-key.pem`) |
| `HTTPS_CERT` | path to the TLS certificate (`certs/server.pem`) |

Without TLS, Eve binds loopback only (fail-safe) unless `EVE_ALLOW_PLAINTEXT_REMOTE=1`. See the env reference in [`../README.md`](../README.md#common-configuration).

## Quick start

```bash
brew install mkcert         # or your platform's package manager; see mkcert's README
mkcert -install             # install the local CA into the system trust store (run once)

scripts/gen-cert.sh eve.example.org              # → certs/server.pem + certs/server-key.pem
HTTPS_CERT=./certs/server.pem HTTPS_KEY=./certs/server-key.pem npm start
```

`scripts/gen-cert.sh <primary-hostname> [extra-names-or-IPs ...]` creates `certs/`, always also covers `localhost`, `127.0.0.1`, `::1`, and the detected LAN IP, backs up any existing cert, and writes exactly the two files `.env` / the env vars point at. (Under the hood it runs `mkcert -cert-file certs/server.pem -key-file certs/server-key.pem <names...>`.)

## Device trust (iOS / macOS)

mkcert is a **private** CA, so every device must trust its root.

```bash
scripts/make-ios-ca-profile.sh    # → ~/Documents/HomeWork-Eve-CA.mobileconfig
```

Install on a device:
- Get the `.mobileconfig` onto it via **AirDrop**, or serve it and open in **Safari**. (The iOS Files app only *previews* a profile — it won't install it.)
- **Settings → General → VPN & Device Management** → Install (shows "Unverified" — normal for a self-made profile).
- **Required: Settings → General → About → Certificate Trust Settings** → enable full trust for the mkcert root. iOS won't trust the cert without this.

On other Macs: double-click the profile → System Settings → Profiles → Install.

Verify: open the **pinned hostname** (e.g. `https://eve.example.org`) on the configured port. It should load with no cert warning, and passkey enrollment/login should work with Face ID / Touch ID.

> If `EVE_PUBLIC_ORIGIN` is set (recommended for any networked deployment), Eve refuses **bare-IP** URLs with `421` — always use the hostname. Only navigate to a bare IP (`https://<ip>:<port>`) when `EVE_PUBLIC_ORIGIN` is unset.

A real public cert (Let's Encrypt — no per-device install) is the alternative; see "Certificate" in [`remote-access.md`](remote-access.md).

## Troubleshooting

**Cert not trusted on a device** — the mkcert root profile isn't installed, or full trust isn't enabled (iOS: Certificate Trust Settings). Re-do "Device trust". On macOS, reset with `mkcert -uninstall && mkcert -install`.

**`NET::ERR_CERT_AUTHORITY_INVALID` (Chrome)** — confirm `mkcert -install` ran, restart Chrome, and check the cert's SANs include the hostname you're using (`openssl x509 -in certs/server.pem -noout -ext subjectAltName`).

**Cert missing a name/IP** — re-run `scripts/gen-cert.sh <names...>` with the missing name, then restart Eve.

**Server won't start with HTTPS** — verify the paths in `HTTPS_KEY` / `HTTPS_CERT` resolve to `certs/server-key.pem` and `certs/server.pem`, and that the key is readable.

## Security notes

- The mkcert CA is for development / personal deployments only — never use it in production.
- Keep the CA private key (`$(mkcert -CAROOT)/rootCA-key.pem`) secure.
- `certs/` is gitignored (`.gitignore`) — never commit certs or keys.
- mkcert leaf certs default to ~2-year validity; re-run `scripts/gen-cert.sh` to renew (same root → no device re-trust needed).
