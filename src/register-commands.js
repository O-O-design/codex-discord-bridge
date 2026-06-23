import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { getConfig } from "./env.js";

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check whether the bridge is alive.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("session")
    .setDescription("Show the bridge's current private and public session status.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("newsession")
    .setDescription("Rotate the bridge to a fresh session while keeping recent memory.")
    .toJSON()
];

const { token, clientId, guildIds: configuredGuildIds } = getConfig({
  requireAllowedUserIds: false
});
const guildIds = process.argv.slice(2).filter(Boolean);
const targetGuildIds = guildIds.length > 0 ? guildIds : configuredGuildIds;
const rest = new REST({ version: "10" }).setToken(token);

try {
  if (targetGuildIds.length > 0) {
    for (const guildId of targetGuildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands
      });

      console.log(`Registered ${commands.length} command(s) for guild ${guildId}.`);
    }
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(
      `Registered ${commands.length} global command(s). Global commands may take time to appear.`
    );
  }
} catch (error) {
  console.error("Failed to register slash commands.");
  console.error(error);
  process.exitCode = 1;
}
