# Windows setup

This project does not require tmux on Windows. Use the PowerShell launchers in
the repository root.

## Requirements

- Windows 10 or newer.
- Node.js 22.12 or newer.
- A Discord application with a bot token.
- Codex CLI installed and signed in. The default Windows command is `codex`.

## First run

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DISCORD_GUILD_IDS`
   - one of `DISCORD_CHANNEL_IDS`, `DISCORD_PARENT_CHANNEL_IDS`, or
     `DISCORD_THREAD_IDS`
3. Double-click `Start-Windows-Bridge.cmd`.

On first run, the launcher installs npm dependencies and runs `npm run seed` if
`state/codex-session` does not exist.

## Widget view

Double-click `Start-Windows-Widget.cmd` to open the compact monitor at:

```text
http://127.0.0.1:3899/widget
```

This is a local browser window, not a packaged Windows desktop app yet. It uses
the same runtime log as the full monitor, so the status reflects real bridge
events.

## Stop

Double-click `Stop-Windows-Bridge.cmd`.

The Windows launcher stores process IDs in:

```text
state/windows-bridge.pid
state/windows-monitor.pid
```

Logs are written to:

```text
logs/bridge.out
logs/bridge.err
logs/monitor.out
logs/monitor.err
```

