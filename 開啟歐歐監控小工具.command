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

URL="http://127.0.0.1:${MONITOR_PORT}/widget"
echo "開啟監控小工具：${URL}"
/usr/bin/open "$URL"

echo
echo "已開啟小工具視圖。這是窄版長條監控頁，之後可以包成桌面 APP。"
sleep 5
