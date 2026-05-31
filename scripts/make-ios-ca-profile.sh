#!/usr/bin/env bash
#
# Build an Apple configuration profile (.mobileconfig) that installs your local
# mkcert ROOT CA on an iOS/macOS device, so the device trusts Eve's TLS cert.
# (The leaf cert is signed by this root; installing the root is what creates
# trust.) Output defaults to ~/Documents.
#
# Usage:  scripts/make-ios-ca-profile.sh [output-path]
#
# After it's written:
#   - Get it onto the device via AirDrop, or serve it and open in Safari
#     (Files app only PREVIEWS .mobileconfig — it will not install).
#   - Settings > General > VPN & Device Management > install (shows "Unverified"
#     — normal for a self-made profile).
#   - REQUIRED: Settings > General > About > Certificate Trust Settings >
#     enable full trust for the mkcert root.
set -euo pipefail

command -v mkcert >/dev/null 2>&1 || { echo "mkcert not found"; exit 1; }
CAROOT="$(mkcert -CAROOT)"
[ -f "$CAROOT/rootCA.pem" ] || { echo "no rootCA.pem at $CAROOT — run 'mkcert -install' first"; exit 1; }

OUT="${1:-$HOME/Documents/HomeWork-Eve-CA.mobileconfig}"
DER_B64="$(openssl x509 -in "$CAROOT/rootCA.pem" -outform der | openssl base64)"
U1="$(uuidgen)"; U2="$(uuidgen)"

cat > "$OUT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>HomeWork-Eve-rootCA.cer</string>
      <key>PayloadContent</key>
      <data>
$DER_B64
      </data>
      <key>PayloadDescription</key>
      <string>Installs the Home|Work (Eve) local root CA so its HTTPS certificate is trusted.</string>
      <key>PayloadDisplayName</key>
      <string>Home|Work Eve Root CA</string>
      <key>PayloadIdentifier</key>
      <string>com.homework.eve.ca.$U1</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>$U1</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Trust the Home|Work (Eve) local certificate authority on this device.</string>
  <key>PayloadDisplayName</key>
  <string>Home|Work Eve CA Trust</string>
  <key>PayloadIdentifier</key>
  <string>com.homework.eve.profile.$U2</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>$U2</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
EOF

plutil -lint "$OUT" >/dev/null && echo "Wrote (valid) profile: $OUT"
echo "Install it on each device, then enable full trust under Certificate Trust Settings."
