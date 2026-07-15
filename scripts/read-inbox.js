import { readFile } from "node:fs/promises";
import { getConfig } from "../src/config.js";

function parseLimit(argv) {
  const limitArg = argv.find((arg) => /^\d+$/.test(arg));
  return limitArg ? Number.parseInt(limitArg, 10) : 5;
}

function formatEntry(entry) {
  const lines = [
    `${entry.id} · ${entry.ts}`,
    `${entry.guild ?? "DM"} / ${entry.channel} · ${entry.batchSize} 則 · ${entry.imageCount ?? 0} 圖`,
    `channel=${entry.channelId} reply=${entry.triggerMessageId}`
  ];

  for (const message of entry.messages ?? []) {
    lines.push("");
    lines.push(`${message.author}:`);
    if (message.replyContext) {
      lines.push(message.replyContext);
    }
    lines.push(message.content || "[empty]");

    for (const image of message.images ?? []) {
      lines.push(`image: ${image.path}`);
    }
  }

  return lines.join("\n");
}

const config = getConfig({ requireDiscord: false });
const limit = parseLimit(process.argv.slice(2));

try {
  const content = await readFile(config.discordInboxFile, "utf8");
  const entries = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .slice(-limit);

  if (entries.length === 0) {
    console.log("Inbox is empty.");
  } else {
    console.log(entries.map(formatEntry).join("\n\n---\n\n"));
  }
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("Inbox is empty.");
  } else {
    throw error;
  }
}
