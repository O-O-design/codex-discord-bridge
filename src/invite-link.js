import { PermissionFlagsBits } from "discord.js";
import { getConfig } from "./env.js";

const { clientId, guildIds } = getConfig({
  requireToken: false,
  requireGuildIds: false
});

const scopes = ["bot", "applications.commands"];
const permissions =
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.ReadMessageHistory;

function buildInviteUrl(guildId) {
  const url = new URL("https://discord.com/oauth2/authorize");

  url.searchParams.set("client_id", clientId);
  url.searchParams.set("permissions", permissions.toString());
  url.searchParams.set("scope", scopes.join(" "));

  if (guildId) {
    url.searchParams.set("guild_id", guildId);
    url.searchParams.set("disable_guild_select", "true");
  }

  return url.toString();
}

console.log("Generic install link:");
console.log(buildInviteUrl());

if (guildIds.length > 0) {
  console.log("");
  console.log("Guild-specific install links:");

  for (const guildId of guildIds) {
    console.log(`${guildId}: ${buildInviteUrl(guildId)}`);
  }
}
