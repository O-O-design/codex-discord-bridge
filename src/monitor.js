import { createServer } from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getConfig } from "./config.js";

const config = getConfig({ requireDiscord: false });
const logFile = resolve(process.cwd(), config.bridgeLogFile);
const clients = new Set();
let readOffset = 0;
let partialLine = "";
let recentEntries = [];

function parseLogLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      ts: new Date().toISOString(),
      event: "monitor_parse_failed",
      summary: trimmed
    };
  }
}

async function readRecentEntries(maxEntries = 200) {
  try {
    const content = await readFile(logFile, "utf8");
    return content
      .split("\n")
      .slice(-maxEntries)
      .map(parseLogLine)
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function resetOffsetToEnd() {
  try {
    const file = await stat(logFile);
    readOffset = file.size;
  } catch (error) {
    if (error.code === "ENOENT") {
      readOffset = 0;
      return;
    }

    throw error;
  }
}

function sendServerEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(entry) {
  for (const client of clients) {
    sendServerEvent(client, "log", entry);
  }
}

async function pollLogFile() {
  try {
    const file = await stat(logFile);

    if (file.size < readOffset) {
      readOffset = 0;
      partialLine = "";
    }

    if (file.size === readOffset) {
      return;
    }

    const length = file.size - readOffset;
    const buffer = Buffer.alloc(length);
    const handle = await open(logFile, "r");

    try {
      await handle.read(buffer, 0, length, readOffset);
    } finally {
      await handle.close();
    }

    readOffset = file.size;
    const text = partialLine + buffer.toString("utf8");
    const lines = text.split("\n");
    partialLine = lines.pop() ?? "";

    for (const line of lines) {
      const entry = parseLogLine(line);

      if (!entry) {
        continue;
      }

      recentEntries.push(entry);
      if (recentEntries.length > 200) {
        recentEntries.shift();
      }

      broadcast(entry);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[monitor] failed to poll log: ${error.message}`);
    }
  }
}

function htmlPage() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>oo-bridge monitor</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fa;
      --panel: #ffffff;
      --panel-2: #edf2f7;
      --text: #20242b;
      --muted: #667381;
      --line: #d9e0ea;
      --ok: #16835b;
      --warn: #a45f00;
      --bad: #b53542;
      --info: #2f67d8;
      --shadow: 0 14px 36px rgba(33, 43, 54, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(47, 103, 216, 0.08), rgba(245, 247, 250, 0) 280px),
        var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 20px 0 28px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
    }

    .sub {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
      word-break: break-all;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .pill.live {
      color: var(--ok);
      border-color: rgba(22, 131, 91, 0.35);
      background: #ebf8f1;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }

    .card,
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .card {
      padding: 13px 14px;
      min-height: 92px;
    }

    .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 10px;
    }

    .value {
      font-size: 24px;
      font-weight: 700;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }

    .value.small {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.35;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      gap: 12px;
    }

    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 15px;
    }

    .list {
      max-height: calc(100vh - 250px);
      min-height: 320px;
      overflow: auto;
    }

    .item {
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
    }

    .item:last-child {
      border-bottom: 0;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
    }

    .event {
      color: var(--info);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .event.codex_success,
    .event.codex_done,
    .event.bridge_ready {
      color: var(--ok);
    }

    .event.codex_failed,
    .event.discord_client_error,
    .event.monitor_parse_failed {
      color: var(--bad);
    }

    .event.codex_queued,
    .event.codex_start,
    .event.codex_running {
      color: var(--warn);
    }

    .time {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .summary {
      color: var(--text);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .empty {
      padding: 22px 14px;
      color: var(--muted);
      font-size: 13px;
    }

    @media (max-width: 860px) {
      .grid,
      .layout {
        grid-template-columns: 1fr;
      }

      header {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>oo-bridge monitor</h1>
        <div class="sub">${logFile}</div>
      </div>
      <div id="connection" class="pill">connecting</div>
    </header>

    <section class="grid">
      <div class="card">
        <div class="label">Bridge</div>
        <div id="bridge-status" class="value small">waiting</div>
      </div>
      <div class="card">
        <div class="label">Queue</div>
        <div id="queue-count" class="value">0</div>
      </div>
      <div class="card">
        <div class="label">Active Job</div>
        <div id="active-job" class="value small">none</div>
      </div>
      <div class="card">
        <div class="label">Last Result</div>
        <div id="last-result" class="value small">none</div>
      </div>
    </section>

    <section class="layout">
      <div class="panel">
        <h2>Jobs</h2>
        <div id="jobs" class="list"></div>
      </div>
      <div class="panel">
        <h2>Events</h2>
        <div id="events" class="list"></div>
      </div>
    </section>
  </main>

  <script>
    const entries = [];
    const jobs = new Map();
    const state = {
      connected: false,
      bridgeStatus: 'waiting',
      queueCount: 0,
      activeJobId: null,
      lastResult: 'none'
    };

    const connectionEl = document.getElementById('connection');
    const bridgeStatusEl = document.getElementById('bridge-status');
    const queueCountEl = document.getElementById('queue-count');
    const activeJobEl = document.getElementById('active-job');
    const lastResultEl = document.getElementById('last-result');
    const jobsEl = document.getElementById('jobs');
    const eventsEl = document.getElementById('events');

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function eventTime(ts) {
      if (!ts) {
        return '';
      }

      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) {
        return ts;
      }

      return date.toLocaleTimeString('zh-TW', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms)) {
        return '';
      }

      if (ms < 1000) {
        return ms + 'ms';
      }

      return (ms / 1000).toFixed(1) + 's';
    }

    function applyEntry(entry) {
      entries.unshift(entry);
      if (entries.length > 120) {
        entries.pop();
      }

      if (Number.isFinite(entry.queuedJobCount)) {
        state.queueCount = entry.queuedJobCount;
      }

      if (entry.event === 'bridge_ready') {
        state.bridgeStatus = entry.botTag || 'online';
      }

      if (entry.event === 'bridge_log_started') {
        state.bridgeStatus = 'log ready';
      }

      if (entry.event === 'codex_queued' && entry.jobId) {
        jobs.set(entry.jobId, {
          id: entry.jobId,
          status: 'queued',
          ts: entry.ts,
          summary: entry.summary,
          channel: entry.channel,
          batchSize: entry.batchSize,
          sandbox: entry.sandbox
        });
      }

      if (entry.event === 'codex_start' && entry.jobId) {
        const job = jobs.get(entry.jobId) || { id: entry.jobId };
        jobs.set(entry.jobId, {
          ...job,
          status: 'running',
          startedTs: entry.ts,
          summary: entry.summary,
          channel: entry.channel,
          batchSize: entry.batchSize,
          sandbox: entry.sandbox
        });
        state.activeJobId = entry.jobId;
      }

      if ((entry.event === 'codex_success' || entry.event === 'codex_failed') && entry.jobId) {
        const job = jobs.get(entry.jobId) || { id: entry.jobId };
        const failed = entry.event === 'codex_failed';
        jobs.set(entry.jobId, {
          ...job,
          status: failed ? 'failed' : 'done',
          finishedTs: entry.ts,
          durationMs: entry.durationMs,
          summary: entry.summary,
          responseLength: entry.responseLength,
          error: entry.error
        });
        if (state.activeJobId === entry.jobId) {
          state.activeJobId = null;
        }
        state.lastResult = failed ? 'failed: ' + (entry.error || entry.jobId) : 'ok: ' + formatDuration(entry.durationMs);
      }
    }

    function render() {
      connectionEl.textContent = state.connected ? 'live' : 'reconnecting';
      connectionEl.className = state.connected ? 'pill live' : 'pill';
      bridgeStatusEl.textContent = state.bridgeStatus;
      queueCountEl.textContent = String(state.queueCount);
      activeJobEl.textContent = state.activeJobId || 'none';
      lastResultEl.textContent = state.lastResult;

      renderJobs();
      renderEvents();
    }

    function renderJobs() {
      const sortedJobs = [...jobs.values()].sort((a, b) => {
        const left = new Date(b.finishedTs || b.startedTs || b.ts || 0).getTime();
        const right = new Date(a.finishedTs || a.startedTs || a.ts || 0).getTime();
        return left - right;
      }).slice(0, 30);

      if (sortedJobs.length === 0) {
        jobsEl.innerHTML = '<div class="empty">還沒有 Codex job。</div>';
        return;
      }

      jobsEl.innerHTML = sortedJobs.map((job) => {
        const duration = formatDuration(job.durationMs);
        const meta = [
          job.channel,
          job.batchSize ? 'batch ' + job.batchSize : '',
          job.sandbox,
          duration
        ].filter(Boolean).join(' · ');

        return '<div class="item">' +
          '<div class="row">' +
            '<div class="event codex_' + escapeHtml(job.status) + '">' + escapeHtml(job.status) + '</div>' +
            '<div class="time">' + escapeHtml(eventTime(job.finishedTs || job.startedTs || job.ts)) + '</div>' +
          '</div>' +
          '<div class="summary">' + escapeHtml(job.summary || job.id) + '</div>' +
          '<div class="meta">' + escapeHtml(meta || job.id) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderEvents() {
      if (entries.length === 0) {
        eventsEl.innerHTML = '<div class="empty">等待 bridge log。</div>';
        return;
      }

      eventsEl.innerHTML = entries.map((entry) => {
        const meta = [
          entry.channel,
          entry.jobId,
          Number.isFinite(entry.durationMs) ? formatDuration(entry.durationMs) : ''
        ].filter(Boolean).join(' · ');

        return '<div class="item">' +
          '<div class="row">' +
            '<div class="event ' + escapeHtml(entry.event) + '">' + escapeHtml(entry.event) + '</div>' +
            '<div class="time">' + escapeHtml(eventTime(entry.ts)) + '</div>' +
          '</div>' +
          '<div class="summary">' + escapeHtml(entry.summary || JSON.stringify(entry)) + '</div>' +
          '<div class="meta">' + escapeHtml(meta) + '</div>' +
        '</div>';
      }).join('');
    }

    function resetFromSnapshot(snapshot) {
      entries.length = 0;
      jobs.clear();
      state.queueCount = 0;
      state.activeJobId = null;
      state.lastResult = 'none';
      for (const entry of snapshot) {
        applyEntry(entry);
      }
      render();
    }

    const source = new EventSource('/events');

    source.addEventListener('open', () => {
      state.connected = true;
      render();
    });

    source.addEventListener('snapshot', (event) => {
      resetFromSnapshot(JSON.parse(event.data));
    });

    source.addEventListener('log', (event) => {
      applyEntry(JSON.parse(event.data));
      render();
    });

    source.addEventListener('error', () => {
      state.connected = false;
      render();
    });

    render();
  </script>
</body>
</html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");

  if (url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(htmlPage());
    return;
  }

  if (url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    response.write(": connected\n\n");
    sendServerEvent(response, "snapshot", recentEntries);
    clients.add(response);

    request.on("close", () => {
      clients.delete(response);
    });
    return;
  }

  if (url.pathname === "/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({
      ok: true,
      logFile,
      clients: clients.size
    }));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

recentEntries = await readRecentEntries();
await resetOffsetToEnd();
setInterval(pollLogFile, 500);

server.on("error", (error) => {
  console.error(`[monitor] failed to listen on 127.0.0.1:${config.monitorPort}: ${error.message}`);
  process.exit(1);
});

server.listen(config.monitorPort, "127.0.0.1", () => {
  console.log(`[monitor] reading ${logFile}`);
  console.log(`[monitor] open http://127.0.0.1:${config.monitorPort}`);
});
