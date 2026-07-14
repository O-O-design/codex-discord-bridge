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

function listEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function currentCodexSandbox() {
  const value = process.env.CODEX_SANDBOX?.trim();
  const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);

  return value && allowed.has(value) ? value : "workspace-write";
}

export function getConfig({ requireDiscord = true } = {}) {
  const codexSessionFile = process.env.CODEX_SESSION_FILE?.trim() || "state/codex-session";
  const memberRosterFile = process.env.MEMBER_ROSTER_FILE?.trim();
  const legacyGuildId = process.env.DISCORD_GUILD_ID?.trim();
  const legacyChannelId = process.env.DISCORD_CHANNEL_ID?.trim();
  const guildIds = listEnv("DISCORD_GUILD_IDS");
  const channelIds = listEnv("DISCORD_CHANNEL_IDS");
  const parentChannelIds = listEnv("DISCORD_PARENT_CHANNEL_IDS");
  const threadIds = listEnv("DISCORD_THREAD_IDS");

  const config = {
    discordToken: process.env.DISCORD_TOKEN?.trim(),
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim(),
    guildIds: guildIds.length > 0 ? guildIds : legacyGuildId ? [legacyGuildId] : [],
    channelIds: channelIds.length > 0 ? channelIds : legacyChannelId ? [legacyChannelId] : [],
    parentChannelIds,
    threadIds,
    codexCliPath:
      process.env.CODEX_CLI_PATH?.trim() || "/Applications/Codex.app/Contents/Resources/codex",
    codexSessionFile: resolve(process.cwd(), codexSessionFile),
    codexSandbox: currentCodexSandbox(),
    codexTimeoutMs: intEnv("CODEX_TIMEOUT_MS", 90_000),
    discordBatchWindowMs: intEnv("DISCORD_BATCH_WINDOW_MS", 1_500),
    discordContextLimit: intEnv("DISCORD_CONTEXT_LIMIT", 10),
    memberRosterFile: memberRosterFile ? resolve(process.cwd(), memberRosterFile) : null,
    allowedBotAuthorIds: listEnv("DISCORD_ALLOWED_BOT_AUTHOR_IDS"),
    writeUserIds: listEnv("DISCORD_WRITE_USER_IDS")
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
