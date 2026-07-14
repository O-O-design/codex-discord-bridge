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

