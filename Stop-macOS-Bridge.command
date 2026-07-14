#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Stopping monitor..."
scripts/stop-monitor-tmux.sh

echo "Stopping Codex Discord Bridge..."
scripts/stop-tmux.sh

echo
echo "Stopped."
sleep 5
