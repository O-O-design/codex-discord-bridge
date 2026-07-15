import "dotenv/config";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRuntimeLog, initRuntimeLog } from "../src/runtime-log.js";
import { getConfig } from "../src/config.js";
import { readWatcherLease } from "../src/watcher-lease.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = getConfig({ requireDiscord: false });

const maxEventStringLength = 2000;
const maxEventArrayLength = 50;
const maxEventObjectKeys = 80;
const maxEventDepth = 8;
const sensitiveKeyPattern = /token|secret|password|authorization|cookie|api[_-]?key|credential|session/i;
const discordTokenPattern = /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/g;
let eventLogReady = null;
let eventLogFailureReported = false;

function truncateText(text, maxLength = maxEventStringLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...[truncated ${text.length - maxLength} chars]`;
}

function sanitizeString(value) {
  return truncateText(String(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[redacted]")
    .replace(discordTokenPattern, "[redacted-token]"));
}

function sanitizeForEventLog(value, depth = 0, parentKey = "") {
  if (sensitiveKeyPattern.test(parentKey)) {
    return "[redacted]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }

  if (depth >= maxEventDepth) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, maxEventArrayLength)
      .map((item) => sanitizeForEventLog(item, depth + 1, parentKey));
    if (value.length > maxEventArrayLength) {
      items.push(`[truncated ${value.length - maxEventArrayLength} items]`);
    }
    return items;
  }

  const entries = Object.entries(value);
  const out = {};
  for (const [key, item] of entries.slice(0, maxEventObjectKeys)) {
    out[key] = sanitizeForEventLog(item, depth + 1, key);
  }
  if (entries.length > maxEventObjectKeys) {
    out.__truncated_keys = entries.length - maxEventObjectKeys;
  }
  return out;
}

function summarizeAppServerMessage(message) {
  const params = message.params ?? {};
  const item = params.item ?? {};
  const turn = params.turn ?? {};

  return {
    method: message.method ?? null,
    id: message.id ?? null,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? turn.id ?? null,
    itemId: params.itemId ?? item.id ?? null,
    itemType: item.type ?? null,
    itemPhase: item.phase ?? null,
    turnStatus: turn.status ?? null,
    requestMethod: message.__requestMethod ?? params.method ?? params.request?.method ?? null
  };
}

function compactStatusText(value, maxLength = 120) {
  if (!value) {
    return "";
  }

  const text = String(value).replace(/[\r\n]+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function commandActionSummary(item) {
  const action = item?.commandActions?.[0];
  if (!action) {
    return compactStatusText(item?.command || item?.source || "指令");
  }

  const actionLabel = {
    read: "讀取",
    write: "寫入",
    edit: "編輯",
    listFiles: "列檔",
    search: "搜尋",
    unknown: "執行"
  }[action.type] || action.type || "工具";

  return compactStatusText(`${actionLabel}${action.name ? ` ${action.name}` : ""}`);
}

function summarizeAgentRuntimeEvent(message, threadId, currentEntry) {
  const params = message.params ?? {};
  const item = params.item ?? {};
  const messageThreadId = params.threadId ?? item.threadId ?? null;
  const method = message.method;

  if (messageThreadId && messageThreadId !== threadId) {
    return null;
  }

  const base = {
    inboxId: currentEntry?.id ?? item.clientId ?? null,
    threadId,
    turnId: params.turnId ?? params.turn?.id ?? null,
    itemId: params.itemId ?? item.id ?? null,
    itemType: item.type ?? null,
    itemPhase: item.phase ?? null,
    channel: currentEntry?.channel ?? null,
    channelId: currentEntry?.channelId ?? null,
    batchSize: currentEntry?.batchSize ?? null
  };

  if (method === "turn/started") {
    return {
      event: "agent_event_turn_started",
      summary: "Agent Event Stream：Codex turn 開始",
      ...base
    };
  }

  if (method === "turn/completed") {
    return {
      event: "agent_event_turn_completed",
      summary: "Agent Event Stream：Codex turn 完成",
      ...base,
      durationMs: params.turn?.durationMs ?? null,
      turnStatus: params.turn?.status ?? null
    };
  }

  if (method === "turn/failed") {
    return {
      event: "agent_event_turn_failed",
      summary: "Agent Event Stream：Codex turn 失敗",
      ...base,
      error: params.turn?.error?.message ?? params.message ?? null
    };
  }

  if (method === "serverRequest") {
    return {
      event: "agent_event_approval_required",
      summary: "Agent Event Stream：Codex 正在等待授權",
      ...base,
      request: params.method ?? params.request?.method ?? "approval"
    };
  }

  if (method === "thread/status/changed") {
    const status = params.status?.type ?? null;
    if (!status || !["active", "idle"].includes(status)) {
      return null;
    }
    return {
      event: "agent_event_task_status",
      summary: `Agent Event Stream：Codex task ${status === "active" ? "處理中" : "待命"}`,
      ...base,
      taskStatus: status
    };
  }

  if (method === "item/started") {
    if (item.type === "commandExecution") {
      return {
        event: "agent_event_tool_started",
        summary: `Agent Event Stream：工具開始 - ${commandActionSummary(item)}`,
        ...base,
        commandAction: commandActionSummary(item),
        cwd: item.cwd ?? null
      };
    }
    if (item.type === "contextCompaction") {
      return {
        event: "agent_event_context_compaction_started",
        summary: "Agent Event Stream：上下文壓縮開始",
        ...base
      };
    }
    if (item.type === "reasoning") {
      return {
        event: "agent_event_reasoning_started",
        summary: "Agent Event Stream：Codex 正在整理判斷",
        ...base
      };
    }
    if (item.type === "agentMessage") {
      return {
        event: item.phase === "final_answer" ? "agent_event_response_started" : "agent_event_status_message_started",
        summary: item.phase === "final_answer"
          ? "Agent Event Stream：開始產生 Discord 回覆"
          : "Agent Event Stream：產生狀態訊息",
        ...base
      };
    }
  }

  if (method === "item/completed") {
    if (item.type === "commandExecution") {
      return {
        event: "agent_event_tool_completed",
        summary: `Agent Event Stream：工具完成 - ${commandActionSummary(item)}`,
        ...base,
        commandAction: commandActionSummary(item),
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null
      };
    }
    if (item.type === "contextCompaction") {
      return {
        event: "agent_event_context_compaction_completed",
        summary: "Agent Event Stream：上下文壓縮完成",
        ...base
      };
    }
    if (item.type === "reasoning") {
      return {
        event: "agent_event_reasoning_completed",
        summary: "Agent Event Stream：判斷段落完成",
        ...base
      };
    }
    if (item.type === "agentMessage") {
      return {
        event: item.phase === "final_answer" ? "agent_event_response_completed" : "agent_event_status_message_completed",
        summary: item.phase === "final_answer"
          ? "Agent Event Stream：Discord 回覆已產生"
          : "Agent Event Stream：狀態訊息已產生",
        ...base
      };
    }
  }

  return null;
}

const visibleEventAllowlist = new Set([
  "frontstage_relay_started",
  "watcher_handoff_started",
  "watcher_handoff_completed",
  "frontstage_relay_skipped_superseded_inbox",
  "frontstage_relay_waiting_newer_message",
  "frontstage_relay_visible_task_work_started",
  "frontstage_relay_turn_started",
  "frontstage_relay_turn_timeout",
  "frontstage_relay_reply_discarded_handoff",
  "frontstage_relay_reply_deferred_newer_message",
  "frontstage_relay_turn_completed",
  "frontstage_relay_failed",
  "frontstage_relay_restarting",
  "frontstage_relay_recovered",
  "frontstage_relay_restart_failed",
  "frontstage_relay_approval_required",
  "agent_event_turn_started",
  "agent_event_turn_completed",
  "agent_event_turn_failed",
  "agent_event_approval_required",
  "agent_event_tool_started",
  "agent_event_tool_completed",
  "agent_event_context_compaction_started",
  "agent_event_context_compaction_completed",
  "agent_event_response_started",
  "agent_event_response_completed"
]);

function visibleEventDetails(event) {
  const details = [];
  if (event.channel) {
    details.push(`位置：${event.channel}`);
  }
  if (event.batchSize) {
    details.push(`批次：${event.batchSize} 則`);
  }
  if (event.commandAction) {
    details.push(`工具：${event.commandAction}`);
  }
  if (event.durationMs) {
    details.push(`耗時：${Math.max(1, Math.round(event.durationMs / 1000))} 秒`);
  }
  if (event.attempts) {
    details.push(`重試：${event.attempts}/${event.maxRelayFailures ?? "?"}`);
  }
  if (event.error) {
    details.push(`錯誤：${compactStatusText(event.error, 160)}`);
  }
  if (event.inboxId) {
    details.push(`inbox：${compactStatusText(event.inboxId, 80)}`);
  }
  return details;
}

function visibleEventText(event) {
  const summary = compactStatusText(event.summary ?? event.event, 180);
  if (!summary) {
    return "";
  }

  const details = visibleEventDetails(event);
  return [
    "[Discord Watcher + Agent Event Stream]",
    summary,
    ...details
  ].join("\n");
}

function visibleEventLine(event) {
  const summary = compactStatusText(event.summary ?? event.event, 160);
  if (!summary) {
    return "";
  }

  const details = visibleEventDetails(event)
    .filter((detail) => !detail.startsWith("inbox："))
    .slice(0, 3);
  return details.length > 0
    ? `- ${summary}（${details.join("；")}）`
    : `- ${summary}`;
}

function visibleBufferedEventText(events) {
  const lines = events.map(visibleEventLine).filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  const visibleLines = lines.slice(0, 12);
  if (lines.length > visibleLines.length) {
    visibleLines.push(`- 另有 ${lines.length - visibleLines.length} 筆狀態已寫入 runtime log`);
  }

  return [
    "[Discord Watcher + Agent Event Stream]",
    "本輪 Codex 處理期間的狀態補記：",
    ...visibleLines
  ].join("\n");
}

async function appendAppServerEvent(message) {
  if (!config.codexAppEventLogEnabled) {
    return;
  }

  try {
    eventLogReady ??= mkdir(dirname(config.codexAppEventLogFile), { recursive: true });
    await eventLogReady;
    await appendFile(
      config.codexAppEventLogFile,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...summarizeAppServerMessage(message),
        message: sanitizeForEventLog(message)
      })}\n`,
      "utf8"
    );
  } catch (error) {
    if (!eventLogFailureReported) {
      eventLogFailureReported = true;
      console.warn(`[app-server-event-log] failed: ${error.message}`);
    }
  }
}

