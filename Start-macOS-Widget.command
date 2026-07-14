#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Starting Codex Discord Bridge..."
scripts/start-tmux.sh

echo "Starting monitor..."
scripts/start-monitor-tmux.sh

MONITOR_PORT="$(
  node -e "import('./src/config.js').then(({getConfig})=>process.stdout.write(String(getConfig({requireDiscord:false}).monitorPort)))"
)"

URL="http://127.0.0.1:${MONITOR_PORT}/widget"
echo "Opening widget: ${URL}"
/usr/bin/open "$URL"

echo
echo "Widget view opened."
sleep 5
