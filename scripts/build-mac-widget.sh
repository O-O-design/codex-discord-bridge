#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="$ROOT/dist/Codex Discord Bridge Widget.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

cd "$ROOT"
mkdir -p "$MACOS" "$RESOURCES"
cp desktop/macos/Info.plist "$CONTENTS/Info.plist"
printf '%s\n' "$ROOT" > "$RESOURCES/BridgeProjectRoot.txt"

swiftc desktop/macos/OOBridgeWidget.swift \
  -framework Cocoa \
  -framework WebKit \
  -o "$MACOS/OOBridgeWidget"

chmod +x "$MACOS/OOBridgeWidget"
echo "$APP"
