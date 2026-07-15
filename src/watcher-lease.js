import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function fallbackLease(config) {
  return {
    version: 1,
    active: Boolean(config.codexAppThreadId),
    threadId: config.codexAppThreadId ?? null,
    epoch: 0,
    roomId: null,
    rooms: {},
    updatedAt: null,
    updatedBy: "config"
  };
}

function normalizeLease(value, config) {
  const fallback = fallbackLease(config);
  return {
    version: 1,
    active: value?.active === true,
    threadId: typeof value?.threadId === "string" && value.threadId.trim()
      ? value.threadId.trim()
      : fallback.threadId,
    epoch: Number.isSafeInteger(value?.epoch) && value.epoch >= 0 ? value.epoch : fallback.epoch,
    roomId: typeof value?.roomId === "string" && value.roomId.trim() ? value.roomId.trim() : null,
    rooms: Object.fromEntries(
      Object.entries(value?.rooms && typeof value.rooms === "object" ? value.rooms : {})
        .filter(([roomId, room]) => roomId.trim() && typeof room?.threadId === "string" && room.threadId.trim())
        .map(([roomId, room]) => [roomId.trim(), {
          threadId: room.threadId.trim(),
          status: room.status === "retired" ? "retired" : "available",
          updatedAt: typeof room.updatedAt === "string" ? room.updatedAt : null
        }])
    ),
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedBy: typeof value?.updatedBy === "string" ? value.updatedBy : fallback.updatedBy
  };
}

export async function readWatcherLease(config) {
  try {
    return normalizeLease(JSON.parse(await readFile(config.discordWatcherLeaseFile, "utf8")), config);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackLease(config);
    }
    throw error;
  }
}

export async function writeWatcherLease(config, next) {
  const lease = normalizeLease(next, config);
  const target = config.discordWatcherLeaseFile;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return lease;
}

export async function updateWatcherLease(config, update) {
  const previous = await readWatcherLease(config);
  const changed = update(previous);
  return writeWatcherLease(config, {
    ...changed,
    epoch: previous.epoch + 1,
    updatedAt: new Date().toISOString()
  });
}
