#!/usr/bin/env bash
#
# Generate Eve's TLS leaf certificate with mkcert, signed by your local mkcert
# root CA. Writes certs/server.pem + certs/server-key.pem (what .env points at).
#
# Usage:
#   scripts/gen-cert.sh <primary-hostname> [extra-name-or-ip ...]
#   e.g.  scripts/gen-cert.sh eve.example.org
#
# Always also covers localhost, 127.0.0.1, ::1, and your primary LAN IP, so the
# loopback door and on-box access work too. After running, (re)generate the iOS
# trust profile with scripts/make-ios-ca-profile.sh and restart Eve.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v mkcert >/dev/null 2>&1 || { echo "mkcert not found — 'brew install mkcert' (and run 'mkcert -install' once)"; exit 1; }
[ "$#" -ge 1 ] || { echo "usage: $0 <primary-hostname> [extra ...]"; exit 1; }

LANIP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
mkdir -p certs

if [ -f certs/server.pem ]; then
  bak="certs/server.pem.bak-$(date +%Y%m%d-%H%M%S)"
  cp certs/server.pem "$bak" && cp certs/server-key.pem "${bak%server.pem.*}server-key.pem.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  echo "Backed up previous cert."
fi

# shellcheck disable=SC2086
mkcert -cert-file certs/server.pem -key-file certs/server-key.pem \
  "$@" localhost 127.0.0.1 ::1 ${LANIP:+$LANIP}

echo
echo "Wrote certs/server.pem + certs/server-key.pem"
openssl x509 -in certs/server.pem -noout -ext subjectAltName
echo
echo "Next: scripts/make-ios-ca-profile.sh   then   relay service restart --id eve"
