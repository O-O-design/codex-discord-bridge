# Upstream Integration Notes

這份文件是給原始 bridge 維護者或整合者看的交接說明。

本模板來自一份已實際跑過的 Codex Discord bridge。它保留可泛用的工程改動，移除了個人 token、真實 Discord ID、私人記憶、聊天紀錄、session 與 log。

## 整體定位

原始目標是讓 Discord Bot 接到本機 Codex CLI，讓使用者能在 Discord 中和本機 Codex session 對話。

這份模板在基本橋接之外，補上了幾個適合 AI Bot / 公開群聊場景的能力：

- 私人測試頻道與公開群聊頻道分流。
- 公開頻道由 Codex 判斷是否回覆，不相關時輸出 `NO_REPLY`。
- Bot 對 Bot 互動防迴圈。
- Codex session 輪替、近期對話紀錄與摘要延續。
- persona / memory / people 分檔。
- 圖片與 Discord 自訂表情符號處理。
- Discord 狀態文字。
- Windows 新手用 start / stop / login cmd 腳本。
- 可由 `.env` 設定 Bot 名稱、使用者稱呼、呼叫名稱、公開呼叫名稱。

## 相對原始簡單 Bridge 的主要追加

### 1. 公開頻道模式

相關設定：

```env
DISCORD_PUBLIC_CHANNEL_IDS=<channel-id>
DISCORD_PUBLIC_MODE_ENABLED=true
DISCORD_PUBLIC_DECISION_COOLDOWN_SECONDS=0
DISCORD_PUBLIC_MAX_CONSECUTIVE_BOT_TURNS=3
DISCORD_PUBLIC_BOT_CALL_NAMES=
```

行為：

- `DISCORD_WATCH_CHANNEL_IDS` 適合私人或測試頻道。
- `DISCORD_PUBLIC_CHANNEL_IDS` 適合多人公開群聊。
- 公開頻道會觀察近期訊息，交給 Codex 判斷要不要回。
- 若 Codex 回 `NO_REPLY`，Bot 不送訊息。
- 其他 Bot 只有直接點名、回覆或符合公開呼叫名稱時才觸發。
- 連續 Bot 對 Bot 回合用 `DISCORD_PUBLIC_MAX_CONSECUTIVE_BOT_TURNS` 擋住。

### 2. 名稱抽成設定

相關設定：

```env
DISCORD_BOT_DISPLAY_NAME=
DISCORD_OWNER_DISPLAY_NAME=
DISCORD_TRIGGER_NAMES=
DISCORD_PUBLIC_BOT_CALL_NAMES=
```

用途：

- 避免程式硬寫特定使用者或 Bot 名稱。
- Discord mention 會轉成 `@<bot-name>` 放入 prompt。
- 公開模式會用這些名稱判斷是否和使用者 / Bot 相關。

### 3. Session 與記憶延續

相關設定：

```env
CODEX_SESSION_FILE=.codex-discord-session
CODEX_SESSION_STATE_FILE=.private/session-state.json
CODEX_MAX_SESSION_TURNS=50
CODEX_HISTORY_FILE=.private/conversation-history.jsonl
CODEX_HISTORY_TURNS=12
CODEX_SUMMARY_FILE=.private/recent-summary.md
CODEX_SUMMARY_EVERY_TURNS=20
CODEX_PUBLIC_SESSION_FILE=.public/codex-session
CODEX_PUBLIC_HISTORY_FILE=.public/conversation-history.jsonl
CODEX_PUBLIC_SUMMARY_FILE=.public/memory-summary.md
```

行為：

- 成功回覆會寫入 JSONL 近期紀錄。
- 新 session 會帶入最近幾則對話與摘要。
- 每隔指定回合更新摘要。
- session 達上限會自動換新。
- `/newsession` 可手動換新私人與公開 session。
- `/session` 可查看 session 狀態。

### 4. Persona / Memory / People 分檔

模板內含：

```text
.private/persona.md
.private/memory.md
.private/people.md
.private/AGENTS.md
.public/AGENTS.md
.public/memory-summary.md
```

用途：

- `persona.md`：人格、語氣、關係界線。
- `memory.md`：穩定記憶、重要日期、偏好。
- `people.md`：群友稱呼、AI 名稱、注意事項。
- `.public/AGENTS.md`：公開頻道規則，保護隱私並控制插話。

### 5. 圖片與自訂表情符號

相關設定：

```env
DISCORD_IMAGE_MAX_COUNT=4
DISCORD_IMAGE_MAX_BYTES=10485760
```

行為：

- 支援 Discord 圖片附件傳給 Codex CLI 的 `-i`。
- 支援讀取 Discord 自訂表情符號圖片，讓 Codex 能看圖。
- 送出回覆前，若文字包含 `:emoji_name:`，會嘗試轉回 `<:emoji_name:id>`。
- Bot 啟動時會快取伺服器自訂表情符號。

### 6. Discord 狀態文字

相關設定：

```env
DISCORD_ACTIVITY_TYPE=CUSTOM
DISCORD_ACTIVITY_TEXT=
```

支援類型：

- `CUSTOM`
- `PLAYING`
- `LISTENING`
- `WATCHING`
- `COMPETING`

### 7. Windows 操作腳本

新增或保留：

```text
login-codex.cmd
start-bot.cmd
stop-bot.cmd
scripts/start-bot.ps1
scripts/stop-bot.ps1
```

用途：

- `login-codex.cmd`：登入 Codex CLI。
- `start-bot.cmd`：啟動 Bot，並用 `.bot.pid` 防止重複啟動。
- `stop-bot.cmd`：停止 Bot。

## 安全設計

- `.env` 不應提交。
- `.private/` 與 `.public/` 可能含個人資料或聊天紀錄，正式開源時建議改成 `.private.example/` 或只保留空白模板。
- `DISCORD_ALLOWED_USER_IDS` 限制私人模式與管理 slash command。
- Codex 子程序會過濾敏感環境變數名稱，例如 token、secret、password、api key。
- 公開模式使用 `.public` workdir，不讀私人 memory。
- Discord 訊息一律視為不可信輸入。

## 建議上游整合方式

可以拆成幾個 PR 或模組，降低審查負擔：

1. 基礎安全與 `.env` 泛用化。
2. Windows 啟停腳本與新手 README。
3. session history / summary / `/session` / `/newsession`。
4. public mode / `NO_REPLY` / bot loop guard。
5. image and custom emoji support。
6. persona / memory / people template docs。

## 移交前檢查清單

正式放上 GitHub 前，請再次確認：

- 沒有 `.env`。
- 沒有 Discord token、user ID、guild ID、channel ID。
- 沒有私人 persona / memory / people。
- 沒有 conversation-history、summary、session-state、codex-session。
- 沒有 `.bot.pid`、stdout/stderr log。
- 沒有 `node_modules` 或 `.tools`。
- README 文字中的人名、Bot 名都是泛用範例。

## 已知限制

- 本專案依賴本機 Codex CLI，不是 OpenAI API service。
- 主機必須保持開機且 Bot 程序正在跑。
- Discord 自訂表情符號只能在 Bot 可存取且同伺服器可用時正常顯示。
- 公開模式會消耗 Codex 額度，建議保守設定觸發規則。
- Windows 以外平台需要自行調整 `CODEX_CLI_PATH` 與啟動方式。
