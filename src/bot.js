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
const allowedGuildIds = new Set(config.guildIds);
const allowedChannelIds = new Set(config.channelIds);
const allowedThreadIds = new Set(config.threadIds);
const pendingBatches = new Map();

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

function isAllowedMessage(message) {
  if (!message.guildId || !allowedGuildIds.has(message.guildId)) {
    return false;
  }

  return allowedChannelIds.has(message.channelId) || allowedThreadIds.has(message.channelId);
}

function channelLabel(message) {
  const name = message.channel?.name ?? message.channelId;

  return message.channel?.isThread?.() && message.channel.parent?.name
    ? `${message.channel.parent.name} / ${name}`
    : name;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[oo-bridge] logged in as ${readyClient.user.tag}`);
  console.log(`[oo-bridge] allowed guilds: ${config.guildIds.join(", ")}`);
  console.log(`[oo-bridge] allowed channels: ${config.channelIds.join(", ") || "(none)"}`);
  console.log(`[oo-bridge] allowed threads: ${config.threadIds.join(", ") || "(none)"}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!isAllowedMessage(message)) {
    return;
  }

  const content = cleanMessageText(message);
  const replyContext = await describeReply(message);
  console.log(`[discord] accepted ${message.author.tag}: ${content}`);

  const batchKey = `${message.guildId}:${message.channelId}`;
  const batch = pendingBatches.get(batchKey) ?? {
    messages: [],
    timer: null,
    triggerMessage: message
  };

  batch.messages.push({
    author: message.author.tag,
    authorProfile: memberRoster.describeUser(message.author),
    channel: channelLabel(message),
    guild: message.guild?.name ?? message.guildId,
    content,
    replyContext
  });
  batch.triggerMessage = message;

  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  batch.timer = setTimeout(() => {
    pendingBatches.delete(batchKey);

    enqueueCodexBatch(batch.triggerMessage, batch.messages);
  }, config.discordBatchWindowMs);

  pendingBatches.set(batchKey, batch);
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
      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);

      try {
        const recentContext = await getRecentContext(message.channel);
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
