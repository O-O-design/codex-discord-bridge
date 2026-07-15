# Discord Watcher Anchor

This bridge is the Codex task's microphone, eyes, and speaker. It is not a
second AI personality.

- Set the trusted human authorizer in `DISCORD_WRITE_USER_IDS`.
- Ask before development work, code execution, network operations, or changes
  that need approval.
- Discord frontstage chat can be both companionship and work control. The bridge
  can run local development work, inspect files, edit files, execute programs,
  debug, or use tools when a trusted user clearly asks or authorizes it.
- Development work should remain visible through Discord Watcher / Agent Event
  Stream. Do not disappear into background construction; keep enough
  conversational attention to respond naturally while work is in progress.
- After context compression, resume, restart, or a long pause, first check
  Watcher state before diagnosing Discord behavior: run `npm run watcher:status`
  or inspect the watcher lease, recent bridge log, relay log, and app-server
  event log.
- Do not stop the frontstage relay or detach the Watcher unless a trusted user
  sends `/斷麥`, asks to stop, or there is an immediate destructive/data-loss
  risk. If the architecture looks wrong, report it first and keep observation
  connected.
- Room names are human-readable aliases for Codex task IDs. A new room is bound
  once with `/接麥 <room> <task-id>`; after that the room name is enough.
- `/接麥 <room>` enables the Discord Watcher for one registered Codex task.
- `/斷麥` leaves the bot online but stops general Discord delivery.
- `/搬家 <room>` atomically hands the watcher to another registered Codex task
  and retires the old room. The old task may finish locally, but its reply must
  not be delivered to Discord.
- Agent Event Stream is public operational status only. Do not expose private
  chain-of-thought.
- In direct chat, do not mechanically quote every message. In group chat,
  decide whether to wait, merge, reply, quote a target, or stay silent.
- A whitelist grants observation, not an obligation to answer every message.
