import { readFile } from "node:fs/promises";
import { getConfig } from "../src/config.js";

function parseArgs(argv) {
  const limitArg = argv.find((arg) => /^\d+$/.test(arg));

  return {
    limit: limitArg ? Number.parseInt(limitArg, 10) : 40,
    json: argv.includes("--json")
  };
}

function compact(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function formatEntry(entry) {
  const parts = [
    entry.ts,
    compact(entry.method),
    `id=${compact(entry.id)}`,
    `thread=${compact(entry.threadId)}`,
    `turn=${compact(entry.turnId)}`,
    `item=${compact(entry.itemType)}:${compact(entry.itemPhase)}:${compact(entry.itemId)}`,
    `status=${compact(entry.turnStatus)}`,
    `request=${compact(entry.requestMethod)}`
  ];

  return parts.join(" · ");
}

const config = getConfig({ requireDiscord: false });
const args = parseArgs(process.argv.slice(2));

try {
  const content = await readFile(config.codexAppEventLogFile, "utf8");
  const entries = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .slice(-args.limit);

  if (entries.length === 0) {
    console.log("No app-server events yet.");
  } else if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    console.log(entries.map(formatEntry).join("\n"));
  }
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("No app-server events yet.");
  } else {
    throw error;
  }
}
