import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getConfig } from "../src/config.js";
import { readWatcherLease } from "../src/watcher-lease.js";

class AppServerProbe {
  constructor(cliPath) {
    this.cliPath = cliPath;
    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(this.cliPath, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
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
        name: "codex-discord-bridge-inject-probe",
        version: "0.2.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  request(method, params) {
    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for app-server request: ${method}`));
      }, 20_000);

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
      return;
    }

    if (message.id === undefined) {
      return;
    }

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
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    this.child?.kill();
  }
}

const config = getConfig({ requireDiscord: false });
const lease = await readWatcherLease(config);
const threadId = lease.threadId ?? config.codexAppThreadId;
if (!threadId) {
  throw new Error("No target Codex task ID. Use /接麥 first or set CODEX_APP_THREAD_ID.");
}

const text = process.argv.slice(2).join(" ").trim() ||
  `Watcher probe ${new Date().toLocaleTimeString("zh-TW", { hour12: false })}: 狀態流注入測試。`;

const variants = [
  {
    name: "items-agentMessage",
    params: {
      threadId,
      items: [
        {
          type: "agentMessage",
          text,
          phase: "commentary"
        }
      ]
    }
  },
  {
    name: "responseItems-agentMessage",
    params: {
      threadId,
      responseItems: [
        {
          type: "agentMessage",
          text,
          phase: "commentary"
        }
      ]
    }
  },
  {
    name: "items-wrapper-agentMessage",
    params: {
      threadId,
      items: [
        {
          agentMessage: {
            text,
            phase: "commentary"
          }
        }
      ]
    }
  }
];

const probe = new AppServerProbe(config.codexCliPath);
try {
  await probe.start();
  await probe.request("thread/resume", { threadId, excludeTurns: true });

  for (const variant of variants) {
    try {
      const result = await probe.request("thread/inject_items", variant.params);
      console.log(JSON.stringify({
        ok: true,
        variant: variant.name,
        threadId,
        result
      }, null, 2));
      process.exitCode = 0;
      break;
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        variant: variant.name,
        error: error.message
      }, null, 2));
      process.exitCode = 1;
    }
  }
} finally {
  probe.stop();
}
