import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
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
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

let codexQueue = Promise.resolve();
let nextJobNumber = 0;
let queuedJobCount = 0;
let activeJobId = null;
const allowedGuildIds = new Set(config.guildIds);
const allowedChannelIds = new Set(config.channelIds);
const allowedParentChannelIds = new Set(config.parentChannelIds);
const allowedThreadIds = new Set(config.threadIds);
const blockedChannelIds = new Set(config.blockedChannelIds);
const blockedParentChannelIds = new Set(config.blockedParentChannelIds);
const allowedBotAuthorIds = new Set(config.allowedBotAuthorIds);
const dmUserIds = new Set(config.dmUserIds);
const writeUserIds = new Set(config.writeUserIds);
const pendingBatches = new Map();
const pendingDevApprovals = new Map();
const botLoopState = new Map();
const projectRoot = resolve(process.cwd());
const tmpRoots = [...new Set([tmpdir(), process.env.TMPDIR].filter(Boolean).map((item) => resolve(item)))];
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const uploadDirectivePattern = /^\s*\[\[discord-upload:(.+?)\]\]\s*$/i;
const privateDirectivePattern = /^\s*\[\[discord-private\]\]\s*$/i;
const devApprovalPattern = /^\s*(?:批准|同意|approve|ok)\s+([a-z0-9-]+)\s*$/i;
const devDenyPattern = /^\s*(?:拒絕|取消|deny|cancel)\s+([a-z0-9-]+)\s*$/i;
const devKeywords = [
  /寫(程式|code)|改(檔|程式|app|網站|repo)|修( bug|bug|錯|程式)?/iu,
  /做(成|一個|個)?\s*(app|APP|網站|工具|功能|橋接|程式)|建立|新增|更新|打造|蓋(好|一個)?/iu,
  /跑(程式|測試|test|build|npm|node|python|指令|命令)|執行|開發|部署|安裝套件/iu,
  /\b(git|github|commit|push|npm|node|python|build|test|deploy|terminal|shell)\b/iu,
  /終端機|版控|上傳 GitHub|上傳github|套件|依賴|server|伺服器/iu
];

async function appendFrontstageInbox(entry) {
  await mkdir(dirname(config.discordInboxFile), { recursive: true });
  await appendFile(config.discordInboxFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function cleanMessageText(message) {
  return (
    message.content
      ?.replaceAll(`<@${client.user.id}>`, "@bot")
      .replaceAll(`<@!${client.user.id}>`, "@bot")
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

function isDmMessage(message) {
  return message.channel?.type === ChannelType.DM || !message.guildId;
}

function canDmUser(userId) {
  return config.discordPrivateReplyEnabled && dmUserIds.has(userId);
}

function formatAuthor(user) {
  const profile = memberRoster.describeUser(user);
  const label = user.bot ? `${user.username} [bot]` : user.tag ?? user.username;

  return profile ? `${label}（${profile}）` : label;
}

function excerptMessageContent(message) {
  const attachmentCount = message.attachments?.size ?? 0;
  const fallback = attachmentCount > 0 ? `(無文字／含 ${attachmentCount} 個附件)` : "(無文字／可能是圖或貼圖)";
  const raw = (message.content || fallback).replace(/[\r\n]+/g, " ⏎ ");

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
          const content = [
            item.content?.trim() || "",
            summarizeMessageAttachments(item)
          ].filter(Boolean).join("\n") || "[message content unavailable]";
          const replyContext = await describeReply(item);

          return [replyContext, `${author}: ${content}`].filter(Boolean).join("\n");
        })
    );

    const context = contextLines.join("\n");
    await appendRuntimeLog("context_read", {
      summary: `已讀取 ${contextLines.length} 則可選上下文：${channel.name ?? channel.id}`,
      channelId: channel.id,
      channel: channel.name ?? null,
      count: contextLines.length
    });

    return context;
  } catch (error) {
    console.warn(`[discord] failed to fetch optional context: ${error.message}`);
    await appendRuntimeLog("context_read_failed", {
      summary: `可選上下文讀取失敗：${error.message}`,
      channelId: channel.id,
      channel: channel.name ?? null,
      error: error.message
    });
    return "";
  }
}

