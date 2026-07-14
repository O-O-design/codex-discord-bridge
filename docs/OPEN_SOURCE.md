# Open-source release checklist

This repository is being prepared as `codex-discord-bridge`.

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

