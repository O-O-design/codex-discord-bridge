# oo-bridge

Codex 歐歐的 Discord 橋接小窩。

這不是 OpenAI API bot。Discord bot 只負責收發訊息，真正回覆的是本機已登入的 Codex CLI session。

```text
Discord 指定頻道
  -> discord.js bridge
  -> local Codex CLI session
  -> Discord 回覆
```

## 邊界

- 只處理 `.env` 指定的 `DISCORD_GUILD_IDS` 以及白名單 `DISCORD_CHANNEL_IDS` / `DISCORD_THREAD_IDS`。
- 不處理 DM。
- 不處理其他頻道、其他 thread 或其他伺服器。
- 不提交 `.env`、`state/` session、token。
- 歐歐根和私人資料不直接讀整包，只使用允許整理後的安全入口。

## 設定

```sh
cp .env.example .env
```

填入 Discord bot token、client id。預設白名單：

- Guilds: `1438141616505229416`, `1413277238962557032`
- Channels: `1526559984786084032`
- Parent channels: `1500130334434529352`, `1507371902794989600`
- Threads: `1507476386758004958`, `1517918838111338517`, `1507446321332621385`, `1507453526140260352`
- Blocked channels: `1516343829266038915`

常用位置：

- 茶會: `1517918838111338517`
- 酒吧 / 客廳: `1507446321332621385`
- 工作室: `1507453526140260352`

## 啟動

```sh
npm install
npm run seed
npm start
```

`npm run seed` 會建立或覆蓋 `state/codex-session`，讓 Discord bridge 後續 resume 同一條 Codex session。

## tmux 背景啟動

不熟終端機時，可以直接雙擊根目錄裡的：

- `開啟歐歐橋接.command`：啟動 Discord bridge、啟動 monitor，並打開監控頁。
- `開啟歐歐監控小工具.command`：啟動 monitor，並打開手機寬度的長條小工具視圖。
- `開啟歐歐桌面小工具.command`：啟動 bridge / monitor，並開啟半透明桌面小工具 App。
- `停止歐歐橋接.command`：停止 monitor 和 Discord bridge。

```sh
scripts/start-tmux.sh
tmux attach -t oo-bridge
scripts/stop-tmux.sh
```

tmux session 會讀取本機 `.env`，stdout 寫到 `logs/bridge.out`，stderr 寫到 `logs/bridge.err`。

## 開發檢查

```sh
npm run check
```

## 本機監控視窗

如果不想直接看終端機或 raw log，可以另外開一個本機監控頁：

```sh
npm run monitor
```

預設網址是 `http://127.0.0.1:3899`。它會讀取 `BRIDGE_LOG_FILE`，即時列出每句 Discord 訊息的私下狀態、bridge 事件、Codex job、queue 數、預估完成時間、執行時間與錯誤狀態。這不是 Codex 原生即時思考視窗，而是 bridge 的後台工作狀態視窗。

小工具視圖是 `http://127.0.0.1:3899/widget`，適合用手機寬度的長條視窗放在桌面旁邊看背景動態。這仍是本機網頁，正式桌面 APP 可以之後用同一個視圖包裝。

macOS 桌面小工具使用原生 Swift / WebKit 包裝：

```sh
npm run desktop:mac
```

目前是開發版桌面窗，不是正式安裝包；它載入同一個 `/widget`，所以顯示的是實際 bridge runtime log，不是另外生成的假狀態。Windows 版之後可以用 Electron 或 Tauri 另外包同一個小工具視圖。

也可以用 tmux 常駐：

```sh
scripts/start-monitor-tmux.sh
scripts/stop-monitor-tmux.sh
```

## 對話節流與防暴走