function isAllowedMessage(message) {
  if (isDmMessage(message)) {
    return dmUserIds.has(message.author.id);
  }

  if (!message.guildId || !allowedGuildIds.has(message.guildId)) {
    return false;
  }

  if (allowedChannelIds.has(message.channelId) || allowedThreadIds.has(message.channelId)) {
    return true;
  }

  return message.channel?.isThread?.() && allowedParentChannelIds.has(message.channel.parentId);
}

function blockedReason(message) {
  if (isDmMessage(message)) {
    return null;
  }

  if (blockedChannelIds.has(message.channelId)) {
    return "blocked_channel";
  }

  if (message.channel?.isThread?.() && blockedParentChannelIds.has(message.channel.parentId)) {
    return "blocked_parent_channel";
  }

  return null;
}

function channelLabel(message) {
  if (isDmMessage(message)) {
    return `私訊 / ${message.author.tag}`;
  }

  const name = message.channel?.name ?? message.channelId;

  return message.channel?.isThread?.() && message.channel.parent?.name
    ? `${message.channel.parent.name} / ${name}`
    : name;
}

function channelStateKey(message) {
  return isDmMessage(message) ? `dm:${message.author.id}` : `${message.guildId}:${message.channelId}`;
}

function safeFileName(name, fallback) {
  const safe = basename(name || fallback).replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || fallback;
}

function isImageAttachment(attachment) {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  const extension = extname(attachment.name ?? "").toLowerCase();

  return contentType.startsWith("image/") || imageExtensions.has(extension);
}

function summarizeMessageAttachments(message) {
  const attachments = [...(message.attachments?.values?.() ?? [])];

  if (attachments.length === 0) {
    return "";
  }

  return attachments.map((attachment) => {
    const kind = isImageAttachment(attachment) ? "圖片" : "附件";
    const size = attachment.size ? `，${Math.round(attachment.size / 1024)} KB` : "";
    const type = attachment.contentType ? `，${attachment.contentType}` : "";

    return `${kind}附件：${attachment.name ?? attachment.id}${type}${size}`;
  }).join("\n");
}

async function downloadImageAttachments(message) {
  if (config.discordImageAttachmentLimit === 0 || !message.attachments?.size) {
    return [];
  }

  const images = [...message.attachments.values()]
    .filter(isImageAttachment)
    .slice(0, config.discordImageAttachmentLimit);

  if (images.length === 0) {
    return [];
  }

  const dir = resolve(process.cwd(), "state", "discord-images", message.id);
  await mkdir(dir, { recursive: true });

  const downloaded = [];
  for (const [index, attachment] of images.entries()) {
    if (attachment.size && attachment.size > config.discordMaxImageBytes) {
      await appendRuntimeLog("image_attachment_skipped", {
        summary: `圖片附件太大，已略過：${attachment.name ?? attachment.id}`,
        messageId: message.id,
        attachmentId: attachment.id,
        size: attachment.size,
        maxBytes: config.discordMaxImageBytes
      });
      continue;
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > config.discordMaxImageBytes) {
        await appendRuntimeLog("image_attachment_skipped", {
          summary: `圖片附件下載後太大，已略過：${attachment.name ?? attachment.id}`,
          messageId: message.id,
          attachmentId: attachment.id,
          size: buffer.byteLength,
          maxBytes: config.discordMaxImageBytes
        });
        continue;
      }

      const extension = extname(attachment.name ?? "") || ".png";
      const filename = safeFileName(attachment.name, `${index + 1}${extension}`);
      const filePath = join(dir, `${index + 1}-${filename}`);
      await writeFile(filePath, buffer);
      downloaded.push({
        path: filePath,
        name: attachment.name ?? filename,
        contentType: attachment.contentType ?? response.headers.get("content-type") ?? null,
        size: buffer.byteLength,
        url: attachment.url
      });
    } catch (error) {
      await appendRuntimeLog("image_attachment_failed", {
        summary: `圖片附件下載失敗：${attachment.name ?? attachment.id}，${error.message}`,
        messageId: message.id,
        attachmentId: attachment.id,
        error: error.message
      });
    }
  }

  return downloaded;
}

