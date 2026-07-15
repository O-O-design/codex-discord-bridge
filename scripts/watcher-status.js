import { readFile } from "node:fs/promises";
import { getConfig } from "../src/config.js";
import { readWatcherLease } from "../src/watcher-lease.js";

function compact(value, limit = 96) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const text = String(value).replace(/[\r\n]+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseNdjson(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readNdjson(path) {
  try {
    return parseNdjson(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function latest(entries, event) {
  return entries.findLast((entry) => entry.event === event) ?? null;
}

function printEvent(label, entry) {
  if (!entry) {
    console.log(`${label}: -`);
    return;
  }

  console.log(`${label}: ${entry.ts ?? "-"} ${compact(entry.summary ?? entry.event)}`);
}

const config = getConfig({ requireDiscord: false });
const lease = await readWatcherLease(config);
const relayState = await readJson(config.codexAppRelayStateFile, { processedIds: [] });
const processedIds = new Set(Array.isArray(relayState.processedIds) ? relayState.processedIds : []);
const inboxEntries = await readNdjson(config.discordInboxFile);
const bridgeEntries = await readNdjson(config.bridgeLogFile);
const appEvents = await readNdjson(config.codexAppEventLogFile);
const pending = inboxEntries.filter((entry) => !processedIds.has(entry.id));
const lastAppTurn = [...appEvents]
  .reverse()
  .find((entry) => ["turn/started", "turn/completed", "turn/failed"].includes(entry.method));

console.log("Discord Watcher status");
console.log(`active: ${lease.active ? "yes" : "no"}`);
console.log(`room: ${lease.roomId ?? "-"}`);
console.log(`thread: ${lease.threadId ?? "-"}`);
console.log(`epoch: ${lease.epoch ?? "-"}`);
console.log(`pending inbox: ${pending.length}`);
console.log(`processed inbox: ${processedIds.size}`);
printEvent("latest relay start", latest(bridgeEntries, "frontstage_relay_started"));
printEvent("latest accepted", latest(bridgeEntries, "message_accepted"));
printEvent("latest inbox", latest(bridgeEntries, "frontstage_inbox_received"));
printEvent("latest turn start", latest(bridgeEntries, "frontstage_relay_turn_started"));
printEvent("latest turn done", latest(bridgeEntries, "frontstage_relay_turn_completed"));
if (lastAppTurn) {
  console.log(`latest app turn: ${lastAppTurn.ts ?? "-"} ${lastAppTurn.method} ${compact(lastAppTurn.turnStatus)}`);
} else {
  console.log("latest app turn: -");
}