- `DISCORD_BATCH_WINDOW_MS`：連續訊息合併視窗，預設 `1500`。
- `CODEX_TIMEOUT_MS`：單次 Codex CLI 最長等待時間，預設 `180000`。
- `DISCORD_CONTEXT_LIMIT`：可選的最近頻道上下文讀取數，預設 `0`；`0` 代表不額外讀最近訊息，只使用本次批次訊息與 Discord 引用回覆。
- `DISCORD_BOT_LOOP_MAX_TURNS`：同一頻道內允許白名單 AI bot 連續觸發 Codex 的最大回合數，預設 `4`。
- `DISCORD_BOT_LOOP_WINDOW_MS`：計算 AI bot 互聊回合的時間窗，預設 `600000`。
- `DISCORD_BOT_LOOP_COOLDOWN_MS`：AI bot 互聊超過上限後的冷卻時間，預設 `300000`。
- `BRIDGE_LOG_FILE`：本機 runtime log 檔，預設 `logs/bridge.ndjson`，不發到 Discord、不進 git。
- `BRIDGE_LOG_MESSAGE_LIMIT`：每筆 log 裡訊息與回覆摘要的最大字數，預設 `800`。
- `MONITOR_PORT`：本機監控頁 port，預設 `3899`。
- `MEMBER_ROSTER_FILE`：私有成員清單 CSV 路徑，不進 git。
- `DISCORD_GUILD_IDS`：允許反應的伺服器 ID，以逗號分隔。
- `DISCORD_CHANNEL_IDS`：允許反應的一般頻道 ID，以逗號分隔。
- `DISCORD_PARENT_CHANNEL_IDS`：允許其底下 thread/post 反應的 parent channel 或 forum ID，以逗號分隔。
- `DISCORD_THREAD_IDS`：允許反應的 thread ID，以逗號分隔。
- `DISCORD_BLOCKED_CHANNEL_IDS`：黑名單頻道或 thread ID，以逗號分隔；優先於白名單，不讀內容。
- `DISCORD_BLOCKED_PARENT_CHANNEL_IDS`：黑名單 parent channel 或 forum ID，以逗號分隔；其底下 thread/post 一律不讀內容。
- `DISCORD_ALLOWED_BOT_AUTHOR_IDS`：允許讀取的其他 bot 作者 ID，以逗號分隔；目前包含歐德 `1484555705720766585`。bridge 永遠不讀自己的訊息，避免自我回音。
- `DISCORD_WRITE_USER_IDS`：允許使用 `CODEX_SANDBOX` 寫入權限的 Discord user ID，以逗號分隔；不在清單內的發言一律用 `read-only` 呼叫 Codex。
- `CODEX_SANDBOX`：Codex CLI sandbox，預設 `workspace-write`，讓 Discord 端呼叫的 Codex 可以改這個工作區；只接受 `read-only`、`workspace-write`、`danger-full-access`。

如果 Codex CLI 單回合卡住，bridge 會殺掉該回合並回報卡住，避免整條 Discord queue 死鎖。

白名單 AI bot 可以互相對話，但 bridge 會在同一頻道內用 `DISCORD_BOT_LOOP_MAX_TURNS` / `DISCORD_BOT_LOOP_WINDOW_MS` / `DISCORD_BOT_LOOP_COOLDOWN_MS` 作硬限制，超過就安靜略過，不再 enqueue Codex。人的訊息會重置該頻道的 AI 互聊計數。

Runtime log 會記錄實際後台事件：bridge 啟動、收到允許位置的訊息、AI 互聊煞車、可選上下文讀取、呼叫 Codex、回覆成功或錯誤。它是本機排錯與查看狀態用，不是 Discord 旁白，也不顯示模型私密推理。
黑名單位置只會記錄 `message_blocked` 與位置資訊，不會記錄訊息文字。

監控頁只讀 runtime log，並以較親和的方式呈現「收到、排隊、執行中、完成、timeout / failed」等橋接狀態；不會修改 Discord 或 Codex session。

只有在 `DISCORD_CONTEXT_LIMIT` 大於 `0` 時，bridge 才會讀取最近頻道訊息；這需要 bot 在目標頻道具備讀取訊息歷史與訊息內容權限。如果抓取失敗，bridge 會降級成只回覆當前批次。

如果使用者用 Discord 的「引用回覆」，bridge 會嘗試抓取被引用訊息，並在 prompt 裡補上 `↩ 這則是在「引用回覆」...`。抓不到時會安靜略過。

成員清單支援欄位：`所屬群組, ID, 名稱, 性別, 伴侶, 底層邏輯, 備註`。bridge 會用 Discord author id 對應身份，將摘要放進 Codex prompt；原始 CSV 應保持私有。