function isPathInside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}

function isAllowedUploadPath(filePath) {
  const target = resolve(filePath);

  return isPathInside(projectRoot, target) || tmpRoots.some((root) => isPathInside(root, target));
}

function parseResponseDirectives(response) {
  const uploadPaths = [];
  let privateReply = false;
  const textLines = [];

  for (const line of response.split(/\r?\n/)) {
    const uploadMatch = line.match(uploadDirectivePattern);
    if (uploadMatch) {
      uploadPaths.push(uploadMatch[1].trim());
      continue;
    }

    if (privateDirectivePattern.test(line)) {
      privateReply = true;
      continue;
    }

    textLines.push(line);
  }

  return {
    text: textLines.join("\n").trim(),
    uploadPaths,
    privateReply
  };
}

async function sendUploadFiles(channel, uploadPaths) {
  const files = [];

  for (const filePath of uploadPaths.slice(0, config.discordUploadLimit)) {
    const resolvedPath = resolve(filePath);

    if (!isAllowedUploadPath(resolvedPath)) {
      await appendRuntimeLog("discord_upload_skipped", {
        summary: `略過不允許的上傳路徑：${resolvedPath}`,
        path: resolvedPath
      });
      continue;
    }

    try {
      const file = await stat(resolvedPath);
      if (!file.isFile() || file.size > config.discordMaxUploadBytes) {
        await appendRuntimeLog("discord_upload_skipped", {
          summary: `略過不符合限制的上傳檔案：${resolvedPath}`,
          path: resolvedPath,
          size: file.size,
          maxBytes: config.discordMaxUploadBytes
        });
        continue;
      }

      files.push(new AttachmentBuilder(resolvedPath));
    } catch (error) {
      await appendRuntimeLog("discord_upload_skipped", {
        summary: `上傳檔案不存在或無法讀取：${resolvedPath}`,
        path: resolvedPath,
        error: error.message
      });
    }
  }

  if (files.length > 0) {
    await channel.send({ files });
  }
}

async function sendCodexResponse(message, response) {
  const directives = parseResponseDirectives(response);
  const shouldDm = directives.privateReply && !isDmMessage(message) && canDmUser(message.author.id);
  const targetChannel = shouldDm ? await message.author.createDM() : message.channel;

  if (directives.text) {
    await sendMessageChunks(targetChannel, directives.text);
  }

  if (directives.uploadPaths.length > 0) {
    await sendUploadFiles(targetChannel, directives.uploadPaths);
  }

  if (shouldDm) {
    await appendRuntimeLog("discord_private_reply", {
      summary: `已改用私訊回覆 ${message.author.tag}`,
      author: message.author.tag,
      authorId: message.author.id,
      uploadCount: directives.uploadPaths.length
    });
  }
}

function looksLikeDevRequest(batch) {
  const text = batch.map((item) => item.content).join("\n");
  return devKeywords.some((pattern) => pattern.test(text));
}

