#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="$ROOT/dist/Codex Discord Bridge Widget.app"
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
