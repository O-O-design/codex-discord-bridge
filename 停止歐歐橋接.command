#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/mumu/Documents/Codex/oo-bridge"
cd "$ROOT"

echo "停止 monitor..."
scripts/stop-monitor-tmux.sh

echo "停止 oo-bridge..."
scripts/stop-tmux.sh

echo
echo "已停止。"
sleep 5