function newApprovalId() {
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseApprovalCommand(content) {
  const approve = content.match(devApprovalPattern);
  if (approve) {
    return { action: "approve", id: approve[1] };
  }

  const deny = content.match(devDenyPattern);
  if (deny) {
    return { action: "deny", id: deny[1] };
  }

  return null;
}

function canApproveDevJob(userId, approval) {
  return userId === approval.requesterId || writeUserIds.has(userId);
}

async function maybeHandleApprovalCommand(message, content) {
  const command = parseApprovalCommand(content);
  if (!command) {
    return false;
  }

  const approval = pendingDevApprovals.get(command.id);
  if (!approval || !canApproveDevJob(message.author.id, approval)) {
    return false;
  }

  clearTimeout(approval.timeout);
  pendingDevApprovals.delete(command.id);

  if (command.action === "deny") {
    await message.channel.send(`已取消 ${command.id}。`);
    await appendRuntimeLog("dev_approval_denied", {
      summary: `開發執行已取消：${command.id}`,
      approvalId: command.id,
      author: message.author.tag,
      authorId: message.author.id
    });
    return true;
  }

  await message.channel.send(`已批准 ${command.id}，我現在交給 Codex 處理。`);
  await appendRuntimeLog("dev_approval_granted", {
    summary: `開發執行已批准：${command.id}`,
    approvalId: command.id,
    author: message.author.tag,
    authorId: message.author.id
  });
  enqueueCodexBatch(approval.message, approval.batch, { approvalId: command.id });
  return true;
}

async function maybeRequestDevApproval(message, batch) {
  const sandbox = sandboxForBatch(batch);
  const mode = config.discordDevApprovalMode;
  const needsApproval = mode === "always-write" || (mode === "heuristic" && looksLikeDevRequest(batch));

  if (mode === "off" || sandbox === "read-only" || !needsApproval) {
    return false;
  }

  const approvalId = newApprovalId();
  const timeout = setTimeout(() => {
    pendingDevApprovals.delete(approvalId);
    appendRuntimeLog("dev_approval_expired", {
      summary: `開發執行等待批准逾時：${approvalId}`,
      approvalId
    }).catch(() => {});
  }, config.discordDevApprovalTimeoutMs);

  pendingDevApprovals.set(approvalId, {
    id: approvalId,
    requesterId: message.author.id,
    message,
    batch,
    timeout
  });

  await message.channel.send(
    [
      `這看起來會讓 Codex 進入開發/跑程式處理。`,
      `要繼續請回覆：批准 ${approvalId}`,
      `要取消請回覆：取消 ${approvalId}`
    ].join("\n")
  );
  await appendRuntimeLog("dev_approval_requested", {
    summary: `等待使用者批准開發執行：${approvalId}`,
    approvalId,
    author: message.author.tag,
    authorId: message.author.id,
    sandbox,
    batchSize: batch.length,
    timeoutMs: config.discordDevApprovalTimeoutMs
  });
  return true;
}

function looksLikeAuthorizationBlock(chunk) {
  return /authorize|authorization|oauth|login|sign in|permission|approval|authenticate|device code|github/i.test(chunk);
}

async function enqueueFrontstageInbox(message, batch) {
  const first = batch[0];
  const images = batch.flatMap((item) => item.images ?? []);
  const inboxId = `inbox-${Date.now().toString(36)}-${(++nextJobNumber).toString(36)}`;
  const entry = {
    ts: new Date().toISOString(),
    id: inboxId,
    status: "unread",
    deliveryMode: "inbox",
    guildId: message.guildId ?? null,
    guild: first.guild,
    channelId: message.channelId,
    channel: first.channel,
    isDm: isDmMessage(message),
    canPrivateReply: !isDmMessage(message) && canDmUser(message.author.id),
    batchSize: batch.length,
    imageCount: images.length,
    triggerMessageId: message.id,
    messages: batch.map((item) => ({
      messageId: item.messageId,
      author: item.author,
      authorId: item.authorId,
      authorProfile: item.authorProfile,
      content: item.content,
      replyContext: item.replyContext,
      images: (item.images ?? []).map((image) => ({
        path: image.path,
        name: image.name,
        contentType: image.contentType,
        size: image.size
      }))
    }))
  };

  await appendFrontstageInbox(entry);
  await appendRuntimeLog("frontstage_inbox_received", {
    summary: `已收進前台 inbox：${inboxId}，${batch.length} 則訊息，位置 ${first.channel}`,
    inboxId,
    guild: first.guild,
    channel: first.channel,
    channelId: message.channelId,
    batchSize: batch.length,
    imageCount: images.length,
    messages: batch.map((item) => ({
      messageId: item.messageId,
      author: item.author,
      authorId: item.authorId,
      content: limitText(item.content),
      imageCount: item.images?.length ?? 0
    }))
  });
}

function resetBotLoopGuard(message) {
  botLoopState.delete(channelStateKey(message));
}

function checkBotLoopGuard(message) {
  if (!message.author.bot) {
    resetBotLoopGuard(message);
    return { allowed: true };
  }

  const now = Date.now();
  const key = channelStateKey(message);
  const state = botLoopState.get(key) ?? {
    windowStartedAt: now,
    turnCount: 0,
    cooldownUntil: 0
  };

  if (state.cooldownUntil > now) {
    botLoopState.set(key, state);
    return {
      allowed: false,
      reason: "cooldown",
      turnCount: state.turnCount,
      cooldownRemainingMs: state.cooldownUntil - now
    };
  }

  if (state.cooldownUntil > 0) {
    state.windowStartedAt = now;
    state.turnCount = 0;
    state.cooldownUntil = 0;
  }

  if (now - state.windowStartedAt > config.discordBotLoopWindowMs) {
    state.windowStartedAt = now;
    state.turnCount = 0;
    state.cooldownUntil = 0;
  }

  if (state.turnCount >= config.discordBotLoopMaxTurns) {
    state.cooldownUntil = now + config.discordBotLoopCooldownMs;
    botLoopState.set(key, state);
    return {
      allowed: false,
      reason: "max_turns",
      turnCount: state.turnCount,
      cooldownRemainingMs: config.discordBotLoopCooldownMs
    };
  }

  state.turnCount += 1;
  botLoopState.set(key, state);

  return {
    allowed: true,
    turnCount: state.turnCount,
    maxTurns: config.discordBotLoopMaxTurns,
    windowMs: config.discordBotLoopWindowMs
  };
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[codex-discord-bridge] logged in as ${readyClient.user.tag}`);
  console.log(`[codex-discord-bridge] allowed guilds: ${config.guildIds.join(", ")}`);
  console.log(`[codex-discord-bridge] allowed channels: ${config.channelIds.join(", ") || "(none)"}`);
  console.log(`[codex-discord-bridge] allowed parent channels: ${config.parentChannelIds.join(", ") || "(none)"}`);
  console.log(`[codex-discord-bridge] allowed threads: ${config.threadIds.join(", ") || "(none)"}`);
  console.log(`[codex-discord-bridge] blocked channels: ${config.blockedChannelIds.join(", ") || "(none)"}`);
  console.log(`[codex-discord-bridge] blocked parent channels: ${config.blockedParentChannelIds.join(", ") || "(none)"}`);
  console.log(`[codex-discord-bridge] allowed DM users: ${config.dmUserIds.length}`);
  console.log(`[codex-discord-bridge] delivery mode: ${config.discordDeliveryMode}`);
  await appendRuntimeLog("bridge_ready", {
    summary: `已登入 Discord：${readyClient.user.tag}`,
    botUserId: readyClient.user.id,
    botTag: readyClient.user.tag,
    allowedGuildIds: config.guildIds,
    allowedChannelIds: config.channelIds,
    allowedParentChannelIds: config.parentChannelIds,
    allowedThreadIds: config.threadIds,
    blockedChannelIds: config.blockedChannelIds,
    blockedParentChannelIds: config.blockedParentChannelIds,
    dmUserCount: config.dmUserIds.length,
    deliveryMode: config.discordDeliveryMode
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user.id) {
    return;
  }

  const reason = blockedReason(message);
  if (reason) {
    await appendRuntimeLog("message_blocked", {
      summary: `已略過黑名單位置：${channelLabel(message)}`,
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

  const botLoop = checkBotLoopGuard(message);
  if (!botLoop.allowed) {
    await appendRuntimeLog("bot_loop_limited", {
      summary: `AI 互聊煞車：已略過 ${message.author.tag} 在 ${channelLabel(message)} 的訊息，連續 ${botLoop.turnCount} 回合`,
      reason: botLoop.reason,
      messageId: message.id,
      guildId: message.guildId,
      guild: message.guild?.name ?? null,
      channelId: message.channelId,
      channel: channelLabel(message),
      parentChannelId: message.channel?.parentId ?? null,
      author: message.author.tag,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      turnCount: botLoop.turnCount,
      maxTurns: config.discordBotLoopMaxTurns,
      windowMs: config.discordBotLoopWindowMs,
      cooldownRemainingMs: botLoop.cooldownRemainingMs
    });
    return;
  }

  const content = cleanMessageText(message);
  if (await maybeHandleApprovalCommand(message, content)) {
    return;
  }

  const replyContext = await describeReply(message);
  const images = await downloadImageAttachments(message);
  const attachmentSummary = summarizeMessageAttachments(message);
  const contentWithAttachments = [
    content === "[message content unavailable]" ? "" : content,
    attachmentSummary
  ].filter(Boolean).join("\n") || content;
  console.log(`[discord] accepted ${message.author.tag}: ${content}`);
  await appendRuntimeLog("message_accepted", {
    summary: `${message.author.tag} 在 ${channelLabel(message)}：${limitText(contentWithAttachments)}`,
    messageId: message.id,
    guildId: message.guildId,
    guild: message.guild?.name ?? null,
    channelId: message.channelId,
    channel: channelLabel(message),
    parentChannelId: message.channel?.parentId ?? null,
    author: message.author.tag,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: limitText(contentWithAttachments),
    replyContext: limitText(replyContext),
    imageCount: images.length
  });

  const batchKey = channelStateKey(message);
  const batch = pendingBatches.get(batchKey) ?? {
    messages: [],
    timer: null,
    triggerMessage: message
  };

  batch.messages.push({
    messageId: message.id,
    author: message.author.tag,
    authorId: message.author.id,
    authorProfile: memberRoster.describeUser(message.author),
    channel: channelLabel(message),
    guild: message.guild?.name ?? (isDmMessage(message) ? "DM" : message.guildId),
    content: contentWithAttachments,
    replyContext,
    images
  });
  batch.triggerMessage = message;

  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  const authorIds = new Set(batch.messages.map((item) => item.authorId));
  const batchWindowMs = authorIds.size === 1
    ? config.discordSoloBatchWindowMs
    : config.discordBatchWindowMs;

  batch.timer = setTimeout(() => {
    pendingBatches.delete(batchKey);

    if (config.discordDeliveryMode === "inbox") {
      enqueueFrontstageInbox(batch.triggerMessage, batch.messages).catch((error) => {
        console.error("[inbox] failed:", error);
        appendRuntimeLog("frontstage_inbox_failed", {
          summary: `前台 inbox 寫入失敗：${error.message}`,
          error: error.message,
          channelId: batch.triggerMessage.channelId,
          channel: channelLabel(batch.triggerMessage),
          batchSize: batch.messages.length
        }).catch(() => {});
      });
      return;
    }

    maybeRequestDevApproval(batch.triggerMessage, batch.messages)
      .then((requested) => {
        if (!requested) {
          enqueueCodexBatch(batch.triggerMessage, batch.messages);
        }
      })
      .catch((error) => {
        console.error("[approval] failed:", error);
        enqueueCodexBatch(batch.triggerMessage, batch.messages);
      });
  }, batchWindowMs);

  pendingBatches.set(batchKey, batch);
});

function sandboxForBatch(batch) {
  return batch.every((item) => writeUserIds.has(item.authorId)) ? config.codexSandbox : "read-only";
}

function enqueueCodexBatch(message, batch, options = {}) {
  const first = batch[0];
  const sandbox = sandboxForBatch(batch);
  const images = batch.flatMap((item) => item.images ?? []);
  const jobId = `codex-${Date.now().toString(36)}-${(++nextJobNumber).toString(36)}`;
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

  queuedJobCount += 1;
  appendRuntimeLog("codex_queued", {
    summary: `Codex 任務已排隊：${jobId}，${batch.length} 則訊息，位置 ${first.channel}`,
    jobId,
    guild: first.guild,
    channel: first.channel,
    channelId: message.channelId,
    batchSize: batch.length,
    sandbox,
    queuedJobCount,
    activeJobId,
    approvalId: options.approvalId ?? null,
    imageCount: images.length,
    messages: batch.map((item) => ({
      messageId: item.messageId,
      author: item.author,
      authorId: item.authorId,
      content: limitText(item.content),
      imageCount: item.images?.length ?? 0
    })),
    authors: batch.map((item) => ({
      author: item.author,
      authorId: item.authorId
    }))
  }).catch(() => {});

  codexQueue = codexQueue
    .then(async () => {
      const startedAt = Date.now();
      activeJobId = jobId;
      queuedJobCount = Math.max(queuedJobCount - 1, 0);
      await message.channel.sendTyping();
      await appendRuntimeLog("codex_start", {
        summary: `Codex 開始處理：${jobId}，${batch.length} 則訊息，權限 ${sandbox}`,
        jobId,
        guild: first.guild,
        channel: first.channel,
        channelId: message.channelId,
        batchSize: batch.length,
        sandbox,
        queuedJobCount,
        activeJobId,
        approvalId: options.approvalId ?? null,
        imageCount: images.length,
        messages: batch.map((item) => ({
          messageId: item.messageId,
          author: item.author,
          authorId: item.authorId,
          content: limitText(item.content),
          imageCount: item.images?.length ?? 0
        })),
        authors: batch.map((item) => ({
          author: item.author,
          authorId: item.authorId
        }))
      });
      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8_000);
      let authorizationDetected = false;

      try {
        let recentContext = "";
        let codexOutputEventCount = 0;
        if (config.discordContextLimit > 0) {
          await appendRuntimeLog("context_read_start", {
            summary: `讀取可選上下文：${jobId}，最多 ${config.discordContextLimit} 則`,
            jobId,
            guild: first.guild,
            channel: first.channel,
            channelId: message.channelId,
            sandbox,
            queuedJobCount,
            activeJobId,
            contextLimit: config.discordContextLimit,
            imageCount: images.length,
            messages: batch.map((item) => ({
              messageId: item.messageId,
              author: item.author,
              authorId: item.authorId,
              content: limitText(item.content),
              imageCount: item.images?.length ?? 0
            }))
          });
          recentContext = await getRecentContext(message.channel);
        }
        await appendRuntimeLog("codex_cli_start", {
          summary: `呼叫 Codex CLI：${jobId}，位置 ${first.channel}`,
          jobId,
          guild: first.guild,
          channel: first.channel,
          channelId: message.channelId,
          sandbox,
          queuedJobCount,
          activeJobId,
          contextLimit: config.discordContextLimit,
          contextLength: recentContext.length,
          imageCount: images.length,
          messages: batch.map((item) => ({
            messageId: item.messageId,
            author: item.author,
            authorId: item.authorId,
            content: limitText(item.content),
            imageCount: item.images?.length ?? 0
          }))
        });
        const response = await askCodex(config, {
          author: message.author.tag,
          authorProfile: first.authorProfile,
          channel: first.channel,
          guild: first.guild,
          content,
          imageCount: images.length,
          imageNames: images.map((item) => item.name),
          privateReplyAvailable: !isDmMessage(message) && canDmUser(message.author.id),
          recentContext,
          sandbox
        },
        {
          sandbox,
          images: images.map((item) => item.path),
          onOutput: ({ source, chunk }) => {
            codexOutputEventCount += 1;
            if (looksLikeAuthorizationBlock(chunk) && codexOutputEventCount <= 3) {
              authorizationDetected = true;
              appendRuntimeLog("codex_authorization_needed", {
                summary: `Codex 可能正在等待授權或登入：${jobId}`,
                jobId,
                guild: first.guild,
                channel: first.channel,
                channelId: message.channelId,
                sandbox,
                source,
                output: limitText(chunk, 400),
                queuedJobCount,
                activeJobId
              }).catch(() => {});
            }

            appendRuntimeLog("codex_cli_output", {
              summary: `Codex CLI 有新的 ${source} 輸出`,
              jobId,
              guild: first.guild,
              channel: first.channel,
              channelId: message.channelId,
              sandbox,
              source,
              outputEventCount: codexOutputEventCount,
              output: limitText(chunk, 400),
              queuedJobCount,
              activeJobId
            }).catch(() => {});
          }
        });

        await sendCodexResponse(message, response);
        console.log("[codex] replied through Discord.");
        await appendRuntimeLog("codex_success", {
          summary: `Codex 任務完成：${jobId}，回覆 ${response.length} 字`,
          jobId,
          guild: first.guild,
          channel: first.channel,
          channelId: message.channelId,
          sandbox,
          durationMs: Date.now() - startedAt,
          queuedJobCount,
          responseLength: response.length,
          response: limitText(response),
          imageCount: images.length,
          messages: batch.map((item) => ({
            messageId: item.messageId,
            author: item.author,
            authorId: item.authorId,
            content: limitText(item.content),
            imageCount: item.images?.length ?? 0
          }))
        });
      } catch (error) {
        console.error("[codex] failed:", error.message);
        if (error.stderr) {
          console.error(limitText(error.stderr, 2_000));
        }
        const authFailure = authorizationDetected
          || looksLikeAuthorizationBlock(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
        await appendRuntimeLog("codex_failed", {
          summary: authFailure
            ? `Codex 任務可能卡在授權/登入：${jobId}`
            : `Codex 任務失敗：${jobId}，${error.message}`,
          jobId,
          guild: first.guild,
          channel: first.channel,
          channelId: message.channelId,
          sandbox,
          durationMs: Date.now() - startedAt,
          queuedJobCount,
          error: error.message,
          stderr: limitText(error.stderr),
          stdout: limitText(error.stdout),
          authorizationDetected: authFailure,
          imageCount: images.length,
          messages: batch.map((item) => ({
            messageId: item.messageId,
            author: item.author,
            authorId: item.authorId,
            content: limitText(item.content),
            imageCount: item.images?.length ?? 0
          }))
        });
        await message.channel.send(authFailure
          ? "我這邊叫 Codex CLI 時像是卡在外部登入或授權了。這種權限不會由 Discord 一路開通，需要妳回到 Codex/終端機完成授權後再叫我繼續。"
          : "我這邊叫 Codex CLI 的時候卡住了，先把這回合放掉，下一句可以繼續。");
      } finally {
        if (activeJobId === jobId) {
          activeJobId = null;
        }
        clearInterval(typing);
        for (const item of batch) {
          for (const image of item.images ?? []) {
            await rm(resolve(image.path, ".."), { recursive: true, force: true }).catch(() => {});
          }
        }
      }
    })
    .catch((error) => {
      console.error("[codex] queue failed:", error);
    });
}

client.on(Events.Error, (error) => {
  console.error("[discord] client error:", error);
  appendRuntimeLog("discord_client_error", {
    summary: `Discord client 錯誤：${error.message}`,
    error: error.message
  }).catch(() => {});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await appendRuntimeLog("bridge_shutdown", {
      summary: `收到關閉訊號：${signal}`,
      signal
    });
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.discordToken);
