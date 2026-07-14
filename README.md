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
- Parent channels: `1500130334434529352`
- Threads: `1507476386758004958`

## 啟動

```sh
npm install
npm run seed
npm start
```

`npm run seed` 會建立或覆蓋 `state/codex-session`，讓 Discord bridge 後續 resume 同一條 Codex session。

## 開發檢查

```sh
npm run check
```

## 對話節流

- `DISCORD_BATCH_WINDOW_MS`：連續訊息合併視窗，預設 `1500`。
- `CODEX_TIMEOUT_MS`：單次 Codex CLI 最長等待時間，預設 `90000`。
- `DISCORD_CONTEXT_LIMIT`：每次回覆前讀取的最近頻道訊息數，預設 `10`。
- `BRIDGE_LOG_FILE`：本機 runtime log 檔，預設 `logs/bridge.ndjson`，不發到 Discord、不進 git。
- `BRIDGE_LOG_MESSAGE_LIMIT`：每筆 log 裡訊息與回覆摘要的最大字數，預設 `800`。
- `MEMBER_ROSTER_FILE`：私有成員清單 CSV 路徑，不進 git。
- `DISCORD_GUILD_IDS`：允許反應的伺服器 ID，以逗號分隔。
- `DISCORD_CHANNEL_IDS`：允許反應的一般頻道 ID，以逗號分隔。
- `DISCORD_PARENT_CHANNEL_IDS`：允許其底下 thread/post 反應的 parent channel 或 forum ID，以逗號分隔。
- `DISCORD_THREAD_IDS`：允許反應的 thread ID，以逗號分隔。
- `DISCORD_ALLOWED_BOT_AUTHOR_IDS`：允許讀取的其他 bot 作者 ID，以逗號分隔；目前包含歐德 `1484555705720766585`。bridge 永遠不讀自己的訊息，避免自我回音。
- `DISCORD_WRITE_USER_IDS`：允許使用 `CODEX_SANDBOX` 寫入權限的 Discord user ID，以逗號分隔；不在清單內的發言一律用 `read-only` 呼叫 Codex。
- `CODEX_SANDBOX`：Codex CLI sandbox，預設 `workspace-write`，讓 Discord 端呼叫的 Codex 可以改這個工作區；只接受 `read-only`、`workspace-write`、`danger-full-access`。

如果 Codex CLI 單回合卡住，bridge 會殺掉該回合並回報卡住，避免整條 Discord queue 死鎖。

Runtime log 會記錄實際後台事件：bridge 啟動、收到允許位置的訊息、讀取最近上下文、呼叫 Codex、回覆成功或錯誤。它是本機排錯與查看狀態用，不是 Discord 旁白，也不顯示模型私密推理。

讀取最近訊息需要 bot 在目標頻道具備讀取訊息歷史與訊息內容權限；如果抓取失敗，bridge 會降級成只回覆當前批次。

如果使用者用 Discord 的「引用回覆」，bridge 會嘗試抓取被引用訊息，並在 prompt 裡補上 `↩ 這則是在「引用回覆」...`。抓不到時會安靜略過。

成員清單支援欄位：`所屬群組, ID, 名稱, 性別, 伴侶, 底層邏輯, 備註`。bridge 會用 Discord author id 對應身份，將摘要放進 Codex prompt；原始 CSV 應保持私有。
