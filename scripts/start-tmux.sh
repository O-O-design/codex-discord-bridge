#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/mumu/Documents/Codex/oo-bridge"
SESSION="oo-bridge"

cd "$ROOT"
mkdir -p logs

if /opt/homebrew/bin/tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already running: $SESSION"
  exit 0
fi

/opt/homebrew/bin/tmux new-session -d -s "$SESSION" \
  "cd '$ROOT' && /opt/homebrew/bin/npm start >> logs/bridge.out 2>> logs/bridge.err"

echo "started tmux session: $SESSION"
