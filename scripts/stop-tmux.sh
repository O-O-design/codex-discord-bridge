#!/usr/bin/env bash
set -euo pipefail

SESSION="codex-discord-bridge"
LEGACY_SESSION="oo-bridge"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux)}"

if "$TMUX_BIN" has-session -t "=$SESSION" 2>/dev/null; then
  "$TMUX_BIN" kill-session -t "=$SESSION"
  echo "stopped tmux session: $SESSION"
else
  echo "tmux session not running: $SESSION"
fi

if "$TMUX_BIN" has-session -t "=$LEGACY_SESSION" 2>/dev/null; then
  "$TMUX_BIN" kill-session -t "=$LEGACY_SESSION"
  echo "stopped legacy tmux session: $LEGACY_SESSION"
fi
