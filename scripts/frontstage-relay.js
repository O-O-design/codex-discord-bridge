import "dotenv/config";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendRuntimeLog, initRuntimeLog } from "../src/runtime-log.js";
import { getConfig } from "../src/config.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = getConfig({ requireDiscord: false });

if (!config.codexAppThreadId) {
  throw new Error("Missing CODEX_APP_THREAD_ID. Leave the relay stopped for manual inbox mode.");
}

class AppServerClient {
  constructor(cliPath) {
    this.cliPath = cliPath;
    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turnWaiter = null;
    this.activeTurnId = null;
    this.agentMessages = new Map();
    this.agentDeltas = new Map();
    this.onApprovalRequest = null;
  }

  async start() {
    this.child = spawn(this.cliPath, ["app-server", "--listen", "stdio://"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[app-server] ${chunk}`);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        this.failAll(new Error(`Codex app-server exited (${code ?? "signal " + signal})`));
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-discord-bridge-frontstage",
        version: "0.2.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    await this.request("thread/resume", {
      threadId: config.codexAppThreadId,
      excludeTurns: true
    });
  }

  request(method, params) {
    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for app-server request: ${method}`));
      }, 60_000);

      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout, method });
      this.child.stdin.write(payload);
    });
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.warn(`[app-server] ignored non-JSON output: ${line}`);
      return;
    }

    if (message.method && message.params && message.id !== undefined) {
      this.onApprovalRequest?.(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params ?? {};
    if (message.method === "turn/started" && params.threadId === config.codexAppThreadId) {
      this.activeTurnId = params.turn?.id ?? null;
    }

    if (message.method === "item/agentMessage/delta" && this.isActiveTurn(params)) {
      const current = this.agentDeltas.get(params.itemId) ?? "";
      this.agentDeltas.set(params.itemId, current + (params.delta ?? ""));
    }

    if (message.method === "item/completed" && this.isActiveTurn(params)) {
      const item = params.item;
      if (item?.type === "agentMessage") {
        this.agentMessages.set(item.id, {
          phase: item.phase ?? null,
          text: item.text ?? ""
        });
      }
    }

    if (message.method === "serverRequest" && this.isActiveTurn(params)) {
      this.onApprovalRequest?.(message);
    }

    if (message.method === "turn/completed" && params.threadId === config.codexAppThreadId) {
      this.turnWaiter?.resolve({ turn: params.turn, text: this.finalText() });
      this.turnWaiter = null;
      this.activeTurnId = null;
    }

    if (message.method === "error" && this.turnWaiter) {
      this.turnWaiter.reject(new Error(params.message || "Codex app-server error."));
      this.turnWaiter = null;
      this.activeTurnId = null;
    }
  }

  isActiveTurn(params) {
    return params.threadId === config.codexAppThreadId &&
      (!this.activeTurnId || !params.turnId || params.turnId === this.activeTurnId);
  }

  finalText() {
    const completed = [...this.agentMessages.values()];
    const preferred = completed.filter((item) => item.phase === "final_answer");
    const fallback = completed.filter((item) => item.phase === null);
    const messages = preferred.length > 0 ? preferred : fallback.length > 0 ? fallback : completed;
    const text = messages.map((item) => item.text).filter(Boolean).join("\n\n").trim();
    if (text) {
      return text;
    }

    return [...this.agentDeltas.values()].join("").trim();
  }

  async startTurn(entry) {
    this.agentMessages.clear();
    this.agentDeltas.clear();
    this.activeTurnId = null;
    const completion = new Promise((resolveTurn, rejectTurn) => {
      this.turnWaiter = { resolve: resolveTurn, reject: rejectTurn };
    });

    await this.request("turn/start", {
      threadId: config.codexAppThreadId,
      input: buildTurnInput(entry),
      approvalPolicy: "on-request",
      summary: "concise",
      clientUserMessageId: entry.id
    });

    return completion;
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.turnWaiter?.reject(error);
    this.turnWaiter = null;
  }

  stop() {
    this.child?.kill();
  }
}

function buildTurnInput(entry) {
  const first = entry.messages?.[0];
  const lines = [
    "[Discord 前台訊息]",
    `來源：${entry.guild ?? "私訊"} / ${entry.channel}`,
    `訊息批次：${entry.batchSize ?? entry.messages?.length ?? 1} 則`,
    "",
    "Discord bridge 是你的麥克風、眼睛與發聲器，不是另一個 AI 人格。請直接接續目前 Codex task 的上下文。",
    "這一輪的最終回覆會由 relay 自動送回原 Discord 訊息，不要自行再呼叫 dc:send。",
    "如果內容涉及修改檔案、執行程式、網路操作或其他開發工作，先在回覆中詢問穆穆是否要開始，收到明確同意後才動工。",
    ""
  ];

  for (const message of entry.messages ?? []) {
    lines.push(`${message.author}：`);
    if (message.replyContext) {
      lines.push(message.replyContext);
    }
    lines.push(message.content || "[無文字]");
    for (const image of message.images ?? []) {
      lines.push(`附圖路徑：${image.path}`);
    }
    lines.push("");
  }

  const input = [{ type: "text", text: lines.join("\n").trim() }];
  for (const image of entry.messages?.flatMap((message) => message.images ?? []) ?? []) {
    input.push({ type: "image", url: pathToFileURL(image.path).href });
  }

  if (!first) {
    throw new Error(`Inbox entry has no messages: ${entry.id}`);
  }

  return input;
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(config.codexAppRelayStateFile, "utf8"));
    return {
      processedIds: new Set(state.processedIds ?? []),
      initialized: state.initialized === true
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { processedIds: new Set(), initialized: false };
    }
    throw error;
  }
}

