# Public setup guide

這份文件是給想把本機 Codex 接到 Discord 的使用者。重點不是做一個
「會自己死邏輯聊天的 Discord bot」，而是把 Discord 變成本機 Codex
session 的麥克風、眼睛和發聲器。

## 這個橋接在做什麼

```text
Discord 訊息
  -> allowlist/denylist 檢查
  -> discord.js bridge 收訊
  -> 本機 Codex CLI session 或前台 Codex App task 產生回覆
  -> bridge 把回覆送回 Discord
```

真正理解上下文、決定要不要回、產生文字的是本機 Codex session。
Discord bot 只是傳輸層，不該另外寫一套假人格、假狀態窗或固定句庫。

比較直白地說：

- Discord bot 是麥克風：接收允許頻道/thread 裡的訊息。
- Discord bot 是眼睛：把來源、作者、引用回覆、有限上下文交給 Codex。
- Discord bot 是發聲器：把 Codex 的輸出送回 Discord。
- Runtime status window 是本機狀態窗：只顯示真實 bridge/Codex 事件，不假裝代理人在思考。
- Discord Watcher + Agent Event Stream 是前台可見足跡：把 Discord 觸發的
  Codex App turn、工具、壓縮、回覆狀態留在目前 Codex task UI。

## v0.2.0 重點

- 支援 guild/channel/thread allowlist。
- 支援 channel/thread denylist，避免跑進不該去的房間。
- 支援 `DISCORD_WRITE_USER_IDS`，只有可信使用者能觸發 `workspace-write`。
- 加入引用回覆 context，Codex 可以看見使用者在回哪一則訊息。
- 圖片附件會下載成本機檔案，透過 `codex exec resume --image` 交給 Codex 看圖。
- 白名單使用者可跟 bridge 私訊；Codex 也能把適合私下談的回覆改成 DM。
- Codex 可用 `[[discord-upload:/path]]` 要 bridge 上傳本機產物。
- 開發、跑程式、改檔案類訊息可先要求 Discord 上批准，再交給 Codex 跑。
- 若不想讓背景 Codex 自動回覆，可用 `DISCORD_DELIVERY_MODE=inbox`，只把 Discord 訊息收進前台 inbox，交給使用中的 Codex 任務讀取與決定。
- 若要把 inbox 接到一個已開啟的 Codex App task，可在自用 `.env` 設定 `CODEX_APP_THREAD_ID`，再執行 `npm run frontstage:relay`。公開版預設不填這個值，避免未經選擇就喚醒私人 task。
- 若要在 Codex UI 看見 Discord 觸發的前台工作狀態，使用
  [DISCORD_WATCHER.md](DISCORD_WATCHER.md) 的 Discord Watcher + Agent Event
  Stream 流程。
- 同一人連續短訊息會等久一點，多人混聊仍用較短窗口，避免單人碎訊息被逐句切開。
- `DISCORD_CONTEXT_LIMIT=0` 預設關閉最近訊息讀取，避免誤解成無限制讀頻道。
- AI-bot loop guard 可以讓 AI 互聊幾輪後煞車。
- Runtime monitor 和 `/widget` 小窗顯示真實事件、排隊、處理中、完成紀錄。
- Codex CLI stdout/stderr 會記成 `codex_cli_output`，但不硬猜工具名稱。
- Windows 使用者可用 `.cmd` / PowerShell launcher 啟動。
- macOS 使用者可用真正的 `.app` 小窗啟動；`.command` 只保留作為備用工具。

## 最短安裝流程

1. 安裝 Node.js 22.12 或更新版本。
2. 安裝並登入 Codex CLI。
3. 到 Discord Developer Portal 建立 application 和 bot。
4. 邀請 bot 到自己的測試伺服器。
5. 複製 `.env.example` 成 `.env`。
6. 填入 Discord token、client id、guild/channel/thread allowlist。
7. 執行 `npm install`。
8. 執行 `npm run seed` 建立 Codex session。
9. 執行 `npm start` 啟動 bridge。
10. 另開 monitor：`npm run monitor`。
11. 打開 `http://127.0.0.1:3899/widget` 看狀態小窗。

Windows 使用者可以先看 [WINDOWS.md](WINDOWS.md)，用
`Start-Windows-Bridge.cmd` 和 `Start-Windows-Widget.cmd`。

macOS 使用者可以先看 [MACOS_APP.md](MACOS_APP.md)，建立可雙擊的
`dist/Codex Discord Bridge Widget.app`。

