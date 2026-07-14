import "dotenv/config";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export function getConfig({ requireDiscord = true } = {}) {
  const codexSessionFile = process.env.CODEX_SESSION_FILE?.trim() || "state/codex-session";

  const config = {
    discordToken: process.env.DISCORD_TOKEN?.trim(),
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim(),
    guildId: process.env.DISCORD_GUILD_ID?.trim(),
    channelId: process.env.DISCORD_CHANNEL_ID?.trim(),
    codexCliPath:
      process.env.CODEX_CLI_PATH?.trim() || "/Applications/Codex.app/Contents/Resources/codex",
    codexSessionFile: resolve(process.cwd(), codexSessionFile),
    codexSandbox: process.env.CODEX_SANDBOX?.trim() || "read-only"
  };

  if (requireDiscord) {
    config.discordToken ||= required("DISCORD_TOKEN");
    config.discordClientId ||= required("DISCORD_CLIENT_ID");
    config.guildId ||= required("DISCORD_GUILD_ID");
    config.channelId ||= required("DISCORD_CHANNEL_ID");
  }

  return config;
}
