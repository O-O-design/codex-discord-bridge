# Discord Watcher + Agent Event Stream

Discord Watcher is the foreground workflow for bringing a live Codex App task
into Discord. The Discord bot stays a transport layer: microphone, eyes, and
speaker. The active Codex task remains the agent.

This is different from the older background `codex exec` responder and from the
local runtime widget. Watcher pushes public operational events into the selected
Codex task, so the human can see footprints in the Codex UI while Discord chat
is happening.

## What becomes visible

The relay records and mirrors public status such as:

- Discord message intake and batching.
- The selected Codex task and room lease.
- App-server turn start and completion.
- Context compaction start and completion.
- Reasoning/status item phases that app-server exposes.
- Tool start/completion events that app-server exposes.
- Approval-required events.
- Timeout, app-server restart, and recovery events.
- Discord reply sent, skipped, deferred, or discarded after handoff.

It must not expose private chain-of-thought. Treat the stream as operational
status, not a thought transcript.

## Required mode

Use inbox mode plus the frontstage relay:

```dotenv
DISCORD_DELIVERY_MODE=inbox
DISCORD_INBOX_FILE=state/frontstage-inbox.ndjson
DISCORD_WATCHER_LEASE_FILE=state/discord-watcher-lease.json
DISCORD_WATCHER_ANCHOR_FILE=memory/discord-watcher-anchor.local.md

CODEX_APP_THREAD_ID=
CODEX_APP_RELAY_STATE_FILE=state/frontstage-relay-state.json
CODEX_APP_EVENT_LOG_FILE=logs/app-server-events.ndjson
CODEX_APP_EVENT_LOG_ENABLED=true
CODEX_APP_VISIBLE_EVENT_STREAM_ENABLED=true
CODEX_APP_VISIBLE_EVENT_MIN_INTERVAL_MS=700
CODEX_APP_TURN_TIMEOUT_MS=180000
CODEX_APP_RELAY_POLL_MS=1000
CODEX_APP_RELAY_REPLAY_EXISTING=false
CODEX_APP_RELAY_BASELINE_GRACE_MS=30000
```

Start the bot and the frontstage relay:

```sh
npm start
npm run frontstage:relay
```

If you want a persistent local instruction anchor, copy
`memory/discord-watcher-anchor.example.md` to
`memory/discord-watcher-anchor.local.md` and edit it for your household. The
`.local.md` file is ignored by git.

On macOS you can run the relay in tmux with the helper scripts if they are
present in your local checkout.

## Connect a room

Watcher uses a lease so only one foreground Codex task owns the Discord
microphone at a time.

```text
/接麥 3號房 <task-id>  # first registration
/接麥 3號房            # reconnect an existing room
/搬家 4號房 <task-id>  # bind and move to a new task
/搬家 4號房            # move to a previously registered room
/斷麥                  # stop normal Discord delivery
```

Only users in `DISCORD_WRITE_USER_IDS` can run these control commands.

When moving rooms, the old task may finish locally, but its reply must not be
sent to Discord. The relay checks the lease before and after each turn.

## Health checks

Use this first after context compaction, app restart, a long pause, or a blank
frontstage window:

```sh
npm run watcher:status
```

Expected healthy signs:

- `active: yes`
- current room and task id are correct
- pending inbox count eventually returns to `0`
- latest turn start has a matching latest turn done
- latest app turn shows `turn/completed completed`

For a live terminal view:

```sh
npm run watcher:stream
```

This is only a terminal convenience. The important path is the visible event
injection into the Codex task.

## Failure behavior

If a Codex App turn exceeds `CODEX_APP_TURN_TIMEOUT_MS`, the relay records:

```text
frontstage_relay_turn_timeout
frontstage_relay_restarting
frontstage_relay_recovered
```

If the restart fails, it records:

```text
frontstage_relay_restart_failed
frontstage_relay_failed
```

This prevents one stuck app-server turn from silently blocking all later
Discord messages.

## Group-chat behavior

The bridge should not mechanically answer every allowlisted message. A
whitelist grants observation, not an obligation to reply.

Recommended behavior:

- In direct chat, avoid quoting every message back to the same person.
- In group chat, quote only when it clarifies who is being answered.
- Wait and merge rapid short messages from the same speaker.
- If a newer message arrives before the reply is sent, defer or discard the old
  reply and re-evaluate the newer batch.
- Stay silent with `[[discord-silent]]` when the message is not actually calling
  the agent.
- Keep AI-bot loop limits enabled when other bots can talk.

## Test checklist for another household

1. Start in a private test server.
2. Allowlist one channel or thread only.
3. Set `DISCORD_DELIVERY_MODE=inbox`.
4. Start the bot and relay.
5. Register a room with `/接麥 <room> <task-id>`.
6. Send one message and confirm it appears in the Codex task.
7. Send several short messages quickly and confirm they are batched or deferred,
   not answered one by one.
8. Trigger a long or tool-using request and confirm status events are visible.
9. Trigger context compaction if possible and confirm start/completion is
   visible.
10. Run `npm run watcher:status` and confirm pending inbox returns to `0`.

Do not test first in a busy public community.

## Do not publish

Keep these out of a public repository:

- `.env`
- Discord tokens
- private room IDs and server IDs
- personal seed files
- relationship/persona prompts
- member rosters
- logs containing private chat
- `state/`

The public repository should include only generic defaults and examples.
