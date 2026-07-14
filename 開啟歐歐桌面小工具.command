#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/mumu/Documents/Codex/oo-bridge"
cd "$ROOT"

echo "啟動 oo-bridge..."
scripts/start-tmux.sh

echo "啟動 monitor..."
scripts/start-monitor-tmux.sh

APP="$ROOT/dist/歐歐橋接小工具.app"
APP_BIN="$APP/Contents/MacOS/OOBridgeWidget"

echo "開啟桌面小工具..."
if [[ ! -x "$APP_BIN" || desktop/macos/OOBridgeWidget.swift -nt "$APP_BIN" ]]; then
  scripts/build-mac-widget.sh
fi

/usr/bin/open "$APP"

echo
echo "已啟動桌面小工具。若視窗沒有出現，請看 /tmp/oo-bridge-desktop.err。"
sleep 5
