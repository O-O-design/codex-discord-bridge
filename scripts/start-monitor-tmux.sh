#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION="codex-discord-bridge-monitor"
LEGACY_SESSION="oo-bridge-monitor"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"

cd "$ROOT"
mkdir -p logs

if "$TMUX_BIN" has-session -t "=$SESSION" 2>/dev/null; then
  echo "tmux session already running: $SESSION"
  exit 0
fi

if "$TMUX_BIN" has-session -t "=$LEGACY_SESSION" 2>/dev/null; then
  echo "legacy tmux session already running: $LEGACY_SESSION"
  echo "run scripts/stop-monitor-tmux.sh before starting $SESSION"
  exit 0
fi

"$TMUX_BIN" new-session -d -s "$SESSION" \
  "cd '$ROOT' && '$NPM_BIN' run monitor >> logs/monitor.out 2>> logs/monitor.err"

echo "started tmux session: $SESSION"
