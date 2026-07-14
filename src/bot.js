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
let pendingNarrationMessage = null;
let narrationChannel = null;

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

function narrationContent(content) {
  return content.startsWith("（") ? content : `（${content}）`;
}

async function getNarrationChannel(fallbackChannel) {
  if (!config.narrationEnabled) {
    return null;
  }

  if (!config.narrationChannelId) {
    return fallbackChannel?.isTextBased() ? fallbackChannel : null;
  }

  if (narrationChannel?.id === config.narrationChannelId) {
    return narrationChannel;
  }

  narrationChannel = await client.channels.fetch(config.narrationChannelId);

  return narrationChannel?.isTextBased() ? narrationChannel : null;
}

async function createNarration(fallbackChannel, content) {
  try {
    const channel = await getNarrationChannel(fallbackChannel);

    return channel ? await channel.send(narrationContent(content)) : null;
  } catch (error) {
    console.warn(`[narration] failed to send status: ${error.message}`);
    return null;
  }
}

async function updateNarration(narrationMessage, fallbackChannel, content) {
  if (!config.narrationEnabled) {
    return null;
  }

  try {
    if (narrationMessage) {
      await narrationMessage.edit(narrationContent(content));
      return narrationMessage;
    }

    return await createNarration(fallbackChannel, content);
  } catch (error) {
    console.warn(`[narration] failed to update status: ${error.message}`);
    return;
  }
}

function narrationSubject(user) {
  return config.discordOwnerUserId && user.id === config.discordOwnerUserId ? "老婆的話" : "這句話";
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
  const readyTarget = config.discordOwnerUserId ? "老婆叫我" : "有人叫我";
  await createNarration(channel, `我把麥克風接好了，先守在測試頻道等${readyTarget}。`);
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

  if (pendingMessages.length === 0) {
    pendingNarrationMessage = await createNarration(
      message.channel,
      `我要接${narrationSubject(message.author)}，我正在先把剛剛這句接住。`
    );
  } else {
    pendingNarrationMessage = await updateNarration(
      pendingNarrationMessage,
      message.channel,
      `我要接${narrationSubject(message.author)}，我正在把連續幾句合在一起看。`
    );
  }

  pendingMessages.push({
    author: message.author.tag,
    authorProfile: memberRoster.describeUser(message.author),
    narrationSubject: narrationSubject(message.author),
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
    const narrationMessage = pendingNarrationMessage;
    pendingMessages = [];
    pendingNarrationMessage = null;
    batchTimer = null;

    enqueueCodexBatch(message, batch, narrationMessage);
  }, config.discordBatchWindowMs);
});

function enqueueCodexBatch(message, batch, narrationMessage) {
  const first = batch[0];
  const subject = first.narrationSubject ?? "這句話";
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
      narrationMessage = await updateNarration(
        narrationMessage,
        message.channel,
        `我要接${subject}，我正在看前面幾句，確認這句在回誰、誰在跟誰說話。`
      );
      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);

      try {
        const recentContext = await getRecentContext(message.channel);
        narrationMessage = await updateNarration(
          narrationMessage,
          message.channel,
          `我要接${subject}，我把上下文排好了，正在回到頻道裡。`
        );
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
        await updateNarration(narrationMessage, message.channel, "我回完了，先回到旁邊等下一句。");
      } catch (error) {
        console.error("[codex] failed:", error.message);
        if (error.stderr) {
          console.error(error.stderr);
        }
        await updateNarration(narrationMessage, message.channel, "這回合卡住了，我先把話放下，下一句再接。");
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
