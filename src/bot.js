import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials
} from "discord.js";
import { askCodex, getSessionStatus, rotateSession } from "./codex-runner.js";
import { downloadDiscordImages, hasCustomEmoji } from "./discord-images.js";
import { getConfig } from "./env.js";

const config = getConfig();
const { token, guildIds } = config;
const publicConfig = {
  ...config,
  codexWorkdir: config.codexPublicWorkdir,
  codexSessionFile: config.codexPublicSessionFile,
  codexSessionStateFile: config.codexPublicSessionStateFile,
  codexHistoryFile: config.codexPublicHistoryFile,
  codexSummaryFile: config.codexPublicSummaryFile
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

let lastChannelId = null;
let codexQueue = Promise.resolve();
const observedMessages = new Map();
const lastPublicDecisionAt = new Map();
const consecutivePublicBotTurns = new Map();
const customEmojiByName = new Map();

const activityTypes = {
  CUSTOM: ActivityType.Custom,
  PLAYING: ActivityType.Playing,
  LISTENING: ActivityType.Listening,
  WATCHING: ActivityType.Watching,
  COMPETING: ActivityType.Competing
};

function setBotActivity(readyClient) {
  if (!config.activityText) {
    return;
  }

  const type = activityTypes[config.activityType] ?? ActivityType.Custom;

  try {
    readyClient.user.setActivity(config.activityText, { type });
    console.log(`[bridge] activity set: ${config.activityType} ${config.activityText}`);
  } catch (error) {
    console.warn(`[bridge] failed to set activity: ${error.message}`);
  }
}

function rememberCustomEmojis(content) {
  for (const match of content.matchAll(/<(a?):([A-Za-z0-9_]+):(\d+)>/g)) {
    const [, animated, name, id] = match;
    customEmojiByName.set(
      name,
      `<${animated ? "a" : ""}:${name}:${id}>`
    );
  }
}

async function rememberGuildEmojis(guildId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const emojis = await guild.emojis.fetch();

    for (const emoji of emojis.values()) {
      if (!emoji.name) {
        continue;
      }

      customEmojiByName.set(
        emoji.name,
        `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`
      );
    }

    console.log(`[bridge] cached ${emojis.size} custom emoji(s) for guild ${guildId}.`);
  } catch (error) {
    console.warn(`[bridge] failed to cache emojis for guild ${guildId}: ${error.message}`);
  }
}

function expandCustomEmojiShortcodes(content) {
  return content.replace(/(^|[^<\w]):([A-Za-z0-9_]+):(?!\d+>)/g, (match, prefix, name) => {
    const emoji = customEmojiByName.get(name);
    return emoji ? `${prefix}${emoji}` : match;
  });
}

function compactDiscordSpacing(content) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function observePublicMessage(message) {
  if (!config.publicChannelIds.includes(message.channelId)) {
    return false;
  }

  const messages = observedMessages.get(message.channelId) ?? [];
  messages.push({
    authorId: message.author.id,
    author: message.member?.displayName ?? message.author.displayName,
    isBot: message.author.bot,
    content: getMessageText(message),
    timestamp: message.createdTimestamp
  });
  observedMessages.set(message.channelId, messages.slice(-20));
  return true;
}

function getMessageText(message) {
  const attachmentText =
    message.attachments.size > 0 ? `[附加了 ${message.attachments.size} 個檔案]` : "";
  return (
    message.content
      ?.replaceAll(`<@${client.user.id}>`, `@${config.botDisplayName}`)
      .replaceAll(`<@!${client.user.id}>`, `@${config.botDisplayName}`)
      .replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:")
      .trim() || attachmentText || "[message content unavailable]"
  );
}

function requestsImageReview(message) {
  return (
    message.attachments.size > 0 &&
    /(?:看|讀|圖片|圖|照片|截圖|畫面|這張|附件)/u.test(message.content)
  );
}

function startsWithTriggerName(content) {
  const normalized = content?.trimStart() ?? "";
  return config.triggerNames.some((name) => normalized.startsWith(name));
}

function startsWithPublicCall(content, isOwner) {
  const normalized = content?.trimStart() ?? "";
  const names = isOwner ? config.triggerNames : config.publicBotCallNames;
  return names.some((name) => normalized.startsWith(name));
}

async function isReplyToBot(message) {
  if (!message.reference?.messageId) {
    return false;
  }

  try {
    const referenced = await message.fetchReference();
    return referenced.author.id === client.user?.id;
  } catch {
    return false;
  }
}

function getRecentPublicContext(channelId) {
  return (observedMessages.get(channelId) ?? []).slice(-13, -1);
}

function formatDiscordTime(value) {
  return value
    ? `<t:${Math.floor(new Date(value).getTime() / 1_000)}:R>`
    : "尚無紀錄";
}

function formatRotationReason(reason) {
  if (reason === "turn-limit") {
    return "滿 50 次自動換新";
  }
  if (reason === "manual") {
    return "手動換新";
  }
  return reason || "尚無紀錄";
}