async function writeState(state) {
  await mkdir(dirname(config.codexAppRelayStateFile), { recursive: true });
  await writeFile(
    config.codexAppRelayStateFile,
    `${JSON.stringify({
      initialized: state.initialized === true,
      processedIds: [...state.processedIds].slice(-1000)
    }, null, 2)}\n`,
    "utf8"
  );
}

async function readInbox() {
  try {
    const content = await readFile(config.discordInboxFile, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function parseReply(text) {
  const files = [];
  let isPrivate = false;
  const content = text
    .split("\n")
    .filter((line) => {
      const upload = line.match(/^\s*\[\[discord-upload:(.+?)\]\]\s*$/i);
      if (upload) {
        files.push(upload[1].trim());
        return false;
      }
      if (/^\s*\[\[discord-private\]\]\s*$/i.test(line)) {
        isPrivate = true;
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();

  return { content, files, isPrivate };
}

function sendDiscordReply(entry, text) {
  const reply = parseReply(text);
  const args = [resolve(projectRoot, "scripts/send-discord-message.js")];
  const first = entry.messages?.[0];
  const targetPrivate = entry.isDm || (reply.isPrivate && entry.canPrivateReply);

  if (targetPrivate) {
    args.push("--dm", first.authorId);
  } else {
    args.push("--channel", entry.channelId, "--reply", entry.triggerMessageId);
  }

  if (reply.content) {
    args.push("--content", reply.content);
  }
  for (const file of reply.files) {
    args.push("--file", file);
  }

  return new Promise((resolveSend, rejectSend) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", rejectSend);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveSend(output.trim());
      } else {
        rejectSend(new Error(`Discord reply failed (${code}): ${output.trim()}`));
      }
    });
  });
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

await initRuntimeLog(config);
const state = await readState();
if (!state.initialized && !config.codexAppRelayReplayExisting) {
  const baselineBefore = Date.now() - config.codexAppRelayBaselineGraceMs;
  let skippedCount = 0;
  let pendingCount = 0;
  for (const entry of await readInbox()) {
    const entryTime = Date.parse(entry.ts ?? "");
    if (!Number.isNaN(entryTime) && entryTime >= baselineBefore) {
      pendingCount += 1;
      continue;
    }
    state.processedIds.add(entry.id);
    skippedCount += 1;
  }
  state.initialized = true;
  await writeState(state);
  await appendRuntimeLog("frontstage_relay_baselined", {
    summary: "前台 relay 已略過過期 inbox，保留剛抵達的訊息",
    skippedCount,
    pendingCount,
    graceMs: config.codexAppRelayBaselineGraceMs
  });
}
const appServer = new AppServerClient(config.codexCliPath);
const retryAfter = new Map();

appServer.onApprovalRequest = async (request) => {
  const entry = appServer.currentEntry;
  await appendRuntimeLog("frontstage_relay_approval_required", {
    summary: "Codex task 等待使用者授權",
    threadId: config.codexAppThreadId,
    request: request.method
  });
  if (entry) {
    try {
      await sendDiscordReply(entry, "我已經把這一輪交給 Codex task，但它正在等待妳在 Codex 視窗授權；我先停在這裡，不會替妳放行。\n[[discord-private]]");
    } catch (error) {
      console.warn(`[relay] approval notice failed: ${error.message}`);
    }
  }
};

await appServer.start();
await appendRuntimeLog("frontstage_relay_started", {
  summary: `前台 relay 已連到 Codex task：${config.codexAppThreadId}`,
  threadId: config.codexAppThreadId
});

async function processPending() {
  const now = Date.now();
  const entries = await readInbox();
  for (const entry of entries) {
    if (state.processedIds.has(entry.id) || (retryAfter.get(entry.id) ?? 0) > now) {
      continue;
    }

    appServer.currentEntry = entry;
    try {
      await appendRuntimeLog("frontstage_relay_turn_started", {
        summary: `前台 relay 送入 Codex task：${entry.id}`,
        inboxId: entry.id,
        threadId: config.codexAppThreadId,
        batchSize: entry.batchSize
      });
      const result = await appServer.startTurn(entry);
      if (result.turn?.status === "failed") {
        throw new Error(result.turn.error?.message || "Codex task turn failed.");
      }
      if (result.text) {
        await sendDiscordReply(entry, result.text);
      }
      state.processedIds.add(entry.id);
      state.initialized = true;
      await writeState(state);
      retryAfter.delete(entry.id);
      await appendRuntimeLog("frontstage_relay_turn_completed", {
        summary: `前台 relay 已回傳 Discord：${entry.id}`,
        inboxId: entry.id,
        threadId: config.codexAppThreadId,
        responseChars: result.text?.length ?? 0
      });
    } catch (error) {
      retryAfter.set(entry.id, Date.now() + 10_000);
      await appendRuntimeLog("frontstage_relay_failed", {
        summary: `前台 relay 失敗：${entry.id}`,
        inboxId: entry.id,
        threadId: config.codexAppThreadId,
        error: error.message
      });
      console.error(`[relay] ${entry.id}: ${error.message}`);
    } finally {
      appServer.currentEntry = null;
    }
  }
}

while (true) {
  await processPending();
  await sleep(config.codexAppRelayPollMs);
}