class AppServerClient {
  constructor(cliPath, threadId) {
    this.cliPath = cliPath;
    this.threadId = threadId;
    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turnWaiter = null;
    this.activeTurnId = null;
    this.turnInProgress = false;
    this.agentMessages = new Map();
    this.agentDeltas = new Map();
    this.onApprovalRequest = null;
    this.visibleEventQueue = Promise.resolve();
    this.lastVisibleEventAt = 0;
    this.lastVisibleEventKey = null;
    this.visibleEventFailureReported = false;
    this.bufferedVisibleEvents = [];
    this.processGeneration = 0;
  }

  async start() {
    const generation = ++this.processGeneration;
    const child = spawn(this.cliPath, ["app-server", "--listen", "stdio://"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.processGeneration === generation && this.child === child) {
        this.handleLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (this.processGeneration === generation && this.child === child) {
        process.stderr.write(`[app-server] ${chunk}`);
      }
    });
    child.on("error", (error) => {
      if (this.processGeneration === generation && this.child === child) {
        this.failAll(error);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.processGeneration === generation && this.child === child && (code !== 0 || signal)) {
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

    await this.resumeThread(this.threadId);
  }

  async resumeThread(threadId) {
    if (!threadId) {
      throw new Error("Discord Watcher has no target Codex task ID.");
    }
    await this.request("thread/resume", {
      threadId,
      excludeTurns: true
    });
    this.threadId = threadId;
    this.agentMessages.clear();
    this.agentDeltas.clear();
    this.activeTurnId = null;
    this.turnInProgress = false;
  }

  async restart(reason) {
    const previousChild = this.child;
    this.processGeneration += 1;
    this.child = null;
    this.failAll(new Error(`Codex app-server restarting: ${reason}`));
    this.activeTurnId = null;
    this.turnInProgress = false;
    this.agentMessages.clear();
    this.agentDeltas.clear();
    this.bufferedVisibleEvents = [];
    if (previousChild && !previousChild.killed) {
      previousChild.kill();
    }
    await this.start();
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

    const messageForLog = message.id !== undefined && this.pending.has(message.id)
      ? { ...message, __requestMethod: this.pending.get(message.id).method }
      : message;
    void appendAppServerEvent(messageForLog);
    const runtimeEvent = summarizeAgentRuntimeEvent(message, this.threadId, this.currentEntry);
    if (runtimeEvent) {
      void appendRuntimeLog(runtimeEvent.event, runtimeEvent);
      this.enqueueVisibleEvent(runtimeEvent);
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
    if (message.method === "turn/started" && params.threadId === this.threadId) {
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

    if (message.method === "turn/completed" && params.threadId === this.threadId) {
      this.turnInProgress = false;
      this.activeTurnId = null;
      this.turnWaiter?.resolve({ turn: params.turn, text: this.finalText() });
      this.turnWaiter = null;
      void this.flushBufferedVisibleEvents();
    }

    if (message.method === "error" && this.turnWaiter) {
      this.turnInProgress = false;
      this.turnWaiter.reject(new Error(params.message || "Codex app-server error."));
      this.turnWaiter = null;
      this.activeTurnId = null;
    }
  }

  isActiveTurn(params) {
    return params.threadId === this.threadId &&
      (!this.activeTurnId || !params.turnId || params.turnId === this.activeTurnId);
  }

  hasLiveTurn() {
    return this.turnInProgress || Boolean(this.activeTurnId);
  }

  finalText() {
    const completed = [...this.agentMessages.values()]
      .filter((item) => item.phase !== "commentary");
    const preferred = completed.filter((item) => item.phase === "final_answer");
    const fallback = completed.filter((item) => item.phase === null);
    const messages = preferred.length > 0 ? preferred : fallback.length > 0 ? fallback : completed;
    const latest = messages
      .map((item) => item.text)
      .filter(Boolean)
      .at(-1);
    const text = (latest ?? "").trim();
    if (text) {
      return text;
    }

    return [...this.agentDeltas.values()].join("").trim();
  }

  async startTurn(entry, watcherAnchor) {
    this.agentMessages.clear();
    this.agentDeltas.clear();
    this.activeTurnId = null;
    this.turnInProgress = true;
    const timeoutMs = config.codexAppTurnTimeoutMs;
    const completion = new Promise((resolveTurn, rejectTurn) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const error = new Error(
          `Codex app-server turn timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        );
        error.code = "APP_SERVER_TURN_TIMEOUT";
        error.inboxId = entry.id;
        error.turnId = this.activeTurnId;
        this.turnWaiter = null;
        this.activeTurnId = null;
        this.turnInProgress = false;
        rejectTurn(error);
      }, timeoutMs);

      const settle = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.turnWaiter = null;
        fn(value);
      };

      this.turnWaiter = {
        resolve: (value) => settle(resolveTurn, value),
        reject: (error) => settle(rejectTurn, error)
      };
    });

    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        input: buildTurnInput(entry, watcherAnchor),
        approvalPolicy: "on-request",
        summary: "concise",
        clientUserMessageId: entry.id
      });
    } catch (error) {
      this.turnInProgress = false;
      this.turnWaiter?.reject(error);
      this.turnWaiter = null;
      throw error;
    }

    return completion;
  }

  enqueueVisibleEvent(event) {
    if (!config.codexAppVisibleEventStreamEnabled || !visibleEventAllowlist.has(event.event)) {
      return Promise.resolve();
    }

    const text = visibleEventText(event);
    if (!text) {
      return Promise.resolve();
    }

    const key = `${event.event}:${event.inboxId ?? ""}:${event.turnId ?? ""}:${event.itemId ?? ""}:${text}`;
    if (key === this.lastVisibleEventKey) {
      return Promise.resolve();
    }
    this.lastVisibleEventKey = key;

    this.visibleEventQueue = this.visibleEventQueue
      .catch(() => {})
      .then(async () => {
        if (this.hasLiveTurn()) {
          this.bufferVisibleEvent(event);
          return;
        }
        const waitMs = Math.max(
          0,
          config.codexAppVisibleEventMinIntervalMs - (Date.now() - this.lastVisibleEventAt)
        );
        if (waitMs > 0) {
          await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        }
        this.lastVisibleEventAt = Date.now();
        await this.request("thread/inject_items", {
          threadId: this.threadId,
          items: [
            {
              type: "agentMessage",
              text,
              phase: "commentary"
            }
          ]
        });
      })
      .catch((error) => {
        void appendRuntimeLog("frontstage_visible_event_failed", {
          summary: "Watcher 可見狀態流注入失敗",
          threadId: this.threadId,
          event: event.event,
          error: error.message
        });
        if (!this.visibleEventFailureReported) {
          this.visibleEventFailureReported = true;
          console.warn(`[visible-event-stream] failed: ${error.message}`);
        }
      });
    return this.visibleEventQueue;
  }

  bufferVisibleEvent(event) {
    const key = `${event.event}:${event.inboxId ?? ""}:${event.turnId ?? ""}:${event.itemId ?? ""}`;
    const last = this.bufferedVisibleEvents.at(-1);
    const lastKey = last
      ? `${last.event}:${last.inboxId ?? ""}:${last.turnId ?? ""}:${last.itemId ?? ""}`
      : null;
    if (key !== lastKey) {
      this.bufferedVisibleEvents.push(event);
    }
    if (this.bufferedVisibleEvents.length > 40) {
      this.bufferedVisibleEvents.splice(0, this.bufferedVisibleEvents.length - 40);
    }
  }

  flushBufferedVisibleEvents() {
    if (this.hasLiveTurn() || this.bufferedVisibleEvents.length === 0) {
      return Promise.resolve();
    }
    const events = this.bufferedVisibleEvents.splice(0);
    const text = visibleBufferedEventText(events);
    if (!text) {
      return Promise.resolve();
    }

    this.visibleEventQueue = this.visibleEventQueue
      .catch(() => {})
      .then(async () => {
        if (this.hasLiveTurn()) {
          for (const event of events) {
            this.bufferVisibleEvent(event);
          }
          return;
        }
        const waitMs = Math.max(
          0,
          config.codexAppVisibleEventMinIntervalMs - (Date.now() - this.lastVisibleEventAt)
        );
        if (waitMs > 0) {
          await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        }
        this.lastVisibleEventAt = Date.now();
        await this.request("thread/inject_items", {
          threadId: this.threadId,
          items: [
            {
              type: "agentMessage",
              text,
              phase: "commentary"
            }
          ]
        });
      })
      .catch((error) => {
        void appendRuntimeLog("frontstage_visible_event_failed", {
          summary: "Watcher 可見狀態流補記失敗",
          threadId: this.threadId,
          error: error.message
        });
        if (!this.visibleEventFailureReported) {
          this.visibleEventFailureReported = true;
          console.warn(`[visible-event-stream] failed: ${error.message}`);
        }
      });
    return this.visibleEventQueue;
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.turnWaiter?.reject(error);
    this.turnWaiter = null;
    this.turnInProgress = false;
    this.activeTurnId = null;
  }

  stop() {
    this.child?.kill();
  }
}

function buildTurnInput(entry, watcherAnchor = "") {
  const first = entry.messages?.[0];
  const lines = [
    "[Discord 前台訊息]",
    `來源：${entry.guild ?? "私訊"} / ${entry.channel}`,
    `訊息批次：${entry.batchSize ?? entry.messages?.length ?? 1} 則`,
    "",
    "Discord bridge 是你的麥克風、眼睛與發聲器，不是另一個 AI 人格。請直接接續目前 Codex task 的上下文。",
    "這一輪的最終回覆會由 relay 自動送回原 Discord 訊息，不要自行再呼叫 dc:send。",
    "白名單訊息都可能被送進來；請你判斷是否真的需要回 Discord。若不需要回覆，最終只輸出 [[discord-silent]]。",
    "Discord 前台是陪伴與工作共用的入口：可以聊天，也可以在可信使用者明確要求或授權時讀檔、改檔、執行程式、抓蟲修正或做其他本地開發工作。",
    "relay 會自動把 Discord Watcher / Agent Event Stream 的公開狀態注入目前 Codex task。final answer 直接回應 Discord 對話，不要輸出固定罐頭狀態句，也不要把 Watcher 機制講給 Discord 聽。",
    "若真的開始工具、改檔、跑測試或等授權，你仍可用 commentary 補充公開操作狀態。不要暴露私有思考鏈，只留下可公開的操作狀態。",
    "做開發工作時不要整個人消失去背景施工，也要保留聊天判斷，不要逐句機械回覆。",
    ""
  ];

  if (watcherAnchor) {
    lines.push("[Discord Watcher 短錨點]");
    lines.push(watcherAnchor);
    lines.push("");
  }

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

function entryTimestamp(entry) {
  const parsed = Date.parse(entry.ts ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function pendingConversationEntries(entry, state, ignoredIds = new Set()) {
  const entries = await readInbox();
  const pending = entries
    .filter((candidate) =>
      candidate.channelId === entry.channelId &&
      !state.processedIds.has(candidate.id) &&
      !ignoredIds.has(candidate.id)
    )
    .sort((left, right) => entryTimestamp(left) - entryTimestamp(right));

  const entryIndex = pending.findIndex((candidate) => candidate.id === entry.id);
  if (entryIndex < 0) {
    return ignoredIds.has(entry.id) ? [] : [entry];
  }

  const authorIds = new Set((entry.messages ?? []).map((message) => message.authorId));
  // A multi-author inbox is already a short group scene. Do not fold later
  // speakers into it as though they were one person's continuation.
  if (authorIds.size !== 1) {
    return [entry];
  }

  const [authorId] = authorIds;
  const conversation = [entry];
  for (const candidate of pending.slice(entryIndex + 1)) {
    const candidateAuthorIds = new Set((candidate.messages ?? []).map((message) => message.authorId));
    if (candidateAuthorIds.size !== 1 || !candidateAuthorIds.has(authorId)) {
      break;
    }
    conversation.push(candidate);
  }

  return conversation;
}

async function findNewerAcceptedMessage(entry) {
  const since = entryTimestamp(entry);
  if (!since) {
    return null;
  }

  try {
    const content = await readFile(resolve(projectRoot, config.bridgeLogFile), "utf8");
    const lines = content.split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      let candidate;
      try {
        candidate = JSON.parse(line);
      } catch {
        continue;
      }

      const candidateTime = Date.parse(candidate.ts ?? "");
      if (!Number.isNaN(candidateTime) && candidateTime <= since) {
        break;
      }

      if (
        candidate.event === "message_accepted" &&
        candidate.channelId === entry.channelId
      ) {
        return candidate;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[relay] failed to inspect bridge log: ${error.message}`);
    }
  }

  return null;
}

async function hasProcessedNewerInbox(entry, state) {
  const since = entryTimestamp(entry);
  if (!since) {
    return false;
  }

  const entries = await readInbox();
  return entries.some((candidate) =>
    candidate.channelId === entry.channelId &&
    state.processedIds.has(candidate.id) &&
    entryTimestamp(candidate) > since
  );
}

function mergeInboxEntries(entries) {
  const [first] = entries;
  const last = entries.at(-1);
  if (!first) {
    throw new Error("Cannot merge an empty inbox conversation.");
  }

  return {
    ...first,
    id: entries.map((entry) => entry.id).join("+"),
    ts: last?.ts ?? first.ts,
    sourceInboxIds: entries.map((entry) => entry.id),
    batchSize: entries.reduce((total, entry) => total + (entry.batchSize ?? entry.messages?.length ?? 0), 0),
    imageCount: entries.reduce((total, entry) => total + (entry.imageCount ?? 0), 0),
    messages: entries.flatMap((entry) => entry.messages ?? [])
  };
}

const visibleTaskWorkPattern = new RegExp([
  "改檔",
  "修改",
  "新增",
  "刪除",
  "重啟",
  "重開",
  "執行",
  "幫我跑",
  "去跑",
  "開始跑",
  "跑(?:一下|程式|測試|指令|npm|node|python)",
  "測試",
  "檢查",
  "安裝",
  "部署",
  "發布",
  "上傳",
  "開源",
  "版控",
  "工具",
  "終端",
  "指令",
  "程式",
  "檔案",
  "專案",
  "倉庫",
  "接麥",
  "斷麥",
  "搬家",
  "relay",
  "bot",
  "bridge",
  "watcher",
  "github",
  "commit",
  "push",
  "pull request",
  "\\bpr\\b",
  "\\bgit\\b",
  "\\bnpm\\b",
  "\\bnode\\b",
  "\\bpython\\b",
  "\\bshell\\b",
  "\\bterminal\\b"
].join("|"), "iu");

function entryPlainText(entry) {
  return (entry.messages ?? [])
    .map((message) => message.content ?? "")
    .join("\n")
    .trim();
}

function visibleTaskRequirement(entry) {
  const text = entryPlainText(entry);
  if (!text) {
    return null;
  }

  if (visibleTaskWorkPattern.test(text)) {
    return { reason: "work_keyword", text };
  }

  return null;
}

async function readWatcherAnchor() {
  try {
    return (await readFile(config.discordWatcherAnchorFile, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseReply(text) {
  const files = [];
  let isPrivate = false;
  let isSilent = false;
  let forceReply = false;
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
      if (/^\s*\[\[discord-silent\]\]\s*$/i.test(line)) {
        isSilent = true;
        return false;
      }
      if (/^\s*\[\[discord-reply\]\]\s*$/i.test(line)) {
        forceReply = true;
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();

  return { content, files, isPrivate, isSilent, forceReply };
}

function sendDiscordReply(entry, text) {
  const reply = parseReply(text);
  if (reply.isSilent) {
    return Promise.resolve("silent");
  }

  const args = [resolve(projectRoot, "scripts/send-discord-message.js")];
  const first = entry.messages?.[0];
  const targetPrivate = entry.isDm || (reply.isPrivate && entry.canPrivateReply);

  if (targetPrivate) {
    args.push("--dm", first.authorId);
  } else {
    args.push("--channel", entry.channelId);
    if (reply.forceReply && entry.triggerMessageId) {
      args.push("--reply", entry.triggerMessageId);
    }
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
const initialLease = await readWatcherLease(config);
const initialThreadId = initialLease.threadId ?? config.codexAppThreadId;
if (!initialThreadId) {
  throw new Error("Missing Codex task ID. Set CODEX_APP_THREAD_ID once, then use /接麥 or /搬家.");
}
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
const appServer = new AppServerClient(config.codexCliPath, initialThreadId);
const retryAfter = new Map();
const failureCounts = new Map();
const maxRelayFailures = 2;

async function appendRelayEvent(event, data = {}) {
  await appendRuntimeLog(event, data);
  return appServer.enqueueVisibleEvent({ event, ...data });
}

async function emitVisibleRelayEvent(event, data = {}) {
  return appServer.enqueueVisibleEvent({ event, ...data });
}

async function markSourceEntriesSuperseded(sourceEntries, data = {}) {
  for (const sourceEntry of sourceEntries) {
    state.processedIds.add(sourceEntry.id);
    retryAfter.delete(sourceEntry.id);
    failureCounts.delete(sourceEntry.id);
  }
  state.initialized = true;
  await writeState(state);

  for (const sourceEntry of sourceEntries) {
    await appendRelayEvent("frontstage_relay_skipped_superseded_inbox", {
      summary: "舊 inbox 已被更新訊息取代，已作廢",
      inboxId: sourceEntry.id,
      channelId: sourceEntry.channelId,
      channel: sourceEntry.channel,
      threadId: appServer.threadId,
      ...data
    });
  }
}

appServer.onApprovalRequest = async (request) => {
  const entry = appServer.currentEntry;
  await appendRelayEvent("frontstage_relay_approval_required", {
    summary: "Codex task 等待使用者授權",
    threadId: appServer.threadId,
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
await appendRelayEvent("frontstage_relay_started", {
  summary: `Discord Watcher relay 已連到 Codex task：${appServer.threadId}`,
  threadId: appServer.threadId,
  watcherActive: initialLease.active,
  watcherEpoch: initialLease.epoch
});

function sameLease(left, right) {
  return left.active === right.active &&
    left.threadId === right.threadId &&
    left.epoch === right.epoch;
}

async function syncWatcherLease() {
  const lease = await readWatcherLease(config);
  if (!lease.active) {
    return lease;
  }

  if (!lease.threadId) {
    throw new Error("Discord Watcher is active but has no target Codex task ID.");
  }

  if (appServer.threadId !== lease.threadId) {
    const previousThreadId = appServer.threadId;
    await appendRelayEvent("watcher_handoff_started", {
      summary: "Discord Watcher 正在切換 Codex task",
      fromThreadId: previousThreadId,
      threadId: lease.threadId,
      epoch: lease.epoch
    });
    await appServer.resumeThread(lease.threadId);
    await appendRelayEvent("watcher_handoff_completed", {
      summary: "Discord Watcher 已接到新的 Codex task",
      fromThreadId: previousThreadId,
      threadId: lease.threadId,
      epoch: lease.epoch
    });
  }
  return lease;
}

async function processPending() {
  const now = Date.now();
  const lease = await syncWatcherLease();
  if (!lease.active) {
    return;
  }
  const entries = await readInbox();
  for (const entry of entries) {
    if (state.processedIds.has(entry.id) || (retryAfter.get(entry.id) ?? 0) > now) {
      continue;
    }

    if (await hasProcessedNewerInbox(entry, state)) {
      state.processedIds.add(entry.id);
      retryAfter.delete(entry.id);
      failureCounts.delete(entry.id);
      state.initialized = true;
      await writeState(state);
      await appendRelayEvent("frontstage_relay_skipped_superseded_inbox", {
        summary: "同頻道已有較新的 inbox 完成，舊 inbox 已作廢",
        inboxId: entry.id,
        channelId: entry.channelId,
        channel: entry.channel,
        threadId: appServer.threadId,
        watcherEpoch: lease.epoch
      });
      continue;
    }

    const sourceEntries = await pendingConversationEntries(entry, state);
    const effectiveEntry = mergeInboxEntries(sourceEntries);
    const sourceIds = new Set(effectiveEntry.sourceInboxIds);
    const newerAcceptedBeforeTurn = await findNewerAcceptedMessage(effectiveEntry);
    if (newerAcceptedBeforeTurn) {
      for (const sourceEntry of sourceEntries) {
        retryAfter.set(sourceEntry.id, Date.now() + config.discordSemanticHoldMs + 1_000);
      }
      await appendRelayEvent("frontstage_relay_waiting_newer_message", {
        summary: "同頻道已有更新收訊，先不啟動 Codex，等新訊息成批後再整合",
        inboxId: effectiveEntry.id,
        newerMessageId: newerAcceptedBeforeTurn.messageId,
        channelId: entry.channelId,
        channel: entry.channel,
        threadId: appServer.threadId,
        watcherEpoch: lease.epoch
      });
      continue;
    }

    const requirement = visibleTaskRequirement(effectiveEntry);
    if (requirement) {
      await appendRelayEvent("frontstage_relay_visible_task_work_started", {
        summary: "DC 前台觸發開發/工具工作，已寫入 Watcher 事件流",
        inboxId: effectiveEntry.id,
        sourceInboxIds: effectiveEntry.sourceInboxIds,
        channelId: entry.channelId,
        channel: entry.channel,
        threadId: appServer.threadId,
        watcherEpoch: lease.epoch,
        reason: requirement.reason
      });
    }

    appServer.currentEntry = effectiveEntry;
    try {
      await appendRelayEvent("frontstage_relay_turn_started", {
        summary: `前台 relay 送入 Codex task：${effectiveEntry.id}`,
        inboxId: effectiveEntry.id,
        sourceInboxIds: effectiveEntry.sourceInboxIds,
        threadId: appServer.threadId,
        watcherEpoch: lease.epoch,
        batchSize: effectiveEntry.batchSize
      });
      const result = await appServer.startTurn(effectiveEntry, await readWatcherAnchor());
      if (result.turn?.status === "failed") {
        throw new Error(result.turn.error?.message || "Codex task turn failed.");
      }
      const leaseAfterTurn = await readWatcherLease(config);
      const replyDiscarded = !sameLease(lease, leaseAfterTurn);
      const newerPending = replyDiscarded
        ? []
        : await pendingConversationEntries(entry, state, sourceIds);
      const newerAccepted = replyDiscarded || newerPending.length > 0
        ? null
        : await findNewerAcceptedMessage(effectiveEntry);
      if (replyDiscarded) {
        await appendRelayEvent("frontstage_relay_reply_discarded_handoff", {
          summary: "Watcher 已搬家或斷麥，丟棄舊 task 的回覆",
          inboxId: effectiveEntry.id,
          oldThreadId: appServer.threadId,
          newThreadId: leaseAfterTurn.threadId,
          oldEpoch: lease.epoch,
          newEpoch: leaseAfterTurn.epoch
        });
      } else if (newerPending.length > 0) {
        await appendRelayEvent("frontstage_relay_reply_deferred_newer_message", {
          summary: "同頻道已有更新訊息，舊回覆不送回 Discord，重新整合後再判斷",
          inboxId: effectiveEntry.id,
          newerInboxIds: newerPending.map((candidate) => candidate.id),
          channelId: entry.channelId,
          channel: entry.channel,
          threadId: appServer.threadId,
          watcherEpoch: lease.epoch
        });
        await markSourceEntriesSuperseded(sourceEntries, {
          watcherEpoch: lease.epoch,
          supersededByInboxIds: newerPending.map((candidate) => candidate.id)
        });
        return;
      } else if (newerAccepted) {
        await appendRelayEvent("frontstage_relay_reply_deferred_newer_message", {
          summary: "同頻道已有更新收訊，舊回覆不送回 Discord，等新訊息成批後重新整合",
          inboxId: effectiveEntry.id,
          newerMessageId: newerAccepted.messageId,
          channelId: entry.channelId,
          channel: entry.channel,
          threadId: appServer.threadId,
          watcherEpoch: lease.epoch,
          source: "message_accepted"
        });
        await markSourceEntriesSuperseded(sourceEntries, {
          watcherEpoch: lease.epoch,
          supersededByMessageId: newerAccepted.messageId
        });
        return;
      } else if (result.text) {
        await sendDiscordReply(effectiveEntry, result.text);
      }
      for (const sourceEntry of sourceEntries) {
        state.processedIds.add(sourceEntry.id);
        retryAfter.delete(sourceEntry.id);
        failureCounts.delete(sourceEntry.id);
      }
      state.initialized = true;
      await writeState(state);
      await appendRelayEvent("frontstage_relay_turn_completed", {
        summary: replyDiscarded
          ? `前台 relay 已完成但因搬家/斷麥未回傳：${effectiveEntry.id}`
          : newerAccepted
            ? `前台 relay 已完成但因新收訊未回傳：${effectiveEntry.id}`
            : `前台 relay 已回傳 Discord：${effectiveEntry.id}`,
        inboxId: effectiveEntry.id,
        sourceInboxIds: effectiveEntry.sourceInboxIds,
        threadId: appServer.threadId,
        watcherEpoch: lease.epoch,
        deferredByNewerInboxIds: newerPending.map((candidate) => candidate.id),
        deferredByNewerMessageId: newerAccepted?.messageId ?? null,
        responseChars: result.text?.length ?? 0
      });
    } catch (error) {
      if (error.code === "APP_SERVER_TURN_TIMEOUT") {
        await appendRuntimeLog("frontstage_relay_turn_timeout", {
          summary: `Codex turn 超過 ${Math.round(config.codexAppTurnTimeoutMs / 1000)} 秒未完成，Watcher 正在重啟 app-server`,
          inboxId: effectiveEntry.id,
          sourceInboxIds: sourceEntries.map((sourceEntry) => sourceEntry.id),
          threadId: appServer.threadId,
          turnId: error.turnId ?? null,
          watcherEpoch: lease.epoch,
          timeoutMs: config.codexAppTurnTimeoutMs
        });
        await appendRuntimeLog("frontstage_relay_restarting", {
          summary: "Watcher 正在重啟 Codex app-server，避免狀態流卡死",
          inboxId: effectiveEntry.id,
          threadId: appServer.threadId,
          watcherEpoch: lease.epoch,
          reason: "turn_timeout"
        });
        try {
          await appServer.restart(`turn timeout for ${effectiveEntry.id}`);
          await emitVisibleRelayEvent("frontstage_relay_turn_timeout", {
            summary: `Codex turn 超過 ${Math.round(config.codexAppTurnTimeoutMs / 1000)} 秒未完成，Watcher 已切斷卡住的 app-server`,
            inboxId: effectiveEntry.id,
            sourceInboxIds: sourceEntries.map((sourceEntry) => sourceEntry.id),
            threadId: appServer.threadId,
            turnId: error.turnId ?? null,
            watcherEpoch: lease.epoch,
            timeoutMs: config.codexAppTurnTimeoutMs
          });
          await appendRelayEvent("frontstage_relay_recovered", {
            summary: "Watcher 已重新連回 Codex task，可繼續處理後續 Discord 訊息",
            inboxId: effectiveEntry.id,
            threadId: appServer.threadId,
            watcherEpoch: lease.epoch
          });
        } catch (restartError) {
          await appendRelayEvent("frontstage_relay_restart_failed", {
            summary: "Watcher 重啟 Codex app-server 失敗",
            inboxId: effectiveEntry.id,
            threadId: appServer.threadId,
            watcherEpoch: lease.epoch,
            error: restartError.message
          });
        }
      }
      const attempts = (failureCounts.get(effectiveEntry.id) ?? 0) + 1;
      failureCounts.set(effectiveEntry.id, attempts);
      const finalFailure = attempts >= maxRelayFailures;
      if (finalFailure) {
        for (const sourceEntry of sourceEntries) {
          state.processedIds.add(sourceEntry.id);
          retryAfter.delete(sourceEntry.id);
          failureCounts.delete(sourceEntry.id);
        }
        failureCounts.delete(effectiveEntry.id);
        state.initialized = true;
        await writeState(state);
      } else {
        for (const sourceEntry of sourceEntries) {
          retryAfter.set(sourceEntry.id, Date.now() + 10_000);
        }
      }
      await appendRelayEvent("frontstage_relay_failed", {
        summary: finalFailure
          ? `前台 relay 失敗並停止重試：${effectiveEntry.id}`
          : `前台 relay 失敗，稍後重試：${effectiveEntry.id}`,
        inboxId: entry.id,
        effectiveInboxId: effectiveEntry.id,
        sourceInboxIds: sourceEntries.map((sourceEntry) => sourceEntry.id),
        threadId: appServer.threadId,
        attempts,
        maxRelayFailures,
        final: finalFailure,
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
