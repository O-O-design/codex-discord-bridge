#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/mumu/Documents/Codex/oo-bridge"
APP="$ROOT/dist/歐歐橋接小工具.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"

cd "$ROOT"
mkdir -p "$MACOS"
cp desktop/macos/Info.plist "$CONTENTS/Info.plist"

swiftc desktop/macos/OOBridgeWidget.swift \
  -framework Cocoa \
  -framework WebKit \
  -o "$MACOS/OOBridgeWidget"

chmod +x "$MACOS/OOBridgeWidget"
echo "$APP"
