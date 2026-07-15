import { open, readFile, stat, watch } from "node:fs/promises";
import { getConfig } from "../src/config.js";

function parseArgs(argv) {
  const replayArg = argv.find((arg) => arg.startsWith("--replay="));
  const replay = replayArg ? Number.parseInt(replayArg.slice("--replay=".length), 10) : 0;

  return {
    replay: Number.isFinite(replay) && replay > 0 ? replay : 0,
    verbose: argv.includes("--verbose")
  };
}

function formatClock(ts) {
  const date = ts ? new Date(ts) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function compactText(value, limit = 80) {
  if (!value) {
    return "";
  }

  const text = String(value).replace(/[\r\n]+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function line(prefix, entry, text) {
  return `[${formatClock(entry.ts)}] ${prefix} ${text}`;
}

function bridgeStatus(entry) {
  switch (entry.event) {
    case "bridge_ready":
      return line("已連線", entry, `Discord bot：${entry.botTag ?? "-"}`);
    case "watcher_attached":
      return line("接麥", entry, `${entry.roomId ?? "目前房"} -> ${entry.threadId ?? "-"}`);
    case "watcher_moved":
      return line("搬家", entry, `${entry.roomId ?? "新房"} -> ${entry.threadId ?? "-"}`);
    case "watcher_detached":
      return line("斷麥", entry, `epoch ${entry.epoch ?? "-"}`);
    case "watcher_handoff_started":
      return line("搬家中", entry, `${entry.fromThreadId ?? "-"} -> ${entry.threadId ?? "-"}`);
    case "watcher_handoff_completed":
      return line("已搬家", entry, `${entry.threadId ?? "-"}`);
    case "watcher_silent":
      return line("未接麥", entry, entry.summary ?? "一般訊息已略過");
    case "message_blocked":
      return line("封鎖略過", entry, entry.summary ?? "-");
    case "bot_loop_limited":
      return line("互聊煞車", entry, entry.summary ?? "-");
    case "decided_silent":
      return line("安靜", entry, entry.summary ?? "-");
    case "message_accepted": {
      const imageNote = entry.imageCount ? `，${entry.imageCount} 圖` : "";
      return line("收到", entry, `${entry.author ?? "-"} / ${entry.channel ?? "-"}：${compactText(entry.content ?? entry.summary)}${imageNote}`);
    }
    case "waiting_debounce":
      return line("等待", entry, `${entry.waitReason ?? "觀察是否還有後續訊息"}：${entry.author ?? "-"} / ${entry.channel ?? "-"}`);
    case "merged_into_batch":
      return line("合併", entry, `${entry.author ?? "-"} 第 ${entry.batchSize ?? "?"} 則；${entry.waitReason ?? "重設等待"}`);
    case "frontstage_inbox_received":
      return line("送入", entry, `${entry.inboxId ?? "-"}，${entry.batchSize ?? 0} 則 / ${entry.channel ?? "-"}`);
    case "frontstage_relay_started":
      return line("Relay", entry, `已接 Codex task：${entry.threadId ?? "-"}，Watcher=${entry.watcherActive ? "on" : "off"}`);
    case "frontstage_relay_baselined":
      return line("基準", entry, `略過 ${entry.skippedCount ?? 0} 筆舊 inbox，保留 ${entry.pendingCount ?? 0} 筆新訊息`);
    case "frontstage_inbox_received":
      return line("前台", entry, `${entry.inboxId ?? "-"}，${entry.batchSize ?? 0} 則 / ${entry.channel ?? "-"}`);
    case "frontstage_relay_turn_started":
      return line("Codex", entry, `開始處理 ${entry.inboxId ?? "-"}，${entry.batchSize ?? 0} 則`);
    case "frontstage_relay_turn_timeout":
      return line("超時", entry, `${entry.inboxId ?? "-"}，已切斷卡住的 app-server`);
    case "frontstage_relay_restarting":
      return line("重啟", entry, "Watcher 正在重啟 Codex app-server");
    case "frontstage_relay_recovered":
      return line("恢復", entry, "Watcher 已重新連回 Codex task");
    case "frontstage_relay_restart_failed":
      return line("錯誤", entry, `Watcher 重啟失敗：${entry.error ?? "-"}`);
    case "frontstage_relay_approval_required":
      return line("等授權", entry, entry.request ? `需要批准：${entry.request}` : "需要在 Codex 視窗批准");
    case "frontstage_relay_reply_discarded_handoff":
      return line("已丟棄", entry, "舊 task 回覆，因為已搬家或斷麥");
    case "frontstage_relay_reply_deferred_newer_message":
      return line("延後", entry, `有新訊息，舊回覆不送出：${entry.inboxId ?? "-"}`);
    case "frontstage_relay_waiting_newer_message":
      return line("等收束", entry, `有更新收訊，先等成批再處理：${entry.inboxId ?? "-"}`);
    case "frontstage_relay_skipped_superseded_inbox":
      return line("作廢", entry, `同頻道已有較新回覆，舊 inbox 不再處理：${entry.inboxId ?? "-"}`);
    case "frontstage_relay_visible_task_required":
      return line("回前台", entry, `需要在可見 Codex task 確認：${entry.inboxId ?? "-"}`);
    case "frontstage_relay_visible_task_work_started":
      return line("可見施工", entry, `DC 觸發工作，進度會在這裡顯示：${entry.inboxId ?? "-"}`);
    case "frontstage_relay_turn_completed":
      return line("完成", entry, `${entry.inboxId ?? "-"}，${entry.responseChars ?? 0} 字已處理`);
    case "frontstage_relay_failed":
      return line("錯誤", entry, `${entry.inboxId ?? "-"}：${entry.error ?? "relay failed"}`);
    case "agent_event_turn_started":
      return line("Agent", entry, `turn 開始：${entry.inboxId ?? entry.turnId ?? "-"}`);
    case "agent_event_turn_completed":
      return line("Agent", entry, `turn 完成：${entry.inboxId ?? entry.turnId ?? "-"}`);
    case "agent_event_turn_failed":
      return line("Agent", entry, `turn 失敗：${entry.error ?? "-"}`);
    case "agent_event_task_status":
      return line("Task", entry, entry.taskStatus === "active" ? "處理中" : "待命");
    case "agent_event_context_compaction_started":
      return line("壓縮", entry, "上下文壓縮開始");
    case "agent_event_context_compaction_completed":
      return line("壓縮", entry, "上下文壓縮完成");
    case "agent_event_reasoning_started":
      return line("狀態", entry, "Codex 正在整理判斷");
    case "agent_event_reasoning_completed":
      return line("狀態", entry, "判斷段落完成");
    case "agent_event_tool_started":
      return line("工具", entry, `開始：${entry.commandAction ?? "工具執行"}`);
    case "agent_event_tool_completed":
      return line("工具", entry, `完成：${entry.commandAction ?? "工具執行"}`);
    case "agent_event_approval_required":
      return line("等授權", entry, `需要批准：${entry.request ?? "-"}`);
    case "agent_event_response_started":
      return line("回覆", entry, "開始產生 Discord 回覆");
    case "agent_event_response_completed":
      return line("回覆", entry, "Discord 回覆已產生");
    case "agent_event_status_message_started":
      return line("狀態", entry, "開始產生狀態訊息");
    case "agent_event_status_message_completed":
      return line("狀態", entry, "狀態訊息已產生");
    default:
      return null;
  }
}

function appServerStatus(entry, { verbose = false } = {}) {
  const method = entry.method;
  const type = entry.itemType;
  const phase = entry.itemPhase;

  if (!verbose) {
    if (method === "turn/failed") {
      return line("Turn", entry, "失敗");
    }

    if (method === "request" && entry.requestMethod) {
      return line("請求", entry, entry.requestMethod);
    }

    if (method === "item/started" && type === "commandExecution") {
      return line("工具", entry, "開始執行指令");
    }

    if (method === "item/completed" && type === "commandExecution") {
      return line("工具", entry, "指令完成");
    }

    return null;
  }

  if (method === "turn/started") {
    return line("Turn", entry, `開始：${entry.turnId ?? "-"}`);
  }

  if (method === "turn/completed") {
    return line("Turn", entry, `完成：${entry.turnStatus ?? "completed"}`);
  }

  if (method === "turn/failed") {
    return line("Turn", entry, "失敗");
  }

  if (method === "thread/status/changed") {
    const status = entry.message?.params?.status?.type ?? "-";
    return line("Task", entry, `狀態：${status}`);
  }

  if (method === "request" && entry.requestMethod) {
    return line("請求", entry, entry.requestMethod);
  }

  if (method === "item/started") {
    if (type === "commandExecution") {
      return line("工具", entry, "開始執行指令");
    }
    if (type === "reasoning") {
      return line("狀態", entry, "Codex 正在整理判斷");
    }
    if (type) {
      return line("項目", entry, `開始：${type}${phase ? ` / ${phase}` : ""}`);
    }
  }

  if (method === "item/completed") {
    if (type === "commandExecution") {
      return line("工具", entry, "指令完成");
    }
    if (type === "reasoning") {
      return line("狀態", entry, "判斷段落完成");
    }
    if (type === "agentMessage") {
      return line("回覆", entry, "已產生最終回覆");
    }
    if (type) {
      return line("項目", entry, `完成：${type}${phase ? ` / ${phase}` : ""}`);
    }
  }

  return null;
}

function parseLine(raw, source, options = {}) {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  try {
    const entry = JSON.parse(text);
    return source === "bridge" ? bridgeStatus(entry) : appServerStatus(entry, options);
  } catch (error) {
    return `[${formatClock()}] 解析錯誤 ${source}：${error.message}`;
  }
}

async function printReplay(filePath, source, count, options) {
  if (count <= 0) {
    return;
  }

  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean).slice(-count);
    for (const raw of lines) {
      const status = parseLine(raw, source, options);
      if (status) {
        console.log(status);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.log(`[${formatClock()}] 讀取失敗 ${filePath}：${error.message}`);
    }
  }
}

async function tailFile(filePath, source, options) {
  let position = 0;
  let carry = "";

  try {
    position = (await stat(filePath)).size;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  async function readNewBytes() {
    let file;
    try {
      const current = await stat(filePath);
      if (current.size < position) {
        position = 0;
        carry = "";
      }
      if (current.size === position) {
        return;
      }

      file = await open(filePath, "r");
      const length = current.size - position;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, position);
      position = current.size;

      const content = carry + buffer.toString("utf8");
      const lines = content.split("\n");
      carry = lines.pop() ?? "";
      for (const raw of lines) {
        const status = parseLine(raw, source, options);
        if (status) {
          console.log(status);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.log(`[${formatClock()}] 讀取失敗 ${filePath}：${error.message}`);
      }
    } finally {
      await file?.close();
    }
  }

  const interval = setInterval(readNewBytes, 500);
  interval.unref();

  try {
    for await (const _event of watch(filePath, { persistent: true })) {
      await readNewBytes();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      setInterval(readNewBytes, 1_000);
      return;
    }
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
const config = getConfig({ requireDiscord: false });

console.log(`[${formatClock()}] Watcher 前景事件流已啟動`);
console.log(`[${formatClock()}] bridge=${config.bridgeLogFile}`);
console.log(`[${formatClock()}] app-server=${config.codexAppEventLogFile}`);
console.log(`[${formatClock()}] 顯示模式：${args.verbose ? "verbose" : "compact"}；不顯示 reasoning 內容或 agent 逐字草稿。`);

await printReplay(config.bridgeLogFile, "bridge", args.replay, args);
await printReplay(config.codexAppEventLogFile, "app-server", Math.min(args.replay, 20), args);

await Promise.all([
  tailFile(config.bridgeLogFile, "bridge", args),
  tailFile(config.codexAppEventLogFile, "app-server", args)
]);
