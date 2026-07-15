#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION="codex-discord-bridge-relay"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"

cd "$ROOT"
mkdir -p logs

if ! grep -Eq '^CODEX_APP_THREAD_ID=("[^"]+"|[^[:space:]]+)' .env 2>/dev/null; then
  echo "frontstage relay not configured: CODEX_APP_THREAD_ID is empty"
  exit 0
fi

if "$TMUX_BIN" has-session -t "=$SESSION" 2>/dev/null; then
  echo "tmux session already running: $SESSION"
  exit 0
fi

"$TMUX_BIN" new-session -d -s "$SESSION" \
  "cd '$ROOT' && '$NPM_BIN' run frontstage:relay >> logs/relay.out 2>> logs/relay.err"

echo "started tmux session: $SESSION"
