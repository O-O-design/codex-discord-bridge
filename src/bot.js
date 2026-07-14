import { Client, Events, GatewayIntentBits } from "discord.js";
import { askCodex } from "./codex.js";
import { getConfig } from "./config.js";
import { loadMemberRoster } from "./members.js";
import { appendRuntimeLog, initRuntimeLog, limitText } from "./runtime-log.js";

const config = getConfig();
await initRuntimeLog(config);
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
const allowedParentChannelIds = new Set(config.parentChannelIds);
const allowedThreadIds = new Set(config.threadIds);
const blockedChannelIds = new Set(config.blockedChannelIds);
const blockedParentChannelIds = new Set(config.blockedParentChannelIds);
const allowedBotAuthorIds = new Set(config.allowedBotAuthorIds);
const writeUserIds = new Set(config.writeUserIds);
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

    const context = contextLines.join("\n");
    await appendRuntimeLog("context_read", {
      summary: `read ${contextLines.length} recent messages from ${channel.name ?? channel.id}`,
      channelId: channel.id,
      channel: channel.name ?? null,
      count: contextLines.length
    });

    return context;
  } catch (error) {
    console.warn(`[discord] failed to fetch recent context: ${error.message}`);
    await appendRuntimeLog("context_read_failed", {
      summary: `failed to read recent context: ${error.message}`,
      channelId: channel.id,
      channel: channel.name ?? null,
      error: error.message
    });
    return "";
  }
}

function isAllowedMessage(message) {
  if (!message.guildId || !allowedGuildIds.has(message.guildId)) {
    return false;
  }

  if (allowedChannelIds.has(message.channelId) || allowedThreadIds.has(message.channelId)) {
    return true;
  }

  return message.channel?.isThread?.() && allowedParentChannelIds.has(message.channel.parentId);
}

function blockedReason(message) {
  if (blockedChannelIds.has(message.channelId)) {
    return "blocked_channel";
  }

  if (message.channel?.isThread?.() && blockedParentChannelIds.has(message.channel.parentId)) {
    return "blocked_parent_channel";
  }

  return null;
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
  console.log(`[oo-bridge] allowed parent channels: ${config.parentChannelIds.join(", ") || "(none)"}`);
  console.log(`[oo-bridge] allowed threads: ${config.threadIds.join(", ") || "(none)"}`);
  console.log(`[oo-bridge] blocked channels: ${config.blockedChannelIds.join(", ") || "(none)"}`);
  console.log(`[oo-bridge] blocked parent channels: ${config.blockedParentChannelIds.join(", ") || "(none)"}`);
  await appendRuntimeLog("bridge_ready", {
    summary: `logged in as ${readyClient.user.tag}`,
    botUserId: readyClient.user.id,
    botTag: readyClient.user.tag,
    allowedGuildIds: config.guildIds,
    allowedChannelIds: config.channelIds,
    allowedParentChannelIds: config.parentChannelIds,
    allowedThreadIds: config.threadIds,
    blockedChannelIds: config.blockedChannelIds,
    blockedParentChannelIds: config.blockedParentChannelIds
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user.id) {
    return;
  }

  const reason = blockedReason(message);
  if (reason) {
    await appendRuntimeLog("message_blocked", {
      summary: `ignored blacklisted location ${channelLabel(message)}`,
      reason,
      messageId: message.id,
      guildId: message.guildId,
      guild: message.guild?.name ?? null,
      channelId: message.channelId,
      channel: channelLabel(message),
      parentChannelId: message.channel?.parentId ?? null,
      authorId: message.author.id,
      authorIsBot: message.author.bot
    });
    return;
  }

  if (message.author.bot && !allowedBotAuthorIds.has(message.author.id)) {
    return;
  }

  if (!isAllowedMessage(message)) {
    return;
  }

  const content = cleanMessageText(message);
  const replyContext = await describeReply(message);
  console.log(`[discord] accepted ${message.author.tag}: ${content}`);
  await appendRuntimeLog("message_accepted", {
    summary: `${message.author.tag} in ${channelLabel(message)}: ${limitText(content)}`,
    messageId: message.id,
    guildId: message.guildId,
    guild: message.guild?.name ?? null,
    channelId: message.channelId,
    channel: channelLabel(message),
    parentChannelId: message.channel?.parentId ?? null,
    author: message.author.tag,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: limitText(content),
    replyContext: limitText(replyContext)
  });

  const batchKey = `${message.guildId}:${message.channelId}`;
  const batch = pendingBatches.get(batchKey) ?? {
    messages: [],
    timer: null,
    triggerMessage: message
  };

  batch.messages.push({
    author: message.author.tag,
    authorId: message.author.id,
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

function sandboxForBatch(batch) {
  return batch.every((item) => writeUserIds.has(item.authorId)) ? config.codexSandbox : "read-only";
}

function enqueueCodexBatch(message, batch) {
  const first = batch[0];
  const sandbox = sandboxForBatch(batch);
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
      await appendRuntimeLog("codex_start", {
        summary: `calling Codex for ${batch.length} message(s) in ${first.channel} with ${sandbox}`,
        guild: first.guild,
        channel: first.channel,
        channelId: message.channelId,
        batchSize: batch.length,
        sandbox,
        authors: batch.map((item) => ({
          author: item.author,
          authorId: item.authorId
        }))
      });
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
          recentContext,
          sandbox
        },
        {
          sandbox
        });

        await sendMessageChunks(message.channel, response);
        console.log("[codex] replied through Discord.");
        await appendRuntimeLog("codex_success", {
          summary: `replied in ${first.channel}; ${response.length} chars`,
          guild: first.guild,
          channel: first.channel,
          channelId: message.channelId,
          sandbox,
          responseLength: response.length,
          response: limitText(response)
        });
      } catch (error) {
        console.error("[codex] failed:", error.message);
        if (error.stderr) {
          console.error(limitText(error.stderr, 2_000));
        }
        await appendRuntimeLog("codex_failed", {
          summary: `Codex failed in ${first.channel}: ${error.message}`,
          guild: first.guild,
          channel: first.channel,
          channelId: message.channelId,
          sandbox,
          error: error.message,
          stderr: limitText(error.stderr),
          stdout: limitText(error.stdout)
        });
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
  appendRuntimeLog("discord_client_error", {
    summary: `Discord client error: ${error.message}`,
    error: error.message
  }).catch(() => {});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await appendRuntimeLog("bridge_shutdown", {
      summary: `received ${signal}`,
      signal
    });
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.discordToken);
