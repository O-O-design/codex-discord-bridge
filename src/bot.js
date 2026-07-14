import { Client, Events, GatewayIntentBits } from "discord.js";
import { askCodex } from "./codex.js";
import { getConfig } from "./config.js";

const config = getConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let codexQueue = Promise.resolve();
let batchTimer = null;
let pendingMessages = [];

function cleanMessageText(message) {
  return (
    message.content
      ?.replaceAll(`<@${client.user.id}>`, "@OO")
      .replaceAll(`<@!${client.user.id}>`, "@OO")
      .trim() || "[message content unavailable]"
  );
}

function splitDiscordMessage(content) {
  const chunks = [];
  let remaining = content.trim();

  while (remaining.length > 1900) {
    const splitAt = Math.max(
      remaining.lastIndexOf("\n\n", 1900),
      remaining.lastIndexOf("\n", 1900),
      remaining.lastIndexOf(" ", 1900)
    );
    const index = splitAt > 200 ? splitAt : 1900;

    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendMessageChunks(channel, content) {
  for (const chunk of splitDiscordMessage(content)) {
    await channel.send(chunk);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[oo-bridge] logged in as ${readyClient.user.tag}`);
  console.log(`[oo-bridge] locked to guild ${config.guildId}, channel ${config.channelId}`);

  const channel = await client.channels.fetch(config.channelId);
  console.log(`[oo-bridge] target channel: #${channel?.name ?? config.channelId}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (message.guildId !== config.guildId || message.channelId !== config.channelId) {
    return;
  }

  const content = cleanMessageText(message);
  console.log(`[discord] accepted ${message.author.tag}: ${content}`);

  pendingMessages.push({
    author: message.author.tag,
    channel: message.channel?.name ?? message.channelId,
    guild: message.guild?.name ?? message.guildId,
    content
  });

  if (batchTimer) {
    clearTimeout(batchTimer);
  }

  batchTimer = setTimeout(() => {
    const batch = pendingMessages;
    pendingMessages = [];
    batchTimer = null;

    enqueueCodexBatch(message, batch);
  }, config.discordBatchWindowMs);
});

function enqueueCodexBatch(message, batch) {
  const first = batch[0];
  const content =
    batch.length === 1
      ? first.content
      : [
          "以下是同一個 Discord 頻道內短時間連續訊息，請整體理解後自然回覆，不要逐句機械拆答：",
          "",
          ...batch.map((item) => `${item.author}: ${item.content}`)
        ].join("\n");

  codexQueue = codexQueue
    .then(async () => {
      await message.channel.sendTyping();
      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);

      try {
        const response = await askCodex(config, {
          author: message.author.tag,
          channel: first.channel,
          guild: first.guild,
          content
        });

        await sendMessageChunks(message.channel, response);
        console.log("[codex] replied through Discord.");
      } catch (error) {
        console.error("[codex] failed:", error.message);
        if (error.stderr) {
          console.error(error.stderr);
        }
        await message.channel.send("我這邊叫 Codex CLI 的時候卡住了，先把這回合放掉，下一句可以繼續。");
      } finally {
        clearInterval(typing);
      }
    })
    .catch((error) => {
      console.error("[codex] queue failed:", error);
    });
}

client.on(Events.Error, (error) => {
  console.error("[discord] client error:", error);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.discordToken);
