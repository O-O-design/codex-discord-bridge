#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Starting Codex Discord Bridge..."
scripts/start-tmux.sh

echo "Starting monitor..."
scripts/start-monitor-tmux.sh

APP="$ROOT/dist/Codex Discord Bridge Widget.app"
APP_BIN="$APP/Contents/MacOS/OOBridgeWidget"

echo "Opening desktop widget..."
if [[ ! -x "$APP_BIN" || desktop/macos/OOBridgeWidget.swift -nt "$APP_BIN" ]]; then
  scripts/build-mac-widget.sh
fi

/usr/bin/open "$APP"

echo
echo "Desktop widget launched."
sleep 5
