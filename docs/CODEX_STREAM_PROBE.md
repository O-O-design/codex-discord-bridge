# Codex stream probe

The bridge can now record real Codex CLI stdout/stderr activity as
`codex_cli_output` runtime events. These events prove that Codex is actively
doing work, but they do not claim a specific tool name unless the CLI output
contains a stable signal.

Use the probe script to inspect what the current Codex CLI emits:

```sh
npm run probe:codex-stream -- "Reply with one short sentence."
```

To test a tool-heavy action, pass a prompt that should require that tool:

```sh
npm run probe:codex-stream -- "Search the web for the current OpenAI docs home page and summarize the title."
```

The script writes:

```text
logs/codex-stream-probe.ndjson
logs/codex-stream-probe-output.txt
```

Only promote a probe pattern into the widget UI when it is stable across several
runs. Until then, the UI should use generic true states such as:

- `Codex 有新的執行輸出`
- `Codex 處理中`
- `已回覆 Discord`

