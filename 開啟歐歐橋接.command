#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/mumu/Documents/Codex/oo-bridge"
cd "$ROOT"

echo "啟動 oo-bridge..."
scripts/start-tmux.sh

echo "啟動 monitor..."
scripts/start-monitor-tmux.sh

MONITOR_PORT="$(
  node -e "import('./src/config.js').then(({getConfig})=>process.stdout.write(String(getConfig({requireDiscord:false}).monitorPort)))"
)"

URL="http://127.0.0.1:${MONITOR_PORT}"
echo "開啟監控視窗：${URL}"
/usr/bin/open "$URL"

echo
echo "已啟動。可以關掉這個終端機小視窗，bridge 和 monitor 會留在背景 tmux 裡。"
echo "如果要停止，雙擊「停止歐歐橋接.command」。"
sleep 5
