#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_LABEL="com.barelyworkingcode.eve"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/Eve"

echo "Uninstalling Eve macOS service..."

# --- Stop and unload service ---
if launchctl print "gui/$(id -u)/$SERVICE_LABEL" &>/dev/null; then
  echo "Stopping Eve service..."
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
  echo "Service stopped."
else
  echo "Service not running."
fi

# --- Remove plist ---
if [ -f "$PLIST_PATH" ]; then
  rm "$PLIST_PATH"
  echo "Removed $PLIST_PATH"
else
  echo "Plist not found (already removed)."
fi

# --- Remove logs ---
if [ -d "$LOG_DIR" ]; then
  rm -rf "$LOG_DIR"
  echo "Removed $LOG_DIR"
else
  echo "Log directory not found (already removed)."
fi

# --- Optional: remove data directory ---
if [ -d "$SCRIPT_DIR/data" ]; then
  read -r -p "Remove data directory ($SCRIPT_DIR/data)? This deletes projects, sessions, and settings. [y/N] " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    rm -rf "$SCRIPT_DIR/data"
    echo "Removed data directory."
  else
    echo "Kept data directory."
  fi
fi

# --- Optional: remove node_modules ---
if [ -d "$SCRIPT_DIR/node_modules" ]; then
  read -r -p "Remove node_modules ($SCRIPT_DIR/node_modules)? [y/N] " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    rm -rf "$SCRIPT_DIR/node_modules"
    echo "Removed node_modules."
  else
    echo "Kept node_modules."
  fi
fi

echo ""
echo "Eve service uninstalled. Source files remain in $SCRIPT_DIR."
