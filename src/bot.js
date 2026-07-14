import { Client, Events, GatewayIntentBits } from "discord.js";
import { askCodex } from "./codex.js";
import { getConfig } from "./config.js";
import { loadMemberRoster } from "./members.js";

const config = getConfig();
const memberRoster = await loadMemberRoster(config.memberRosterFile);

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
let monitorChannel = null;

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

function shortText(text, limit = 120) {
  const clean = text.replace(/\s+/g, " ").trim();

  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

async function sendMonitor(content) {
  if (!config.monitorEnabled) {
    return;
  }

  try {
    if (!monitorChannel) {
      monitorChannel = await client.channels.fetch(config.monitorChannelId ?? config.channelId);
    }

    if (monitorChannel?.isTextBased()) {
      await monitorChannel.send(`🟣 ${content}`);
    }
  } catch (error) {
    console.warn(`[monitor] failed to send status: ${error.message}`);
  }
}

function formatAuthor(user) {
  const profile = memberRoster.describeUser(user);
  const label = user.bot ? `${user.username} [bot]` : user.tag ?? user.username;

  return profile ? `${label}（${profile}）` : label;
}

function excerptMessageContent(message) {
  const raw = (message.content || "(無文字／可能是圖或貼圖)").replace(/[\r\n]+/g, " ⏎ ");

  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

async function describeReply(message) {
  const referenceId = message.reference?.messageId;

  if (!referenceId || !("messages" in message.channel)) {
    return "";
  }

  try {
    const referenced = await message.channel.messages.fetch(referenceId);
    const isSelf = referenced.author.id === message.client.user?.id;
    const who = isSelf ? "你自己" : formatAuthor(referenced.author);

    return `↩ 這則是在「引用回覆」${who}：「${excerptMessageContent(referenced)}」`;
  } catch {
    return "";
  }
}

async function getRecentContext(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: config.discordContextLimit });
    const contextLines = await Promise.all(
      [...messages.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(async (item) => {
          const author = item.author ? formatAuthor(item.author) : "unknown";
          const content = item.content?.trim() || "[message content unavailable]";
          const replyContext = await describeReply(item);

          return [replyContext, `${author}: ${content}`].filter(Boolean).join("\n");
        })
    );

    return contextLines.join("\n");
  } catch (error) {
    console.warn(`[discord] failed to fetch recent context: ${error.message}`);
    return "";
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[oo-bridge] logged in as ${readyClient.user.tag}`);
  console.log(`[oo-bridge] locked to guild ${config.guildId}, channel ${config.channelId}`);

  const channel = await client.channels.fetch(config.channelId);
  console.log(`[oo-bridge] target channel: #${channel?.name ?? config.channelId}`);
  await sendMonitor(`bridge online：${readyClient.user.tag}，鎖定 #${channel?.name ?? config.channelId}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (message.guildId !== config.guildId || message.channelId !== config.channelId) {
    return;
  }

  const content = cleanMessageText(message);
  const replyContext = await describeReply(message);
  console.log(`[discord] accepted ${message.author.tag}: ${content}`);
  await sendMonitor(`收到 ${message.author.tag}：${shortText(content)}`);

  pendingMessages.push({
    author: message.author.tag,
    authorProfile: memberRoster.describeUser(message.author),
    channel: message.channel?.name ?? message.channelId,
    guild: message.guild?.name ?? message.guildId,
    content,
    replyContext
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
      ? [first.replyContext, first.content].filter(Boolean).join("\n")
      : [
          "以下是同一個 Discord 頻道內短時間連續訊息，請整體理解後自然回覆，不要逐句機械拆答：",
          "",
          ...batch.map((item) =>
            [item.replyContext, `${item.author}: ${item.content}`].filter(Boolean).join("\n")
          )
        ].join("\n");

  codexQueue = codexQueue
    .then(async () => {
      await message.channel.sendTyping();
      await sendMonitor(`合併 ${batch.length} 則訊息，準備讀取最近 ${config.discordContextLimit} 則上下文`);
      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);

      try {
        const recentContext = await getRecentContext(message.channel);
        await sendMonitor("上下文已讀，呼叫 Codex CLI");
        const response = await askCodex(config, {
          author: message.author.tag,
          authorProfile: first.authorProfile,
          channel: first.channel,
          guild: first.guild,
          content,
          recentContext
        });

        await sendMessageChunks(message.channel, response);
        console.log("[codex] replied through Discord.");
        await sendMonitor("Codex 已回覆 Discord");
      } catch (error) {
        console.error("[codex] failed:", error.message);
        if (error.stderr) {
          console.error(error.stderr);
        }
        await sendMonitor(`Codex 回合失敗：${shortText(error.message)}`);
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
