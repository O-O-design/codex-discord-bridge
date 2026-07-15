# Open-source release checklist

This repository is being prepared as `codex-discord-bridge`.

The public framing should stay clear: this project is a Discord input/output
bridge for a local Codex CLI session. The Discord bot is the transport layer,
not a separate chatbot personality.

## Before publishing

- Choose a license and replace `UNLICENSED` in `package.json`.
- Confirm `.env` is not committed.
- Confirm `state/`, `logs/`, `dist/`, and `node_modules/` are not committed.
- Keep private personas, memory files, Discord IDs, and member rosters outside
  the public repository.
- Use `memory/default-seed.md` for the public default seed.
- Put private seed prompts in an ignored local file and set `CODEX_SEED_FILE`.
- Replace any local room names, guild IDs, channel IDs, or user IDs with
  placeholders in docs and examples.
- Link users to [PUBLISHING_GUIDE.md](PUBLISHING_GUIDE.md) for setup framing,
  pitfalls, and the recommended public explanation.

## Supported local surfaces

- macOS: tmux launchers and the Swift/WebKit widget wrapper.
- Windows: PowerShell launchers and browser-based monitor/widget views.
- Linux: npm scripts are expected to work, but no desktop launcher has been
  prepared yet.

## Not included yet

- A packaged Windows desktop app installer.
- A signed macOS app.
- Automatic Discord application creation.
- Stable parsing of Codex internal tool names.
