#!/usr/bin/env bash
set -euo pipefail

SESSION="oo-bridge-monitor"

if /opt/homebrew/bin/tmux has-session -t "$SESSION" 2>/dev/null; then
  /opt/homebrew/bin/tmux kill-session -t "$SESSION"
  echo "stopped tmux session: $SESSION"
else
  echo "tmux session not running: $SESSION"
fi
