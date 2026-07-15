import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { askCodex } from "./codex.js";
import { getConfig } from "./config.js";
import { loadMemberRoster } from "./members.js";
import { appendRuntimeLog, initRuntimeLog, limitText } from "./runtime-log.js";
import { readWatcherLease, updateWatcherLease } from "./watcher-lease.js";

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

const perChannelQueues = new Map();
const perChannelActive = new Map();
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
const silentDirectivePattern = /^\s*\[\[discord-silent\]\]\s*$/i;
const devApprovalPattern = /^\s*(?:批准|同意|approve|ok)\s+([a-z0-9-]+)\s*$/i;
const devDenyPattern = /^\s*(?:拒絕|取消|deny|cancel)\s+([a-z0-9-]+)\s*$/i;
const watcherCommandPattern = /^\/(接麥|斷麥|搬家)(?:\s+([^\s]+))?(?:\s+([0-9a-f-]{8,}))?\s*$/i;
const devKeywords = [
  /寫(程式|code)|改(檔|程式|app|網站|repo)|修( bug|bug|錯|程式)?/iu,
  /做(成|一個|個)?\s*(app|APP|網站|工具|功能|橋接|程式)|建立|新增|更新|打造|蓋(好|一個)?/iu,
  /跑(程式|測試|test|build|npm|node|python|指令|命令)|執行|開發|部署|安裝套件/iu,
  /\b(git|github|commit|push|npm|node|python|build|test|deploy|terminal|shell)\b/iu,
  /終端機|版控|上傳 GitHub|上傳github|套件|依賴|server|伺服器/iu
];
const incompleteTailPattern = /(?:[，、：:（(「『《<]|[.。]{3}|[⋯…~-])$/u;
const continuationLeadPattern = /^(?:等一下|等等|先|那|所以|可是|但是|不過|另外|還有|對了|再來|因為|如果|你看|我想想|就是)/u;
const continuationTailPattern = /(?:然後|還有|另外|再來|對了|因為|所以|可是|但是|不過|如果|就是|像是|例如|等一下|等等|我想想|你看|接著|以及|而且|或是|還沒|不要急)$/u;
const shortReactionPattern = /^(?:嗯+|呃+|欸+|啊+|喔+|噗+|呼+|好+|對+|不要+|不不+|哈哈+|咳+|等一下|等等)[～~！!？?。⋯…]*$/u;

function stopBatchTyping(batch) {
  if (batch.typingTimer) {
    clearInterval(batch.typingTimer);
    batch.typingTimer = null;
  }
}

function pulseBatchTyping(batchKey, batch, message, waitMs) {
  stopBatchTyping(batch);
  const channel = message.channel;
  const stopAt = Date.now() + Math.max(waitMs, 0) + 4_000;

  channel.sendTyping().catch(() => {});
  batch.typingTimer = setInterval(() => {
    if (Date.now() > stopAt || pendingBatches.get(batchKey) !== batch) {
      stopBatchTyping(batch);
      return;
    }
    channel.sendTyping().catch(() => {});
  }, 4_000);
}

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

function semanticHoldReason(batch) {
  const authorIds = new Set(batch.messages.map((item) => item.authorId));
  if (authorIds.size !== 1) {
    return null;
  }

  const last = batch.messages.at(-1);
  const text = (last?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }

  if (incompleteTailPattern.test(text) || continuationLeadPattern.test(text) || continuationTailPattern.test(text)) {
    return "語尾未完";
  }

  if (shortReactionPattern.test(text)) {
    return "短反應";
  }

  if (batch.messages.length >= 2 && text.length <= 80) {
    return "連續短訊息";
  }

  const compact = text.replace(/[，。！？!?～~\s]/g, "");
  if (compact.length <= 32 && /[？?]$/.test(text)) {
    return "短問句";
  }

  if (compact.length > 0 && compact.length <= 14) {
    return "短句";
  }

  return null;
}

function chooseBatchWindow(batch) {
  const authorIds = new Set(batch.messages.map((item) => item.authorId));
  const baseMs = authorIds.size === 1
    ? config.discordSoloBatchWindowMs
    : config.discordBatchWindowMs;
  const reason = semanticHoldReason(batch);

  if (!reason) {
    return { waitMs: baseMs, reason: authorIds.size === 1 ? "單人基本窗" : "多人基本窗" };
  }

  const elapsedMs = Date.now() - batch.createdAt;
  const remainingMaxMs = Math.max(0, config.discordSemanticMaxHoldMs - elapsedMs);
  const semanticMs = Math.min(config.discordSemanticHoldMs, remainingMaxMs);

  if (semanticMs <= baseMs) {
    return { waitMs: baseMs, reason: `${reason}，已接近等待上限` };
  }

  return { waitMs: semanticMs, reason };
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

async function maybeHandleWatcherCommand(message, content) {
  const match = content.match(watcherCommandPattern);
  if (!match) {
    return false;
  }

  if (!writeUserIds.has(message.author.id)) {
    await message.channel.send("這個控制指令只接受主要授權者。");
    await appendRuntimeLog("watcher_command_denied", {
      summary: `拒絕 Discord Watcher 控制：${message.author.tag}`,
      command: match[1],
      authorId: message.author.id,
      channelId: message.channelId
    });
    return true;
  }

  const command = match[1];
  const roomId = match[2] ?? null;
  const targetThreadId = match[3] ?? null;
  const current = await readWatcherLease(config);

  if (command === "斷麥") {
    const lease = await updateWatcherLease(config, (previous) => ({
      ...previous,
      active: false,
      updatedBy: message.author.id
    }));
    await message.channel.send("Discord Watcher 已斷麥。Bot 保留在線，但不再把一般訊息送進 Codex。");
    await appendRuntimeLog("watcher_detached", {
      summary: "Discord Watcher 已斷麥",
      epoch: lease.epoch,
      threadId: lease.threadId,
      authorId: message.author.id,
      channelId: message.channelId
    });
    return true;
  }

  const registeredRoom = roomId ? current.rooms?.[roomId] : null;
  if (registeredRoom?.status === "retired") {
    await message.channel.send(`「${roomId}」已經退役，不能再接回麥克風。請替新房使用新的房號。`);
    return true;
  }
  const nextThreadId = targetThreadId ?? registeredRoom?.threadId ?? current.threadId ?? config.codexAppThreadId;
  if (!nextThreadId) {
    await message.channel.send("這個房號還沒有綁定 Codex task。第一次請用：`/接麥 <房號> <task-id>`。之後只要喊房號就好。");
    return true;
  }

  if (roomId && !registeredRoom && !targetThreadId) {
    await message.channel.send("新房號第一次使用需要 task ID：`/接麥 <房號> <task-id>`。綁定過後才能只用房號接麥或搬家。");
    return true;
  }

  const lease = await updateWatcherLease(config, (previous) => ({
    ...previous,
    active: true,
    threadId: nextThreadId,
    roomId: roomId ?? previous.roomId,
    rooms: roomId
      ? {
          ...previous.rooms,
          ...(previous.roomId && previous.roomId !== roomId && previous.rooms?.[previous.roomId]
            ? {
                [previous.roomId]: {
                  ...previous.rooms[previous.roomId],
                  status: "retired",
                  updatedAt: new Date().toISOString()
                }
              }
            : {}),
          [roomId]: {
            threadId: nextThreadId,
            status: "available",
            updatedAt: new Date().toISOString()
          }
        }
      : previous.rooms,
    updatedBy: message.author.id
  }));
  const moved = command === "搬家" || current.threadId !== nextThreadId || current.roomId !== lease.roomId;
  await message.channel.send(
    moved
      ? `Discord Watcher 正在搬到 ${lease.roomId ?? "新房"}。舊房已退役，舊 task 即使仍在跑也不會再回 Discord。`
      : `Discord Watcher 已接麥，正在觀測 ${lease.roomId ?? "目前房"}。`
  );
  await appendRuntimeLog(moved ? "watcher_moved" : "watcher_attached", {
    summary: moved ? "Discord Watcher 正在搬家" : "Discord Watcher 已接麥",
    epoch: lease.epoch,
    fromThreadId: current.threadId,
    threadId: lease.threadId,
    fromRoomId: current.roomId,
    roomId: lease.roomId,
    authorId: message.author.id,
    channelId: message.channelId
  });
  return true;
}

function isAddressedToBot(message, content) {
  if (isDmMessage(message)) {
    return { matched: true, reason: "dm" };
  }

  if (message.mentions?.users?.has?.(client.user.id)) {
    return { matched: true, reason: "mention" };
  }

  const referenceId = message.reference?.messageId;
  if (referenceId) {
    const cached = message.channel?.messages?.cache?.get?.(referenceId);
    if (cached?.author?.id === client.user.id) {
      return { matched: true, reason: "reply_to_me" };
    }
  }

  const patterns = config.discordAddressPatterns ?? [];
  for (const pattern of patterns) {
    if (!pattern) {
      continue;
    }
    if (content.includes(pattern)) {
      return { matched: true, reason: "name_called", pattern };
    }
  }

  const alwaysRespond = new Set(config.discordAlwaysRespondChannelIds ?? []);
  if (alwaysRespond.has(message.channelId)) {
    return { matched: true, reason: "always_respond_channel" };
  }

  if (config.discordWakeOnAllowedMessage) {
    return {
      matched: true,
      reason: message.author.bot ? "peer_bot_wake" : "allowlisted_wake"
    };
  }

  return { matched: false, reason: "not_addressed" };
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
  let silent = false;
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

    if (silentDirectivePattern.test(line)) {
      silent = true;
      continue;
    }

    textLines.push(line);
  }

  return {
    text: textLines.join("\n").trim(),
    uploadPaths,
    privateReply,
    silent
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
  if (directives.silent) {
    await appendRuntimeLog("discord_silent_reply", {
      summary: `Codex 判定不回 Discord：${channelLabel(message)}`,
      channelId: message.channelId,
      channel: channelLabel(message),
      author: message.author.tag,
      authorId: message.author.id
    });
    return;
  }

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

  await message.channel.sendTyping().catch(() => {});
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
  if (await maybeHandleWatcherCommand(message, content)) {
    return;
  }

  if (config.discordDeliveryMode === "inbox") {
    const lease = await readWatcherLease(config);
    if (!lease.active) {
      await appendRuntimeLog("watcher_silent", {
        summary: `Discord Watcher 未接麥，略過 ${message.author.tag} 的一般訊息`,
        channelId: message.channelId,
        channel: channelLabel(message),
        messageId: message.id,
        authorId: message.author.id,
        epoch: lease.epoch
      });
      return;
    }
  }

  if (await maybeHandleApprovalCommand(message, content)) {
    return;
  }

  const addressed = isAddressedToBot(message, content);
  if (!addressed.matched) {
    await appendRuntimeLog("decided_silent", {
      summary: `安靜略過：${message.author.tag} 在 ${channelLabel(message)}（${addressed.reason}）`,
      reason: addressed.reason,
      messageId: message.id,
      guildId: message.guildId,
      guild: message.guild?.name ?? null,
      channelId: message.channelId,
      channel: channelLabel(message),
      parentChannelId: message.channel?.parentId ?? null,
      author: message.author.tag,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      content: limitText(content)
    });
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
    imageCount: images.length,
    addressedReason: addressed.reason,
    addressedPattern: addressed.pattern ?? null
  });

  const batchKey = channelStateKey(message);
  const batch = pendingBatches.get(batchKey) ?? {
    messages: [],
    timer: null,
    typingTimer: null,
    triggerMessage: message,
    createdAt: Date.now()
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

  const isFirstInBatch = batch.messages.length === 1;
  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  const batchWindow = chooseBatchWindow(batch);
  pulseBatchTyping(batchKey, batch, message, batchWindow.waitMs);
  if (isFirstInBatch) {
    appendRuntimeLog("waiting_debounce", {
      summary: `等待合併窗：${message.author.tag} 在 ${channelLabel(message)}，${batchWindow.reason}`,
      channelId: message.channelId,
      channel: channelLabel(message),
      messageId: message.id,
      author: message.author.tag,
      authorId: message.author.id,
      waitMs: batchWindow.waitMs,
      waitReason: batchWindow.reason
    }).catch(() => {});
  } else {
    appendRuntimeLog("merged_into_batch", {
      summary: `併入 batch：${message.author.tag} 在 ${channelLabel(message)}，第 ${batch.messages.length} 則，${batchWindow.reason}`,
      channelId: message.channelId,
      channel: channelLabel(message),
      messageId: message.id,
      author: message.author.tag,
      authorId: message.author.id,
      batchSize: batch.messages.length,
      waitMs: batchWindow.waitMs,
      waitReason: batchWindow.reason
    }).catch(() => {});
  }

  batch.timer = setTimeout(() => {
    pendingBatches.delete(batchKey);
    stopBatchTyping(batch);

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
  }, batchWindow.waitMs);

  pendingBatches.set(batchKey, batch);
});

function sandboxForBatch(batch) {
  return batch.every((item) => writeUserIds.has(item.authorId)) ? config.codexSandbox : "read-only";
}

function enqueueCodexBatch(message, batch, options = {}) {
  const first = batch[0];
  const jobId = `codex-${Date.now().toString(36)}-${(++nextJobNumber).toString(36)}`;
  const queueKey = message.channelId;
  const prevActive = perChannelActive.get(queueKey);
  const effectiveBatch = prevActive?.effectiveBatch
    ? [...prevActive.effectiveBatch, ...batch]
    : batch;
  const sandbox = sandboxForBatch(effectiveBatch);
  const images = effectiveBatch.flatMap((item) => item.images ?? []);
  const batchContext = { jobId, superseded: false, effectiveBatch };
  if (prevActive && !prevActive.superseded) {
    prevActive.superseded = true;
    appendRuntimeLog("superseded_by_new", {
      summary: `舊任務作廢：${prevActive.jobId} 被 ${jobId} 覆蓋（${first.channel}）`,
      queueKey,
      channelId: message.channelId,
      channel: first.channel,
      oldJobId: prevActive.jobId,
      newJobId: jobId
    }).catch(() => {});
  }
  perChannelActive.set(queueKey, batchContext);
  const content =
    effectiveBatch.length === 1
      ? [first.replyContext, first.content].filter(Boolean).join("\n")
      : [
          "以下是同一個 Discord 頻道內短時間連續訊息，請整體理解後自然回覆，不要逐句機械拆答：",
          "",
          ...effectiveBatch.map((item) =>
            [item.replyContext, `${item.author}: ${item.content}`].filter(Boolean).join("\n")
          )
        ].join("\n");

  queuedJobCount += 1;
  appendRuntimeLog("codex_queued", {
    summary: `Codex 任務已排隊：${jobId}，${effectiveBatch.length} 則訊息，位置 ${first.channel}`,
    jobId,
    queueKey,
    guild: first.guild,
    channel: first.channel,
    channelId: message.channelId,
    batchSize: effectiveBatch.length,
    sandbox,
    queuedJobCount,
    activeJobId,
    approvalId: options.approvalId ?? null,
    imageCount: images.length,
    messages: effectiveBatch.map((item) => ({
      messageId: item.messageId,
      author: item.author,
      authorId: item.authorId,
      content: limitText(item.content),
      imageCount: item.images?.length ?? 0
    })),
    authors: effectiveBatch.map((item) => ({
      author: item.author,
      authorId: item.authorId
    }))
  }).catch(() => {});

  const prev = perChannelQueues.get(queueKey) ?? Promise.resolve();
  const jobPromise = prev
    .then(async () => {
      if (batchContext.superseded) {
        queuedJobCount = Math.max(queuedJobCount - 1, 0);
        await appendRuntimeLog("codex_skipped_superseded", {
          summary: `略過已過期任務：${jobId}（${first.channel}），等待較新的合併任務`,
          jobId,
          queueKey,
          guild: first.guild,
          channel: first.channel,
          channelId: message.channelId,
          batchSize: effectiveBatch.length,
          queuedJobCount,
          activeJobId
        });
        return;
      }

      const startedAt = Date.now();
      activeJobId = jobId;
      queuedJobCount = Math.max(queuedJobCount - 1, 0);
      await message.channel.sendTyping();
      await appendRuntimeLog("codex_start", {
        summary: `Codex 開始處理：${jobId}，${effectiveBatch.length} 則訊息，權限 ${sandbox}`,
        jobId,
        guild: first.guild,
        channel: first.channel,
        channelId: message.channelId,
        batchSize: effectiveBatch.length,
        sandbox,
        queuedJobCount,
        activeJobId,
        approvalId: options.approvalId ?? null,
        imageCount: images.length,
        messages: effectiveBatch.map((item) => ({
          messageId: item.messageId,
          author: item.author,
          authorId: item.authorId,
          content: limitText(item.content),
          imageCount: item.images?.length ?? 0
        })),
        authors: effectiveBatch.map((item) => ({
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
            messages: effectiveBatch.map((item) => ({
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
          messages: effectiveBatch.map((item) => ({
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

        if (batchContext.superseded) {
          await appendRuntimeLog("codex_discarded_superseded", {
            summary: `已丟棄過期回覆：${jobId}（${first.channel}）跑完但被新任務覆蓋`,
            jobId,
            queueKey,
            guild: first.guild,
            channel: first.channel,
            channelId: message.channelId,
            sandbox,
            durationMs: Date.now() - startedAt,
            responseLength: response.length,
            response: limitText(response),
            imageCount: images.length,
            messages: effectiveBatch.map((item) => ({
              messageId: item.messageId,
              author: item.author,
              authorId: item.authorId,
              content: limitText(item.content),
              imageCount: item.images?.length ?? 0
            }))
          });
          return;
        }

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
          messages: effectiveBatch.map((item) => ({
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
          messages: effectiveBatch.map((item) => ({
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
        if (perChannelActive.get(queueKey) === batchContext) {
          perChannelActive.delete(queueKey);
        }
        clearInterval(typing);
        for (const item of effectiveBatch) {
          for (const image of item.images ?? []) {
            await rm(resolve(image.path, ".."), { recursive: true, force: true }).catch(() => {});
          }
        }
      }
    })
    .catch((error) => {
      console.error(`[codex] queue failed (channel ${queueKey}):`, error);
    });

  perChannelQueues.set(queueKey, jobPromise);
  jobPromise.finally(() => {
    if (perChannelQueues.get(queueKey) === jobPromise) {
      perChannelQueues.delete(queueKey);
    }
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