## Discord 設定建議

先用一個私人測試伺服器和單一測試頻道，不要一開始就進正式社群。

建議 `.env` 第一版只填：

```text
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_IDS=
DISCORD_CHANNEL_IDS=
DISCORD_THREAD_IDS=
DISCORD_BLOCKED_CHANNEL_IDS=
DISCORD_DM_USER_IDS=
DISCORD_WRITE_USER_IDS=
CODEX_SANDBOX=workspace-write
DISCORD_BATCH_WINDOW_MS=1500
DISCORD_SOLO_BATCH_WINDOW_MS=6000
DISCORD_CONTEXT_LIMIT=0
DISCORD_DELIVERY_MODE=codex
DISCORD_INBOX_FILE=state/frontstage-inbox.ndjson
DISCORD_IMAGE_ATTACHMENT_LIMIT=4
DISCORD_DEV_APPROVAL_MODE=heuristic
```

穩定後再開：

- `DISCORD_PARENT_CHANNEL_IDS`：允許整個 forum/parent 底下的 threads。
- `DISCORD_ALLOWED_BOT_AUTHOR_IDS`：允許指定 AI bot 互相接話。
- `DISCORD_BOT_LOOP_MAX_TURNS`：調整 AI 互聊最多幾輪。

## 踩雷避坑

- 不要把 Discord bot 寫成另一個 AI。它只是橋，不是主體。
- 不要做假旁白或假狀態窗。狀態窗只顯示 runtime log 真實事件。
- 不要預設讀 50 則最近訊息。公開版用 `DISCORD_CONTEXT_LIMIT=0` 最安全。
- 不要用同一個 batching window 處理所有情境。單人連發可以等久一點，群聊才需要短窗口。
- 不要把 DM 私訊開給所有人。只把 `DISCORD_DM_USER_IDS` 給可信使用者。
- 不要讓 Codex 任意上傳任何本機路徑。bridge 只允許 project/tmp 下的檔案。
- 不要把「生圖」寫成假狀態。沒有 configured generator 時，只支援上傳已產生的本機檔案。
- 不要把 `workspace-write` 開給所有人。用 `DISCORD_WRITE_USER_IDS` 鎖住可信使用者，再用 `DISCORD_DEV_APPROVAL_MODE=heuristic` 讓開發/跑程式工作先停下來等 `批准 dev-...`。
- 如果使用者要的是「前台的我」而不是背景代理，請用 inbox mode，不要讓 bridge 直接呼叫 `codex exec` 自動回。
- 如果使用者要看見 Codex task 裡的可見足跡，請用 Discord Watcher +
  Agent Event Stream；不要再做假旁白或只在本機小窗顯示。
- relay 只應有一個 AI adapter 發布回覆；Claude Code 可以讀同一個 inbox 做審閱，但不要和 Codex relay 同時回同一筆訊息。
- 不要只設 allowlist，不設 denylist。正式社群一定會有不該接的房間。
- 不要把 token、server id、私人 prompt、成員名單 commit 上 GitHub。
- 不要讓 AI-bot 無限制互聊。保留 loop guard。
- 不要宣稱 widget 能看見完整 Codex 內部工具。現在只保證看見真實 CLI 輸出事件。
- 不要在正式伺服器第一次測。先在私人測試伺服器跑穩。

## 自用客製化

公開版應該保持中性。自用時再改：

- `.env`：Discord allowlist、write user、sandbox、monitor port。
- 私人 seed：稱呼、語氣、關係設定、使用習慣。
- `src/monitor.js`：小窗標題、徽章、顏色、文字。
- `MEMBER_ROSTER_FILE`：私人成員名單，不要 commit。

建議做法是複製一份私人 seed，例如：

```text
memory/my-private-seed.md
```

然後在 `.env` 設定：

```text
CODEX_SEED_FILE=memory/my-private-seed.md
```

## 公布時可以怎麼說

可以把它介紹成：

> Codex Discord Bridge 是一個本機橋接工具，把 Discord 訊息送到本機
> Codex CLI session，再把回覆送回 Discord。它不是 OpenAI API bot，
> 也不是固定句庫聊天機器人；Discord bot 只是 Codex 的收音、看訊息和
> 發話裝置。

這樣講比較不會讓使用者以為要去改 bot 的死邏輯，真正該調的是
Codex session seed、allowlist、安全權限和 runtime 觀測。
