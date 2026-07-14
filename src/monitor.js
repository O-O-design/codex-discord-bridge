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
  <title>歐歐橋接監控</title>
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
      grid-template-columns: repeat(5, minmax(0, 1fr));
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

    .focus {
      margin-bottom: 12px;
      overflow: hidden;
    }

    .focus-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      padding: 16px;
      align-items: center;
    }

    .work-stage {
      margin-bottom: 6px;
      color: var(--info);
      font-size: 20px;
      font-weight: 750;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .work-summary {
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .work-detail {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(4, minmax(72px, 1fr));
      gap: 8px;
      min-width: min(430px, 42vw);
    }

    .step {
      display: grid;
      place-items: center;
      min-height: 42px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    .step.done {
      border-color: rgba(22, 131, 91, 0.3);
      background: #ebf8f1;
      color: var(--ok);
    }

    .step.active {
      border-color: rgba(47, 103, 216, 0.38);
      background: #edf4ff;
      color: var(--info);
      font-weight: 700;
    }

    .step.failed {
      border-color: rgba(181, 53, 66, 0.32);
      background: #fff0f2;
      color: var(--bad);
      font-weight: 700;
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

    .message-panel {
      margin-bottom: 12px;
    }

    .messages-list {
      max-height: 260px;
      min-height: 150px;
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
    .event.codex_running,
    .event.received,
    .event.queued,
    .event.context,
    .event.codex {
      color: var(--warn);
    }

    .event.done {
      color: var(--ok);
    }

    .event.failed {
      color: var(--bad);
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
      .focus-body,
      .grid,
      .layout {
        grid-template-columns: 1fr;
      }

      .steps {
        min-width: 0;
        grid-template-columns: repeat(2, minmax(0, 1fr));
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
        <h1>歐歐橋接監控</h1>
        <div class="sub">${logFile}</div>
      </div>
      <div id="connection" class="pill">連線中</div>
    </header>

    <section class="panel focus">
      <h2>目前在做什麼</h2>
      <div class="focus-body">
        <div>
          <div id="work-stage" class="work-stage">待命中</div>
          <div id="work-summary" class="work-summary">還沒有新的橋接事件。</div>
          <div id="work-detail" class="work-detail">等待 Discord 訊息進來。</div>
        </div>
        <div id="work-steps" class="steps"></div>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <div class="label">橋接狀態</div>
        <div id="bridge-status" class="value small">等待中</div>
      </div>
      <div class="card">
        <div class="label">排隊任務</div>
        <div id="queue-count" class="value">0</div>
      </div>
      <div class="card">
        <div class="label">正在處理</div>
        <div id="active-job" class="value small">無</div>
      </div>
      <div class="card">
        <div class="label">最近結果</div>
        <div id="last-result" class="value small">無</div>
      </div>
      <div class="card">
        <div class="label">預估完成</div>
        <div id="eta" class="value small">無待處理</div>
      </div>
    </section>

    <section class="panel message-panel">
      <h2>每句訊息狀態</h2>
      <div id="messages" class="list messages-list"></div>
    </section>

    <section class="layout">
      <div class="panel">
        <h2>任務</h2>
        <div id="jobs" class="list"></div>
      </div>
      <div class="panel">
        <h2>事件</h2>
        <div id="events" class="list"></div>
      </div>
    </section>
  </main>

  <script>
    const entries = [];
    const jobs = new Map();
    const EVENT_LABELS = {
      bridge_log_started: '橋接 log 已就緒',
      bridge_ready: '橋接已上線',
      message_accepted: '收到 Discord 訊息',
      bot_loop_limited: 'AI 互聊煞車',
      context_read_start: '讀取可選上下文',
      context_read: '可選上下文已讀',
      context_read_failed: '可選上下文讀取失敗',
      codex_queued: 'Codex 已排隊',
      codex_start: 'Codex 開始處理',
      codex_cli_start: '呼叫 Codex CLI',
      codex_success: 'Codex 完成',
      codex_failed: 'Codex 失敗',
      discord_client_error: 'Discord 連線錯誤',
      monitor_parse_failed: '監控解析失敗'
    };
    const JOB_STATUS_LABELS = {
      queued: '排隊中',
      running: '處理中',
      done: '完成',
      failed: '失敗'
    };
    const MESSAGE_STATUS_LABELS = {
      received: '已收到',
      queued: '已排隊',
      running: '開始處理',
      context: '準備提示',
      codex: 'Codex 處理中',
      done: '已完成',
      failed: '失敗'
    };
    const state = {
      connected: false,
      bridgeStatus: '等待中',
      queueCount: 0,
      activeJobId: null,
      lastResult: '無',
      workStep: 'idle',
      workStage: '待命中',
      workSummary: '還沒有新的橋接事件。',
      workDetail: '等待 Discord 訊息進來。',
      workTone: 'info'
    };
    const WORK_STEPS = [
      ['received', '收到訊息'],
      ['context', '準備提示'],
      ['codex', 'Codex 處理'],
      ['reply', '送回 Discord']
    ];
    const WORK_STEP_ORDER = new Map(WORK_STEPS.map(([key], index) => [key, index]));
    const messages = new Map();

    const connectionEl = document.getElementById('connection');
    const workStageEl = document.getElementById('work-stage');
    const workSummaryEl = document.getElementById('work-summary');
    const workDetailEl = document.getElementById('work-detail');
    const workStepsEl = document.getElementById('work-steps');
    const bridgeStatusEl = document.getElementById('bridge-status');
    const queueCountEl = document.getElementById('queue-count');
    const activeJobEl = document.getElementById('active-job');
    const lastResultEl = document.getElementById('last-result');
    const etaEl = document.getElementById('eta');
    const messagesEl = document.getElementById('messages');
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

    function formatHumanDuration(ms) {
      if (!Number.isFinite(ms)) {
        return '';
      }

      const totalSeconds = Math.max(0, Math.round(ms / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      if (hours > 0) {
        return minutes > 0 ? hours + ' 小時 ' + minutes + ' 分' : hours + ' 小時';
      }

      if (minutes > 0) {
        return seconds > 0 ? minutes + ' 分 ' + seconds + ' 秒' : minutes + ' 分';
      }

      return seconds + ' 秒';
    }

    function formatEventName(eventName) {
      return EVENT_LABELS[eventName] || eventName || '未知事件';
    }

    function formatJobStatus(status) {
      return JOB_STATUS_LABELS[status] || status || '未知';
    }

    function formatMessageStatus(status) {
      return MESSAGE_STATUS_LABELS[status] || status || '未知';
    }

    function setWork(step, stage, summary, detail = '', tone = 'info') {
      state.workStep = step;
      state.workStage = stage;
      state.workSummary = summary || stage;
      state.workDetail = detail || '';
      state.workTone = tone;
    }

    function entryDetail(entry) {
      return [
        entry.channel,
        entry.jobId,
        entry.sandbox,
        Number.isFinite(entry.durationMs) ? formatDuration(entry.durationMs) : ''
      ].filter(Boolean).join(' · ');
    }

    function averageCompletedDuration() {
      const durations = [...jobs.values()]
        .filter((job) => job.status === 'done' && Number.isFinite(job.durationMs))
        .sort((a, b) => new Date(b.finishedTs || 0).getTime() - new Date(a.finishedTs || 0).getTime())
        .slice(0, 8)
        .map((job) => job.durationMs);

      if (durations.length === 0) {
        return null;
      }

      return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    }

    function estimateCompletionText() {
      const hasActive = Boolean(state.activeJobId);
      const queuedCount = Math.max(state.queueCount, 0);

      if (!hasActive && queuedCount === 0) {
        return '無待處理';
      }

      const averageMs = averageCompletedDuration();
      if (!Number.isFinite(averageMs)) {
        return '累積資料中';
      }

      let remainingMs = queuedCount * averageMs;
      const activeJob = hasActive ? jobs.get(state.activeJobId) : null;

      if (hasActive) {
        const startedAt = new Date(activeJob?.startedTs || 0).getTime();
        const elapsedMs = Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : 0;
        remainingMs += Math.max(averageMs - elapsedMs, averageMs * 0.15);
      }

      return '約 ' + eventTime(Date.now() + remainingMs) + '（剩 ' + formatHumanDuration(remainingMs) + '）';
    }

    function formatEntrySummary(entry) {
      switch (entry.event) {
        case 'bridge_log_started':
          return entry.summary
            ? entry.summary.replace('runtime log writing to ', 'runtime log 寫入：')
            : 'runtime log 已開始寫入。';
        case 'bridge_ready':
          return '橋接已登入 Discord：' + (entry.botTag || entry.summary || '未知帳號');
        case 'message_blocked':
          return '已略過黑名單位置：' + (entry.channel || entry.channelId || '未知位置');
        case 'bot_loop_limited':
          return 'AI 互聊煞車：已略過 ' + (entry.author || entry.authorId || '白名單 bot') +
            '，連續 ' + (entry.turnCount ?? '?') + ' 回合，冷卻 ' +
            formatHumanDuration(entry.cooldownRemainingMs || 0);
        case 'message_accepted':
          return (entry.author || '使用者') + ' 在 ' + (entry.channel || '允許位置') + '：' +
            (entry.content || entry.summary || '');
        case 'codex_queued':
          return 'Codex 任務已排隊：' + (entry.jobId || '未知任務') + '，' +
            (entry.batchSize || 1) + ' 則訊息。';
        case 'codex_start':
          return 'Codex 開始處理：' + (entry.jobId || '未知任務') + '，權限 ' +
            (entry.sandbox || '未知') + '。';
        case 'context_read_start':
          return '讀取可選上下文：最多 ' + (entry.contextLimit || '?') + ' 則。';
        case 'context_read':
          return '可選上下文已讀取：' + (entry.count || 0) + ' 則。';
        case 'context_read_failed':
          return '可選上下文讀取失敗：' + (entry.error || entry.summary || '未知錯誤');
        case 'codex_cli_start':
          return '正在呼叫 Codex CLI：' + (entry.jobId || '未知任務') + '。';
        case 'codex_success':
          return 'Codex 任務完成：' + (entry.jobId || '未知任務') + '，回覆 ' +
            (entry.responseLength || 0) + ' 字，耗時 ' + formatHumanDuration(entry.durationMs) + '。';
        case 'codex_failed':
          return 'Codex 任務失敗：' + (entry.jobId || '未知任務') + '，' +
            (entry.error || entry.summary || '未知錯誤');
        case 'discord_client_error':
          return 'Discord client 錯誤：' + (entry.error || entry.summary || '未知錯誤');
        case 'bridge_shutdown':
          return '橋接關閉：' + (entry.signal || entry.summary || '未知訊號');
        default:
          return entry.summary || JSON.stringify(entry);
      }
    }

    function formatJobSummary(job) {
      if (job.status === 'done') {
        return '任務完成：' + job.id + '，回覆 ' + (job.responseLength || 0) + ' 字。';
      }

      if (job.status === 'failed') {
        return '任務失敗：' + job.id + '，' + (job.error || job.summary || '未知錯誤');
      }

      return '任務' + formatJobStatus(job.status) + '：' + job.id + '，' +
        (job.batchSize || 1) + ' 則訊息。';
    }

    function upsertMessageStatus(message, status, entry) {
      if (!message?.messageId) {
        return;
      }

      const previous = messages.get(message.messageId) || {};
      messages.set(message.messageId, {
        ...previous,
        id: message.messageId,
        status,
        jobId: entry.jobId || previous.jobId,
        author: message.author || previous.author || entry.author,
        channel: entry.channel || previous.channel,
        content: message.content || previous.content || entry.content || entry.summary,
        updatedTs: entry.ts,
        detail: entryDetail(entry)
      });

      if (messages.size > 80) {
        const oldest = [...messages.values()]
          .sort((a, b) => new Date(a.updatedTs || 0).getTime() - new Date(b.updatedTs || 0).getTime())[0];
        if (oldest?.id) {
          messages.delete(oldest.id);
        }
      }
    }

    function upsertMessagesFromEntry(entry, status) {
      for (const message of entry.messages || []) {
        upsertMessageStatus(message, status, entry);
      }
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
        state.bridgeStatus = entry.botTag || '已上線';
        setWork('idle', '橋接待命中', formatEntrySummary(entry), entryDetail(entry), 'ok');
      }

      if (entry.event === 'bridge_log_started') {
        state.bridgeStatus = 'log 已就緒';
        setWork('idle', '監控已啟動', formatEntrySummary(entry), entryDetail(entry), 'ok');
      }

      if (entry.event === 'message_accepted') {
        upsertMessageStatus({
          messageId: entry.messageId,
          author: entry.author,
          content: entry.content
        }, 'received', entry);
        setWork(
          'received',
          '收到 Discord 訊息',
          entry.content || formatEntrySummary(entry),
          entryDetail(entry),
          'info'
        );
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
        upsertMessagesFromEntry(entry, 'queued');
        setWork('received', '任務已排隊', formatEntrySummary(entry), entryDetail(entry), 'warn');
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
        upsertMessagesFromEntry(entry, 'running');
        setWork('context', '開始處理任務', formatEntrySummary(entry), entryDetail(entry), 'warn');
      }

      if (entry.event === 'context_read_start') {
        upsertMessagesFromEntry(entry, 'context');
        setWork('context', '讀取可選上下文', formatEntrySummary(entry), entryDetail(entry), 'warn');
      }

      if (entry.event === 'context_read') {
        setWork('context', '可選上下文已整理', formatEntrySummary(entry), entryDetail(entry), 'info');
      }

      if (entry.event === 'context_read_failed') {
        setWork('context', '可選上下文讀取失敗', formatEntrySummary(entry), entryDetail(entry), 'bad');
      }

      if (entry.event === 'bot_loop_limited') {
        setWork('idle', 'AI 互聊煞車已啟動', formatEntrySummary(entry), entryDetail(entry), 'warn');
      }

      if (entry.event === 'codex_cli_start') {
        upsertMessagesFromEntry(entry, 'codex');
        setWork('codex', '交給 Codex CLI', formatEntrySummary(entry), entryDetail(entry), 'warn');
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
        state.lastResult = failed ? '失敗：' + (entry.error || entry.jobId) : '完成：' + formatDuration(entry.durationMs);
        upsertMessagesFromEntry(entry, failed ? 'failed' : 'done');
        setWork(
          failed ? 'failed' : 'done',
          failed ? '任務卡住或失敗' : '已回覆 Discord',
          failed ? formatEntrySummary(entry) : (entry.response || formatEntrySummary(entry)),
          entryDetail(entry),
          failed ? 'bad' : 'ok'
        );
      }

      if (entry.event === 'discord_client_error') {
        setWork('failed', 'Discord 連線錯誤', formatEntrySummary(entry), entryDetail(entry), 'bad');
      }
    }

    function render() {
      connectionEl.textContent = state.connected ? '即時連線' : '重新連線中';
      connectionEl.className = state.connected ? 'pill live' : 'pill';
      workStageEl.textContent = state.workStage;
      workStageEl.style.color = state.workTone === 'bad'
        ? 'var(--bad)'
        : state.workTone === 'ok'
          ? 'var(--ok)'
          : state.workTone === 'warn'
            ? 'var(--warn)'
            : 'var(--info)';
      workSummaryEl.textContent = state.workSummary;
      workDetailEl.textContent = state.workDetail || ' ';
      bridgeStatusEl.textContent = state.bridgeStatus;
      queueCountEl.textContent = String(state.queueCount);
      activeJobEl.textContent = state.activeJobId || '無';
      lastResultEl.textContent = state.lastResult;
      etaEl.textContent = estimateCompletionText();

      renderWorkSteps();
      renderMessages();
      renderJobs();
      renderEvents();
    }

    function renderWorkSteps() {
      const currentIndex = WORK_STEP_ORDER.get(state.workStep);
      const failed = state.workStep === 'failed';
      const done = state.workStep === 'done';

      workStepsEl.innerHTML = WORK_STEPS.map(([key, label], index) => {
        let className = 'step';
        if (failed && index >= 2) {
          className += ' failed';
        } else if (done || (Number.isInteger(currentIndex) && index < currentIndex)) {
          className += ' done';
        } else if (key === state.workStep) {
          className += ' active';
        }

        return '<div class="' + className + '">' + escapeHtml(label) + '</div>';
      }).join('');
    }

    function renderMessages() {
      const sortedMessages = [...messages.values()].sort((a, b) => {
        return new Date(b.updatedTs || 0).getTime() - new Date(a.updatedTs || 0).getTime();
      }).slice(0, 40);

      if (sortedMessages.length === 0) {
        messagesEl.innerHTML = '<div class="empty">還沒有收到訊息。</div>';
        return;
      }

      messagesEl.innerHTML = sortedMessages.map((message) => {
        const meta = [
          message.author,
          message.channel,
          message.jobId,
          message.id
        ].filter(Boolean).join(' · ');

        return '<div class="item">' +
          '<div class="row">' +
            '<div class="event ' + escapeHtml(message.status) + '">' + escapeHtml(formatMessageStatus(message.status)) + '</div>' +
            '<div class="time">' + escapeHtml(eventTime(message.updatedTs)) + '</div>' +
          '</div>' +
          '<div class="summary">' + escapeHtml(message.content || message.id) + '</div>' +
          '<div class="meta">' + escapeHtml(meta) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderJobs() {
      const sortedJobs = [...jobs.values()].sort((a, b) => {
        const left = new Date(b.finishedTs || b.startedTs || b.ts || 0).getTime();
        const right = new Date(a.finishedTs || a.startedTs || a.ts || 0).getTime();
        return left - right;
      }).slice(0, 30);

      if (sortedJobs.length === 0) {
        jobsEl.innerHTML = '<div class="empty">還沒有 Codex 任務。</div>';
        return;
      }

      jobsEl.innerHTML = sortedJobs.map((job) => {
        const duration = formatDuration(job.durationMs);
        const meta = [
          job.channel,
          job.batchSize ? '批次 ' + job.batchSize : '',
          job.sandbox,
          duration
        ].filter(Boolean).join(' · ');

        return '<div class="item">' +
          '<div class="row">' +
            '<div class="event codex_' + escapeHtml(job.status) + '">' + escapeHtml(formatJobStatus(job.status)) + '</div>' +
            '<div class="time">' + escapeHtml(eventTime(job.finishedTs || job.startedTs || job.ts)) + '</div>' +
          '</div>' +
          '<div class="summary">' + escapeHtml(formatJobSummary(job)) + '</div>' +
          '<div class="meta">' + escapeHtml(meta || job.id) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderEvents() {
      if (entries.length === 0) {
        eventsEl.innerHTML = '<div class="empty">等待橋接 log。</div>';
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
            '<div class="event ' + escapeHtml(entry.event) + '">' + escapeHtml(formatEventName(entry.event)) + '</div>' +
            '<div class="time">' + escapeHtml(eventTime(entry.ts)) + '</div>' +
          '</div>' +
          '<div class="summary">' + escapeHtml(formatEntrySummary(entry)) + '</div>' +
          '<div class="meta">' + escapeHtml(meta) + '</div>' +
        '</div>';
      }).join('');
    }

    function resetFromSnapshot(snapshot) {
      entries.length = 0;
      jobs.clear();
      messages.clear();
      state.queueCount = 0;
      state.activeJobId = null;
      state.lastResult = '無';
      setWork('idle', '待命中', '還沒有新的橋接事件。', '等待 Discord 訊息進來。', 'info');
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