async function sendToChannel(channelId, content) {
  const channel = await client.channels.fetch(channelId);

  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${channelId} is not text-based.`);
  }

  await channel.send(content);
  console.log(`[bridge] sent to channel ${channelId}`);
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

async function sendMessageChunks(message, content) {
  const normalized = compactDiscordSpacing(expandCustomEmojiShortcodes(content));
  const chunks = splitDiscordMessage(normalized);

  for (const chunk of chunks) {
    await message.channel.send(chunk);
  }
}

async function findAnnounceChannel(guildId) {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const systemChannel = guild.systemChannelId
    ? channels.get(guild.systemChannelId)
    : null;

  if (systemChannel?.isTextBased()) {
    return systemChannel;
  }

  return [...channels.values()]
    .filter((channel) => channel?.type === ChannelType.GuildText)
    .sort((a, b) => a.rawPosition - b.rawPosition)[0];
}

async function printGuildChannels(guildId) {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const textChannels = [...channels.values()]
    .filter((channel) => channel?.type === ChannelType.GuildText)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  console.log(`[bridge] ${guild.name} text channels:`);

  for (const channel of textChannels) {
    console.log(`  #${channel.name}: ${channel.id}`);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  setBotActivity(readyClient);
  console.log(`Logged in as ${readyClient.user.tag}.`);
  console.log("[bridge] Mention the bot in Discord or DM it to ask the local Codex CLI.");
  console.log("[bridge] Type a message here to manually reply to the last active channel.");
  console.log("[bridge] Commands: send <channelId> <text> | announce <guildId> <text> | channels <guildId>");

  for (const guildId of guildIds) {
    rememberGuildEmojis(guildId);
    printGuildChannels(guildId).catch((error) => {
      console.error(`[bridge] failed to list channels for ${guildId}:`, error.message);
    });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "ping") {
    await interaction.reply("pong");
    return;
  }

  if (!config.allowedUserIds.includes(interaction.user.id)) {
    await interaction.reply({
      content: `這是${config.ownerDisplayName}專用的管理指令。`,
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "session") {
    const [status, publicStatus] = await Promise.all([
      getSessionStatus(config),
      getSessionStatus(publicConfig)
    ]);
    await interaction.reply({
      content: [
        `私人 Session：${status.active ? "使用中" : "等待建立"}，${status.turns} / ${status.maxTurns}`,
        `私人建立：${formatDiscordTime(status.startedAt)}`,
        `私人最近換新：${formatDiscordTime(status.lastRotationAt)}（${formatRotationReason(status.lastRotationReason)}）`,
        `私人近期紀錄：${status.savedHistory} 組`,
        `公開 Session：${publicStatus.active ? "使用中" : "等待建立"}，${publicStatus.turns} / ${publicStatus.maxTurns}`,
        `公開建立：${formatDiscordTime(publicStatus.startedAt)}`,
        `公開最近換新：${formatDiscordTime(publicStatus.lastRotationAt)}（${formatRotationReason(publicStatus.lastRotationReason)}）`,
        `公開近期紀錄：${publicStatus.savedHistory} 組`
      ].join("\n"),
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "newsession") {
    await interaction.deferReply({ ephemeral: true });
    codexQueue = codexQueue.then(async () => {
      await Promise.all([
        rotateSession(config, "manual"),
        rotateSession(publicConfig, "manual")
      ]);
      await interaction.editReply("私人與公開 session 都已換新；下一句會載入各自的人格與近期記憶。");
    });
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user?.id) {
    return;
  }

  rememberCustomEmojis(message.content);

  const isObservedPublicMessage = observePublicMessage(message);
  if (isObservedPublicMessage && !config.publicModeEnabled) {
    return;
  }

  if (isObservedPublicMessage) {
    const isOwner = config.allowedUserIds.includes(message.author.id);
    const mentionsBot = Boolean(client.user && message.mentions.users.has(client.user.id));
    const repliesToBot = await isReplyToBot(message);
    const callsByName = startsWithPublicCall(message.content, isOwner);
    const botNamesRinYe =
      message.author.bot &&
      config.publicBotCallNames.some((name) => message.content.includes(name));
    const mentionsOwner = config.allowedUserIds.some((id) =>
      message.mentions.users.has(id)
    );
    const directInvocation = mentionsBot || repliesToBot || callsByName || botNamesRinYe;
    const now = Date.now();

    if (message.author.bot) {
      const botTurns = consecutivePublicBotTurns.get(message.channelId) ?? 0;
      if (!directInvocation || botTurns >= config.publicMaxConsecutiveBotTurns) {
        return;
      }
      consecutivePublicBotTurns.set(message.channelId, botTurns + 1);
    } else {
      consecutivePublicBotTurns.set(message.channelId, 0);
    }

    const lastDecision = lastPublicDecisionAt.get(message.channelId) ?? 0;
    const decisionCoolingDown = now - lastDecision < config.publicDecisionCooldownMs;
    const clearlyRelated =
      mentionsOwner ||
      message.content.includes(config.botDisplayName) ||
      message.content.includes(config.ownerDisplayName);

    if (!directInvocation && !clearlyRelated && decisionCoolingDown) {
      return;
    }

    lastPublicDecisionAt.set(message.channelId, now);
    const recentChannelContext = getRecentPublicContext(message.channelId);

    codexQueue = codexQueue
      .then(async () => {
        let typing = null;
        let downloadedImages = { paths: [], cleanup: async () => {} };
        try {
          if (directInvocation) {
            await message.channel.sendTyping();
            typing = setInterval(
              () => message.channel.sendTyping().catch(() => {}),
              8_000
            );
          }

          if (
            directInvocation ||
            requestsImageReview(message) ||
            hasCustomEmoji(message.content)
          ) {
            downloadedImages = await downloadDiscordImages(message, config);
          }

          const response = await askCodex(publicConfig, {
            author: message.member?.displayName ?? message.author.displayName,
            authorId: message.author.id,
            channel: message.channel?.name ?? message.channelId,
            guild: message.guild?.name,
            content: getMessageText(message),
            botDisplayName: config.botDisplayName,
            ownerDisplayName: config.ownerDisplayName,
            directInvocation,
            isBot: message.author.bot,
            publicMode: true,
            recentChannelContext,
            imagePaths: downloadedImages.paths
          });

          if (response === "NO_REPLY") {
            console.log(`[public] stayed quiet for message ${message.id}.`);
            return;
          }

          await sendMessageChunks(message, response);
          console.log("[public] replied through Discord.");
        } catch (error) {
          console.error("[public] Codex failed:", error.message);
          if (directInvocation) {
            await message.channel.send("我剛剛卡住了，等我一下再叫我一次。");
          }
        } finally {
          if (typing) {
            clearInterval(typing);
          }
          await downloadedImages.cleanup();
        }
      })
      .catch((error) => console.error("[public] queue failed:", error));
    return;
  }

  if (message.author.bot) {
    return;
  }

  const isDirectMessage = !message.guildId;
  const mentionsBot = client.user && message.mentions.users.has(client.user.id);
  const isWatchedChannel = config.watchedChannelIds.includes(message.channelId);
  const invokesByName = startsWithTriggerName(message.content);

  if (!isDirectMessage && !mentionsBot && !isWatchedChannel && !invokesByName) {
    return;
  }

  if (!config.allowedUserIds.includes(message.author.id)) {
    console.warn(`[bridge] ignored non-allowlisted user ${message.author.id}`);
    return;
  }

  lastChannelId = message.channelId;

  console.log(
    `[discord] ${message.guild?.name ?? "DM"} / #${message.channel?.name ?? message.channelId} / ${message.author.tag}: ${getMessageText(message)}`
  );

  codexQueue = codexQueue
    .then(async () => {
      console.log("[codex] asking local Codex CLI...");
      await message.channel.sendTyping();

      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);

      try {
        const downloadedImages = await downloadDiscordImages(message, config);
        try {
          const response = await askCodex(config, {
            author: message.member?.displayName ?? message.author.displayName,
            authorId: message.author.id,
            channel: message.channel?.name ?? message.channelId,
            guild: message.guild?.name,
            content: getMessageText(message),
            botDisplayName: config.botDisplayName,
            ownerDisplayName: config.ownerDisplayName,
            imagePaths: downloadedImages.paths
          });

          await sendMessageChunks(message, response);
          console.log("[codex] replied through Discord.");
        } finally {
          await downloadedImages.cleanup();
        }
      } catch (error) {
        console.error("[codex] failed:", error.message);
        if (error.stderr) {
          console.error(error.stderr);
        }
        await message.channel.send("我這邊叫 Codex CLI 的時候失敗了，先卡一下。");
      } finally {
        clearInterval(typing);
      }
    })
    .catch((error) => {
      console.error("[codex] queue failed:", error);
    });
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

const terminal = createInterface({ input, output });

terminal.on("line", async (line) => {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  try {
    if (trimmed.startsWith("send ")) {
      const [, channelId, ...messageParts] = trimmed.split(" ");
      await sendToChannel(channelId, messageParts.join(" "));
      return;
    }

    if (trimmed.startsWith("announce ")) {
      const [, guildId, ...messageParts] = trimmed.split(" ");
      const channel = await findAnnounceChannel(guildId);

      if (!channel) {
        throw new Error(`No text channel found for guild ${guildId}.`);
      }

      await sendToChannel(channel.id, messageParts.join(" "));
      return;
    }

    if (trimmed.startsWith("channels ")) {
      const [, guildId] = trimmed.split(" ");
      await printGuildChannels(guildId);
      return;
    }

    if (!lastChannelId) {
      console.log("[bridge] No active channel yet. Use send <channelId> <text> first.");
      return;
    }

    await sendToChannel(lastChannelId, trimmed);
  } catch (error) {
    console.error("[bridge] command failed:", error.message);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    terminal.close();
    client.destroy();
    process.exit(0);
  });
}

await client.login(token);
