#!/bin/bash
set -euo pipefail

SERVICE_LABEL="com.barelyworkingcode.eve"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/Library/Logs/Eve"
PORT="${PORT:-3000}"

# Determine protocol
if [ -n "${HTTPS_KEY:-}" ] && [ -n "${HTTPS_CERT:-}" ]; then
  PROTOCOL="https"
elif [ -f "$SCRIPT_DIR/certs/server.pem" ] && [ -f "$SCRIPT_DIR/certs/server-key.pem" ]; then
  PROTOCOL="https"
else
  PROTOCOL="http"
fi

# Check service is installed
if ! launchctl print "gui/$(id -u)/$SERVICE_LABEL" &>/dev/null; then
  echo "Eve service is not installed. Run install.sh first."
  exit 1
fi

echo "Restarting Eve..."
launchctl kill SIGTERM "gui/$(id -u)/$SERVICE_LABEL"

# Wait for server to come back (launchd auto-restarts via KeepAlive)
ELAPSED=0
while [ $ELAPSED -lt 15 ]; do
  sleep 1
  if curl -sk -o /dev/null -w '' "${PROTOCOL}://localhost:$PORT" 2>/dev/null; then
    echo "Eve restarted at ${PROTOCOL}://localhost:$PORT"
    exit 0
  fi
  ELAPSED=$((ELAPSED + 1))
  printf "."
done

echo ""
echo "Warning: Eve did not respond within 15 seconds."
echo "Check logs: tail -f $LOG_DIR/eve.stderr.log"
exit 1
