#!/bin/bash
set -euo pipefail

# Resolve project directory from script location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_LABEL="com.barelyworkingcode.eve"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/Eve"
PORT="${PORT:-3000}"
# Default to bundled self-signed certs if they exist
if [ -z "${HTTPS_CERT:-}" ] && [ -f "$SCRIPT_DIR/certs/server.pem" ]; then
  HTTPS_CERT="$SCRIPT_DIR/certs/server.pem"
fi
if [ -z "${HTTPS_KEY:-}" ] && [ -f "$SCRIPT_DIR/certs/server-key.pem" ]; then
  HTTPS_KEY="$SCRIPT_DIR/certs/server-key.pem"
fi

# Determine protocol based on HTTPS cert/key presence
if [ -n "${HTTPS_KEY:-}" ] && [ -n "${HTTPS_CERT:-}" ]; then
  PROTOCOL="https"
else
  PROTOCOL="http"
fi

echo "Installing Eve as a macOS service..."
echo "Project directory: $SCRIPT_DIR"

# --- Check Node.js 18+ ---
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed."
  echo "Install it from https://nodejs.org or via: brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node -v))."
  echo "Update via: brew upgrade node"
  exit 1
fi

NODE_PATH="$(which node)"
echo "Using Node.js $(node -v) at $NODE_PATH"

# --- Install dependencies ---
echo "Running npm install..."
cd "$SCRIPT_DIR"
npm install --production

# --- Capture environment variables ---
# launchd doesn't source shell profiles, so we bake in the current PATH
# and any API keys / Eve-specific vars that are set at install time.
ENV_VARS="<key>PATH</key>
    <string>$PATH</string>
    <key>HOME</key>
    <string>$HOME</string>"

if [ -n "${SHELL:-}" ]; then
  ENV_VARS="$ENV_VARS
    <key>SHELL</key>
    <string>$SHELL</string>"
fi

# API keys
for VAR in ANTHROPIC_API_KEY GOOGLE_GENAI_API_KEY; do
  if [ -n "${!VAR:-}" ]; then
    ENV_VARS="$ENV_VARS
    <key>$VAR</key>
    <string>${!VAR}</string>"
  fi
done

# Optional Eve configuration
for VAR in PORT CLAUDE_PATH GEMINI_PATH EVE_NO_AUTH HTTPS_KEY HTTPS_CERT; do
  if [ -n "${!VAR:-}" ]; then
    ENV_VARS="$ENV_VARS
    <key>$VAR</key>
    <string>${!VAR}</string>"
  fi
done

# --- Create log directory ---
mkdir -p "$LOG_DIR"

# --- Unload existing service (idempotent re-install) ---
if launchctl print "gui/$(id -u)/$SERVICE_LABEL" &>/dev/null; then
  echo "Stopping existing Eve service..."
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
  sleep 1
fi

# --- Write launchd plist ---
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${SCRIPT_DIR}/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    ${ENV_VARS}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ProcessType</key>
  <string>Interactive</string>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/eve.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/eve.stderr.log</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>4096</integer>
  </dict>
</dict>
</plist>
EOF

# Secure the plist (contains API keys)
chmod 600 "$PLIST_PATH"

echo "Plist written to $PLIST_PATH"

# --- Load service ---
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "Service loaded."

# --- Wait for server to respond ---
echo "Waiting for Eve to start..."
ELAPSED=0
while [ $ELAPSED -lt 15 ]; do
  if curl -sk -o /dev/null -w '' "${PROTOCOL}://localhost:$PORT" 2>/dev/null; then
    echo ""
    echo "Eve is running at ${PROTOCOL}://localhost:$PORT"
    echo ""
    echo "Useful commands:"
    echo "  View status:   launchctl print gui/$(id -u)/$SERVICE_LABEL"
    echo "  Stop service:  launchctl kill SIGTERM gui/$(id -u)/$SERVICE_LABEL"
    echo "  View logs:     tail -f $LOG_DIR/eve.stderr.log"
    echo "  Uninstall:     $SCRIPT_DIR/uninstall.sh"
    exit 0
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  printf "."
done

echo ""
echo "Warning: Eve did not respond within 15 seconds."
echo "Check logs for errors: tail -f $LOG_DIR/eve.stderr.log"
echo "Service status: launchctl print gui/$(id -u)/$SERVICE_LABEL"
exit 1
