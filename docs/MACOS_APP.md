# macOS desktop app

The macOS desktop app is a real `.app` bundle. Double-clicking it starts the
local bridge services and opens the compact widget view.

## Build

```sh
npm run desktop:mac
```

The app is created at:

```text
dist/Codex Discord Bridge Widget.app
```

You can double-click that app directly. You can also copy it to Desktop or
Applications; the build embeds the project path in the app resources so it can
still find this repository.

## What happens on launch

The app:

1. Finds the project folder.
2. Reads `.env` for `MONITOR_PORT`.
3. Runs `npm install` if `node_modules/` is missing.
4. Runs `npm run seed` if the Codex session file is missing.
5. Starts the bridge tmux session.
6. Starts the monitor tmux session.
7. Waits for `http://127.0.0.1:<port>/health`.
8. Opens `http://127.0.0.1:<port>/widget` in a WebKit window.

## Requirements

- Node.js and npm must be available.
- tmux must be available.
- Codex CLI must be installed and signed in.
- `.env` must exist and include Discord credentials and allowlists.

When launched from Finder, macOS provides a smaller `PATH` than a terminal. The
app adds common Homebrew and system paths before running npm/tmux.

## Troubleshooting

If the app shows an error, check:

```text
logs/bridge.err
logs/monitor.err
```

If you moved the repository after building the app, rebuild it with:

```sh
npm run desktop:mac
```
