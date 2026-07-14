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

- 只處理 `.env` 指定的 `DISCORD_GUILD_ID` 和 `DISCORD_CHANNEL_ID`。
- 不處理 DM。
- 不處理其他頻道或其他伺服器。
- 不提交 `.env`、`state/` session、token。
- 歐歐根和私人資料不直接讀整包，只使用允許整理後的安全入口。
- 旁白狀態只顯示外部動作，不顯示 Codex 私密推理。

## 設定

```sh
cp .env.example .env
```

填入 Discord bot token、client id。預設測試位置：

- Guild: `1438141616505229416`
- Channel: `1526559984786084032`

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
- `MEMBER_ROSTER_FILE`：私有成員清單 CSV 路徑，不進 git。
- `DISCORD_OWNER_USER_ID`：老婆的 Discord user id；符合時旁白會稱呼「老婆」。
- `DISCORD_NARRATION_ENABLED`：是否送出動作旁白訊息，預設 `false`。
- `DISCORD_NARRATION_CHANNEL_ID`：旁白送往的頻道；空白時送到目標對話頻道。

如果 Codex CLI 單回合卡住，bridge 會殺掉該回合並回報卡住，避免整條 Discord queue 死鎖。

讀取最近訊息需要 bot 在目標頻道具備讀取訊息歷史與訊息內容權限；如果抓取失敗，bridge 會降級成只回覆當前批次。

如果使用者用 Discord 的「引用回覆」，bridge 會嘗試抓取被引用訊息，並在 prompt 裡補上 `↩ 這則是在「引用回覆」...`。抓不到時會安靜略過。

旁白會用同一則訊息更新目前外部動作，例如正在接話、讀上下文、整理回覆、已回完或卡住；它不是工程狀態燈，也不會顯示 Codex 私密推理。

成員清單支援欄位：`所屬群組, ID, 名稱, 性別, 伴侶, 底層邏輯, 備註`。bridge 會用 Discord author id 對應身份，將摘要放進 Codex prompt；原始 CSV 應保持私有。
