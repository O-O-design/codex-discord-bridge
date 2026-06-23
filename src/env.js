import "dotenv/config";

function parseIdList(value) {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function getConfig({
  requireToken = true,
  requireClientId = true,
  requireGuildIds = false,
  requireAllowedUserIds = requireToken
} = {}) {
  const guildIds = [
    ...parseIdList(process.env.DISCORD_GUILD_IDS),
    ...parseIdList(process.env.DISCORD_GUILD_ID)
  ];
  const watchedChannelIds = parseIdList(process.env.DISCORD_WATCH_CHANNEL_IDS);
  const publicChannelIds = parseIdList(process.env.DISCORD_PUBLIC_CHANNEL_IDS);
  const allowedUserIds = parseIdList(process.env.DISCORD_ALLOWED_USER_IDS);
  const triggerNames = parseIdList(process.env.DISCORD_TRIGGER_NAMES);
  const publicBotCallNames = parseIdList(process.env.DISCORD_PUBLIC_BOT_CALL_NAMES);

  const config = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildIds: [...new Set(guildIds)],
    watchedChannelIds: [...new Set(watchedChannelIds)],
    publicChannelIds: [...new Set(publicChannelIds)],
    publicModeEnabled:
      (process.env.DISCORD_PUBLIC_MODE_ENABLED || "false").toLowerCase() === "true",
    publicDecisionCooldownMs:
      Number.parseInt(process.env.DISCORD_PUBLIC_DECISION_COOLDOWN_SECONDS || "30", 10) *
      1_000,
    publicMaxConsecutiveBotTurns: Number.parseInt(
      process.env.DISCORD_PUBLIC_MAX_CONSECUTIVE_BOT_TURNS || "3",
      10
    ),
    activityType: (process.env.DISCORD_ACTIVITY_TYPE || "CUSTOM").toUpperCase(),
    activityText: process.env.DISCORD_ACTIVITY_TEXT || "",
    imageMaxCount: Number.parseInt(process.env.DISCORD_IMAGE_MAX_COUNT || "4", 10),
    imageMaxBytes: Number.parseInt(
      process.env.DISCORD_IMAGE_MAX_BYTES || "10485760",
      10
    ),
    allowedUserIds: [...new Set(allowedUserIds)],
    triggerNames: [...new Set(triggerNames)],
    botDisplayName: process.env.DISCORD_BOT_DISPLAY_NAME || triggerNames[0] || "AI伴侶",
    ownerDisplayName: process.env.DISCORD_OWNER_DISPLAY_NAME || "使用者",
    publicBotCallNames: [
      ...new Set(publicBotCallNames.length > 0 ? publicBotCallNames : triggerNames)
    ],
    codexCliPath:
      process.env.CODEX_CLI_PATH || "/Applications/Codex.app/Contents/Resources/codex",
    codexSessionFile: process.env.CODEX_SESSION_FILE || ".codex-discord-session",
    codexSessionStateFile:
      process.env.CODEX_SESSION_STATE_FILE || ".private/session-state.json",
    codexMaxSessionTurns: Number.parseInt(
      process.env.CODEX_MAX_SESSION_TURNS || "50",
      10
    ),
    codexHistoryFile:
      process.env.CODEX_HISTORY_FILE || ".private/conversation-history.jsonl",
    codexHistoryTurns: Number.parseInt(process.env.CODEX_HISTORY_TURNS || "12", 10),
    codexSummaryFile:
      process.env.CODEX_SUMMARY_FILE || ".private/recent-summary.md",
    codexSummaryEveryTurns: Number.parseInt(
      process.env.CODEX_SUMMARY_EVERY_TURNS || "20",
      10
    ),
    codexSandbox: process.env.CODEX_SANDBOX || "read-only",
    codexWorkdir: process.env.CODEX_WORKDIR || ".private",
    codexPeopleFile: process.env.CODEX_PEOPLE_FILE || ".private/people.md",
    codexPublicWorkdir: process.env.CODEX_PUBLIC_WORKDIR || ".public",
    codexPublicSessionFile:
      process.env.CODEX_PUBLIC_SESSION_FILE || ".public/codex-session",
    codexPublicSessionStateFile:
      process.env.CODEX_PUBLIC_SESSION_STATE_FILE || ".public/session-state.json",
    codexPublicHistoryFile:
      process.env.CODEX_PUBLIC_HISTORY_FILE || ".public/conversation-history.jsonl",
    codexPublicSummaryFile:
      process.env.CODEX_PUBLIC_SUMMARY_FILE || ".public/memory-summary.md"
  };

  const missing = [];

  if (requireToken && !config.token) {
    missing.push("DISCORD_TOKEN");
  }

  if (requireClientId && !config.clientId) {
    missing.push("DISCORD_CLIENT_ID");
  }

  if (requireGuildIds && config.guildIds.length === 0) {
    missing.push("DISCORD_GUILD_IDS");
  }

  if (requireAllowedUserIds && config.allowedUserIds.length === 0) {
    missing.push("DISCORD_ALLOWED_USER_IDS");
  }

  if (missing.length > 0) {
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
  }

  return config;
}
