# Codex Discord Bridge

This project connects a Discord bot to the local Codex CLI. It lets a user talk to Codex from Discord while the Mac running the bot is awake.

## What It Is

The bridge is not an OpenAI API chatbot. It uses the signed-in local Codex CLI:

```text
Discord message
  -> discord.js bot
  -> local codex exec
  -> Codex final response
  -> Discord message
```

The Discord side uses its own Codex CLI session, stored in `.codex-discord-session`. It is not the same live conversation as a Codex desktop app window, but it uses the same local Codex install, account, repo folder, and CLI state.

## Current Behavior

- Direct messages to the bot are sent to Codex.
- Server messages are sent to Codex when the bot is mentioned.
- Channel or thread IDs listed in `DISCORD_WATCH_CHANNEL_IDS` are always watched, so users can talk there without mentioning the bot.
- Replies are sent as normal channel messages, not Discord reply UI.
- Codex calls are queued one at a time to avoid overlapping CLI sessions.

## Important Files

- `src/bot.js` starts the Discord client, filters messages, queues Codex calls, and sends replies.
- `src/codex-runner.js` shells out to `codex exec` or `codex exec resume`.
- `src/env.js` reads `.env` safely.
- `src/invite-link.js` prints install links.
- `src/register-commands.js` registers the optional `/ping` command.
- `.env.example` documents required local settings.

## Environment

Create `.env` from `.env.example`.

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=<your-discord-application-client-id>
DISCORD_GUILD_IDS=<guild-id-1>,<guild-id-2>
DISCORD_WATCH_CHANNEL_IDS=<channel-or-thread-id>
CODEX_CLI_PATH=/Applications/Codex.app/Contents/Resources/codex
CODEX_SESSION_FILE=.codex-discord-session
CODEX_SANDBOX=read-only
```

Never commit `.env`. It contains the Discord bot token and may contain private server, channel, or thread IDs.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the bot permissions needed for reading and sending messages.
3. Enable Message Content Intent if the bot should read normal guild channel messages.
4. Put the token and client ID in `.env`.
5. Install dependencies:

```sh
npm install
```

6. Generate install links:

```sh
npm run invite
```

7. Install the bot into the target server.

8. Optional: register `/ping` for one guild:

```sh
npm run register -- <guild-id>
```

9. Start the bridge:

```sh
npm start
```

## Restart

Stop the running process with `Ctrl-C`, then run:

```sh
npm run check
npm start
```

The Mac must stay awake and the `npm start` process must keep running. If the Mac sleeps, shuts down, loses network, or the process exits, the Discord bot stops replying.

## Known Pitfalls

- `Missing Access` while registering commands usually means the bot has not been installed into that guild yet.
- Network or DNS failures inside a sandbox can block Discord API and Gateway calls. Run the bot with normal local network access.
- `codex exec` needs access to local Codex state under `~/.codex`. A sandbox that cannot write there will fail.
- This Codex CLI version showed `--ask-for-approval` in help but rejected it in `codex exec`; the bridge does not pass that flag.
- Guild messages need Message Content Intent and either an `@bot` mention or a watched channel/thread ID.
- Thread IDs work as channel IDs for `DISCORD_WATCH_CHANNEL_IDS`.
- The Discord Codex session is separate from the desktop app conversation. Its continuity comes from `.codex-discord-session`.
- Only one Codex CLI request runs at a time. Rapid Discord messages queue up.

## GitHub Notes

Commit the project files and `.env.example`, but not `.env` or `.codex-discord-session`.

Recommended checks before publishing:

```sh
npm run check
git status -sb
```
