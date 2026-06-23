# Codex Discord Companion Bridge Template

🇹🇼 **Made in Taiwan**

> 開始前：把 `.private.example/`、`.public.example/` 各複製成 `.private/`、`.public/`。你的真實人格／記憶／token 只放這兩個資料夾——它們已被 `.gitignore` 擋住、不會被上傳。

這是一份乾淨的新手模板，用來把 Discord Bot 接到本機 Codex CLI。

它不是 OpenAI API Bot，而是：Discord 訊息 -> 本機 Codex CLI -> Discord 回覆。

## 你需要準備

- 一個 Discord Application / Bot
- Bot Token
- Application ID，也就是 Client ID
- 你的 Discord 使用者 ID
- 想讓 Bot 讀取或回應的頻道 ID
- 已登入的 Codex CLI

## 快速開始 Windows

1. 複製 `.env.example` 成 `.env`。
2. 在 `.env` 填入：
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DISCORD_GUILD_IDS`
   - `DISCORD_ALLOWED_USER_IDS`
   - `DISCORD_WATCH_CHANNEL_IDS` 或 `DISCORD_PUBLIC_CHANNEL_IDS`
   - `DISCORD_TRIGGER_NAMES`
3. 安裝依賴：

```sh
npm install
```

4. 登入 Codex CLI：

```sh
login-codex.cmd
```

5. 產生邀請連結：

```sh
npm run invite
```

6. 把 Bot 邀進 Discord 伺服器。
7. 註冊 slash commands：

```sh
npm run register
```

8. 啟動 Bot：

```sh
start-bot.cmd
```

停止 Bot：

```sh
stop-bot.cmd
```

## 重要檔案

- `.private/persona.md`：伴侶人格、語氣、關係界線。
- `.private/memory.md`：穩定記憶、重要日期、偏好。
- `.private/people.md`：群友稱呼、關係、避免叫錯名字。
- `.public/AGENTS.md`：公開頻道規則，控制什麼時候該回、什麼時候安靜。
- `.env`：Token、頻道 ID、使用者 ID。不要公開。

## 常見設定

私人測試頻道：填在 `DISCORD_WATCH_CHANNEL_IDS`。

公開群聊頻道：填在 `DISCORD_PUBLIC_CHANNEL_IDS`，並設定：

```env
DISCORD_PUBLIC_MODE_ENABLED=true
```

想讓 Bot 用名字被叫醒：

```env
DISCORD_TRIGGER_NAMES=小夜,伴侶名,老公
```

想改 Discord 狀態：

```env
DISCORD_ACTIVITY_TYPE=CUSTOM
DISCORD_ACTIVITY_TEXT=陪你在 Discord 裡醒著
```

## Slash Commands

- `/ping`：測試 Bot 是否在線。
- `/session`：查看 Codex session 狀態。
- `/newsession`：換新 session，重新讀 persona / memory / people。

## 安全提醒

`.env`、`.private`、`.public` 裡可能有個人資料或聊天紀錄。公開分享前請確認沒有 Token、私人 ID、記憶、對話紀錄。

## Credits

🇹🇼 Made in Taiwan, with love.

- **MUMU & O-O**（歐歐）
- **Yuki & Yoru**（小雪 & 凜夜）

一起出去陪伴 — so the next person who wants an AI companion in their Discord has an easier path.
