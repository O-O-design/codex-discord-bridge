import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

let logFile = null;
let textLimit = 800;

export async function initRuntimeLog(config) {
  logFile = resolve(process.cwd(), config.bridgeLogFile);
  textLimit = config.bridgeLogMessageLimit;

  await mkdir(dirname(logFile), { recursive: true });
  await appendRuntimeLog("bridge_log_started", {
    summary: `runtime log writing to ${logFile}`
  });
}

export function limitText(value, limit = textLimit) {
  if (!value) {
    return "";
  }

  const text = String(value).replace(/[\r\n]+/g, " ⏎ ");

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export async function appendRuntimeLog(event, data = {}) {
  if (!logFile) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data
  };

  try {
    await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.warn(`[runtime-log] failed to append ${event}: ${error.message}`);
  }
}
