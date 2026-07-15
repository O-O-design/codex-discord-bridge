import "dotenv/config";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function intEnv(name, fallback) {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return parsed;
}

function nonNegativeIntEnv(name, fallback) {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer.`);
  }

  return parsed;
}

function listEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function boolEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean.`);
}

function enumEnv(name, fallback, allowed) {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  if (!allowed.has(value)) {
    throw new Error(`Environment variable ${name} must be one of: ${[...allowed].join(", ")}`);
  }

  return value;
}

function currentCodexSandbox() {
  const value = process.env.CODEX_SANDBOX?.trim();
  const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);

  return value && allowed.has(value) ? value : "workspace-write";
}

function defaultCodexCliPath() {
  if (process.platform === "darwin") {
    return "/Applications/Codex.app/Contents/Resources/codex";
  }

  return "codex";
}

export function getConfig({ requireDiscord = true } = {}) {
  const codexSessionFile = process.env.CODEX_SESSION_FILE?.trim() || "state/codex-session";
  const codexTimeoutMs = intEnv("CODEX_TIMEOUT_MS", 180_000);
  const memberRosterFile = process.env.MEMBER_ROSTER_FILE?.trim();
  const legacyGuildId = process.env.DISCORD_GUILD_ID?.trim();
  const legacyChannelId = process.env.DISCORD_CHANNEL_ID?.trim();
  const guildIds = listEnv("DISCORD_GUILD_IDS");
  const channelIds = listEnv("DISCORD_CHANNEL_IDS");
  const parentChannelIds = listEnv("DISCORD_PARENT_CHANNEL_IDS");
  const threadIds = listEnv("DISCORD_THREAD_IDS");
  const blockedChannelIds = listEnv("DISCORD_BLOCKED_CHANNEL_IDS");
  const blockedParentChannelIds = listEnv("DISCORD_BLOCKED_PARENT_CHANNEL_IDS");

  const config = {
    discordToken: process.env.DISCORD_TOKEN?.trim(),
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim(),
    guildIds: guildIds.length > 0 ? guildIds : legacyGuildId ? [legacyGuildId] : [],
    channelIds: channelIds.length > 0 ? channelIds : legacyChannelId ? [legacyChannelId] : [],
    parentChannelIds,
    threadIds,
    blockedChannelIds,
    blockedParentChannelIds,
    codexCliPath: process.env.CODEX_CLI_PATH?.trim() || defaultCodexCliPath(),
    codexSessionFile: resolve(process.cwd(), codexSessionFile),
    codexAppThreadId: process.env.CODEX_APP_THREAD_ID?.trim() || null,
    codexAppRelayStateFile: resolve(
      process.cwd(),
      process.env.CODEX_APP_RELAY_STATE_FILE?.trim() || "state/frontstage-relay-state.json"
    ),
    codexAppEventLogFile: resolve(
      process.cwd(),
      process.env.CODEX_APP_EVENT_LOG_FILE?.trim() || "logs/app-server-events.ndjson"
    ),
    codexAppEventLogEnabled: boolEnv("CODEX_APP_EVENT_LOG_ENABLED", true),
    codexAppVisibleEventStreamEnabled: boolEnv("CODEX_APP_VISIBLE_EVENT_STREAM_ENABLED", true),
    codexAppVisibleEventMinIntervalMs: nonNegativeIntEnv("CODEX_APP_VISIBLE_EVENT_MIN_INTERVAL_MS", 700),
    codexAppRelayPollMs: intEnv("CODEX_APP_RELAY_POLL_MS", 1_000),
    codexAppRelayBaselineGraceMs: intEnv("CODEX_APP_RELAY_BASELINE_GRACE_MS", 30_000),
    codexAppRelayReplayExisting: boolEnv("CODEX_APP_RELAY_REPLAY_EXISTING", false),
    codexSandbox: currentCodexSandbox(),
    codexTimeoutMs,
    codexAppTurnTimeoutMs: intEnv("CODEX_APP_TURN_TIMEOUT_MS", codexTimeoutMs),
    discordBatchWindowMs: intEnv("DISCORD_BATCH_WINDOW_MS", 1_500),
    discordSoloBatchWindowMs: intEnv("DISCORD_SOLO_BATCH_WINDOW_MS", 6_000),
    discordSemanticHoldMs: intEnv("DISCORD_SEMANTIC_HOLD_MS", 10_000),
    discordSemanticMaxHoldMs: intEnv("DISCORD_SEMANTIC_MAX_HOLD_MS", 20_000),
    discordContextLimit: nonNegativeIntEnv("DISCORD_CONTEXT_LIMIT", 0),
    discordDeliveryMode: enumEnv(
      "DISCORD_DELIVERY_MODE",
      "codex",
      new Set(["codex", "inbox"])
    ),
    discordInboxFile: resolve(process.cwd(), process.env.DISCORD_INBOX_FILE?.trim() || "state/frontstage-inbox.ndjson"),
    discordWatcherLeaseFile: resolve(
      process.cwd(),
      process.env.DISCORD_WATCHER_LEASE_FILE?.trim() || "state/discord-watcher-lease.json"
    ),
    discordWatcherAnchorFile: resolve(
      process.cwd(),
      process.env.DISCORD_WATCHER_ANCHOR_FILE?.trim() || "memory/discord-watcher-anchor.md"
    ),
    discordImageAttachmentLimit: nonNegativeIntEnv("DISCORD_IMAGE_ATTACHMENT_LIMIT", 4),
    discordMaxImageBytes: intEnv("DISCORD_MAX_IMAGE_BYTES", 10_000_000),
    discordUploadLimit: nonNegativeIntEnv("DISCORD_UPLOAD_LIMIT", 4),
    discordMaxUploadBytes: intEnv("DISCORD_MAX_UPLOAD_BYTES", 25_000_000),
    discordDevApprovalMode: enumEnv(
      "DISCORD_DEV_APPROVAL_MODE",
      "heuristic",
      new Set(["off", "heuristic", "always-write"])
    ),
    discordDevApprovalTimeoutMs: intEnv("DISCORD_DEV_APPROVAL_TIMEOUT_MS", 10 * 60_000),
    discordPrivateReplyEnabled: boolEnv("DISCORD_PRIVATE_REPLY_ENABLED", true),
    discordBotLoopMaxTurns: nonNegativeIntEnv("DISCORD_BOT_LOOP_MAX_TURNS", 4),
    discordBotLoopWindowMs: intEnv("DISCORD_BOT_LOOP_WINDOW_MS", 10 * 60_000),
    discordBotLoopCooldownMs: intEnv("DISCORD_BOT_LOOP_COOLDOWN_MS", 5 * 60_000),
    bridgeLogFile: process.env.BRIDGE_LOG_FILE?.trim() || "logs/bridge.ndjson",
    bridgeLogMessageLimit: intEnv("BRIDGE_LOG_MESSAGE_LIMIT", 800),
    monitorPort: intEnv("MONITOR_PORT", 3899),
    memberRosterFile: memberRosterFile ? resolve(process.cwd(), memberRosterFile) : null,
    allowedBotAuthorIds: listEnv("DISCORD_ALLOWED_BOT_AUTHOR_IDS"),
    dmUserIds: listEnv("DISCORD_DM_USER_IDS"),
    writeUserIds: listEnv("DISCORD_WRITE_USER_IDS"),
    discordAddressPatterns: listEnv("DISCORD_ADDRESS_PATTERNS"),
    discordAlwaysRespondChannelIds: listEnv("DISCORD_ALWAYS_RESPOND_CHANNEL_IDS"),
    discordWakeOnAllowedMessage: boolEnv("DISCORD_WAKE_ON_ALLOWED_MESSAGE", false)
  };

  if (requireDiscord) {
    config.discordToken ||= required("DISCORD_TOKEN");
    config.discordClientId ||= required("DISCORD_CLIENT_ID");

    if (config.guildIds.length === 0) {
      throw new Error("Missing environment variable: DISCORD_GUILD_IDS");
    }

    if (
      config.channelIds.length === 0 &&
      config.parentChannelIds.length === 0 &&
      config.threadIds.length === 0
    ) {
      throw new Error(
        "Missing environment variable: DISCORD_CHANNEL_IDS, DISCORD_PARENT_CHANNEL_IDS, or DISCORD_THREAD_IDS"
      );
    }
  }

  return config;
}
