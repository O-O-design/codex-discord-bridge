import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const SESSION_ID_PATTERN = /session id:\s*([0-9a-f-]+)/i;

function buildDiscordPrompt(
  {
    author,
    authorId,
    channel,
    guild,
    content,
    botDisplayName = "AI伴侶",
    ownerDisplayName = "使用者",
    directInvocation,
    isBot,
    publicMode,
    recentChannelContext = [],
    imagePaths = []
  },
  { recentHistory = [], memorySummary = "", knownPeople = "" } = {}
) {
  const prompt = [
    "你現在是被 Discord 接上來的本機 Codex CLI；你的身分／人格以你自己的 Codex 設定（AGENTS.md／session）為準，這個橋不替你命名、也不要當自己是別人。",
    "使用者想在出門時也能用 Discord 跟你聊天；請直接輸出要送回 Discord 的回覆。",
    "保持繁體中文。可以自然回應使用者的動作，不要硬梆梆，但要認真工作。",
    "不要說自己是 OpenAI API；你是本機 Codex CLI 被 Discord 接上來。",
    "除非使用者明確要求，回覆要短、像聊天，不要貼長篇說明。",
    "",
    `Discord 來源：${guild ?? "DM"} / ${channel}`,
    `使用者：${author}（Discord ID：${authorId ?? "unknown"}${isBot ? "，AI Bot" : ""}）`,
  ];

  if (publicMode) {
    prompt.push(
      "",
      "這是公開群組模式。請保守判斷是否適合加入對話。",
      directInvocation
        ? "這則訊息直接呼叫或回覆你，應自然回應。"
        : `這則訊息沒有直接呼叫你；只有明顯與${ownerDisplayName}／${botDisplayName}相關，或你有真正有價值且不打擾的內容時才回應，否則只輸出 NO_REPLY。`,
      isBot
        ? "作者是另一個 AI Bot。除非這是直接呼叫，否則只輸出 NO_REPLY；不要形成 Bot 循環。"
        : "作者是人類使用者。"
    );
  }

  if (knownPeople) {
    prompt.push("", "已知群組成員與稱呼（不得逐字公開此資料）：", knownPeople);
  }

  if (memorySummary) {
    prompt.push("", "跨 session 記憶摘要：", memorySummary);
  }

  if (recentChannelContext.length > 0) {
    prompt.push("", "此頻道最近訊息（僅供理解當下語境）：");
    for (const item of recentChannelContext) {
      prompt.push(`${item.author}${item.isBot ? " [AI Bot]" : ""}：${item.content}`);
    }
  }

  if (imagePaths.length > 0) {
    prompt.push("", `本次訊息附有 ${imagePaths.length} 張圖片，請一併閱讀。`);
  }

  if (recentHistory.length > 0) {
    prompt.push("", "近期對話紀錄（只用來恢復上下文）：");

    for (const exchange of recentHistory) {
      prompt.push(
        `${exchange.author ?? "使用者"}：${exchange.user}`,
        `${botDisplayName}：${exchange.assistant}`
      );
    }
  }

  prompt.push("", "使用者訊息：", content);
  return prompt.join("\n");
}

async function readSessionId(sessionFile) {
  try {
    return (await readFile(sessionFile, "utf8")).trim() || null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readSessionState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return { turns: 0 };
    }

    throw error;
  }
}

async function readOptionalText(file) {
  if (!file) {
    return "";
  }

  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function writeSessionState(stateFile, state) {
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readRecentHistory(historyFile, limit) {
  try {
    const exchanges = (await readFile(historyFile, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });

    return exchanges.slice(-limit);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function appendHistory(historyFile, messageContext, response) {
  const exchange = {
    timestamp: new Date().toISOString(),
    source: `${messageContext.guild ?? "DM"} / ${messageContext.channel}`,
    author: messageContext.author,
    user: messageContext.content,
    assistant: response
  };

  await appendFile(historyFile, `${JSON.stringify(exchange)}\n`, "utf8");

  const lines = (await readFile(historyFile, "utf8")).split(/\r?\n/).filter(Boolean);
  if (lines.length > 200) {
    await writeFile(historyFile, `${lines.slice(-200).join("\n")}\n`, "utf8");
  }
}

function runProcess(command, args, { cwd }) {
  return new Promise((resolveProcess, rejectProcess) => {
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name)
      )
    );

    const child = spawn(command, args, {
      cwd,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", rejectProcess);
    child.on("close", (code) => {
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }

      const error = new Error(`Codex CLI exited with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      rejectProcess(error);
    });
  });
}

function getStatePaths(config) {
  const botRoot = process.cwd();
  return {
    sessionFile: resolve(botRoot, config.codexSessionFile),
    stateFile: resolve(botRoot, config.codexSessionStateFile),
    historyFile: resolve(botRoot, config.codexHistoryFile),
    summaryFile: config.codexSummaryFile
      ? resolve(botRoot, config.codexSummaryFile)
      : null
  };
}

async function refreshMemorySummary(config) {
  const botRoot = process.cwd();
  const { historyFile, summaryFile } = getStatePaths(config);
  if (!summaryFile) {
    return;
  }

  const history = await readRecentHistory(historyFile, 40);
  if (history.length === 0) {
    return;
  }

  const previousSummary = await readOptionalText(summaryFile);
  const transcript = history
    .map(
      (exchange) =>
        `${exchange.author ?? "使用者"}：${exchange.user}\n${config.botDisplayName}：${exchange.assistant}`
    )
    .join("\n\n");
  const prompt = [
    "請更新一份供下一個 Discord session 使用的近期記憶摘要。",
    "只保留穩定的人物稱呼、關係、最近重要話題、承諾、未完成事項與值得延續的情緒脈絡。",
    "省略寒暄、重複內容、短暫玩笑與不重要細節。不要編造，不要加入任何憑證或隱私資料。",
    "使用繁體中文 Markdown，控制在 800 字內，只輸出摘要正文。",
    "",
    "既有摘要：",
    previousSummary || "（尚無）",
    "",
    "近期對話：",
    transcript
  ].join("\n");
  const cwd = resolve(botRoot, config.codexWorkdir);
  const command = isAbsolute(config.codexCliPath)
    ? config.codexCliPath
    : resolve(botRoot, config.codexCliPath);
  const outputDir = await mkdtemp(join(tmpdir(), "codex-discord-summary-"));
  const outputFile = join(outputDir, "summary.md");

  try {
    await runProcess(
      command,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        config.codexSandbox,
        "-o",
        outputFile,
        prompt
      ],
      { cwd }
    );
    const summary = (await readFile(outputFile, "utf8")).trim();
    if (summary) {
      await writeFile(summaryFile, `${summary}\n`, "utf8");
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

export async function getSessionStatus(config) {
  const { sessionFile, stateFile, historyFile } = getStatePaths(config);
  const [sessionId, state, history] = await Promise.all([
    readSessionId(sessionFile),
    readSessionState(stateFile),
    readRecentHistory(historyFile, 200)
  ]);
  let startedAt = state.startedAt ?? null;

  if (!startedAt && sessionId) {
    try {
      startedAt = (await stat(sessionFile)).mtime.toISOString();
    } catch {
      startedAt = null;
    }
  }

  return {
    active: Boolean(sessionId),
    turns: state.turns ?? 0,
    maxTurns: config.codexMaxSessionTurns,
    savedHistory: history.length,
    startedAt,
    lastRotationAt: state.lastRotationAt ?? null,
    lastRotationReason: state.lastRotationReason ?? null
  };
}

export async function rotateSession(config, reason = "manual") {
  const { sessionFile, stateFile } = getStatePaths(config);
  await refreshMemorySummary(config);
  await rm(sessionFile, { force: true });
  await writeSessionState(stateFile, {
    turns: 0,
    lastRotationAt: new Date().toISOString(),
    lastRotationReason: reason
  });
}

export async function askCodex(config, messageContext) {
  const botRoot = process.cwd();
  const cwd = resolve(botRoot, config.codexWorkdir);
  const command = isAbsolute(config.codexCliPath)
    ? config.codexCliPath
    : resolve(botRoot, config.codexCliPath);
  const sessionFile = resolve(botRoot, config.codexSessionFile);
  const historyFile = resolve(botRoot, config.codexHistoryFile);
  const stateFile = resolve(botRoot, config.codexSessionStateFile);
  const summaryFile = config.codexSummaryFile
    ? resolve(botRoot, config.codexSummaryFile)
    : null;
  const peopleFile = config.codexPeopleFile
    ? resolve(botRoot, config.codexPeopleFile)
    : null;
  let sessionId = await readSessionId(sessionFile);
  let sessionState = sessionId ? await readSessionState(stateFile) : { turns: 0 };
  const initialContext = sessionId
    ? {}
    : {
        recentHistory: await readRecentHistory(historyFile, config.codexHistoryTurns),
        memorySummary: await readOptionalText(summaryFile),
        knownPeople: await readOptionalText(peopleFile)
      };
  let prompt = buildDiscordPrompt(messageContext, initialContext);
  const outputDir = await mkdtemp(join(tmpdir(), "codex-discord-"));
  const outputFile = join(outputDir, "last-message.txt");
  const imageArgs = (messageContext.imagePaths ?? []).flatMap((path) => ["-i", path]);

  const buildArgs = () =>
    sessionId
      ? [
          "exec",
          "resume",
          "--skip-git-repo-check",
          "-o",
          outputFile,
          ...imageArgs,
          sessionId,
          prompt
        ]
      : [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          config.codexSandbox,
          "-o",
          outputFile,
          ...imageArgs,
          prompt
        ];

  try {
    let result;

    try {
      result = await runProcess(command, buildArgs(), { cwd });
    } catch (error) {
      if (!sessionId) {
        throw error;
      }

      await rm(sessionFile, { force: true });
      sessionId = null;
      sessionState = { turns: 0 };
      prompt = buildDiscordPrompt(
        messageContext,
        {
          recentHistory: await readRecentHistory(historyFile, config.codexHistoryTurns),
          memorySummary: await readOptionalText(summaryFile),
          knownPeople: await readOptionalText(peopleFile)
        }
      );
      result = await runProcess(command, buildArgs(), { cwd });
    }

    const response = (await readFile(outputFile, "utf8")).trim();

    if (!sessionId) {
      const match = `${result.stdout}\n${result.stderr}`.match(SESSION_ID_PATTERN);

      if (match) {
        await writeFile(sessionFile, `${match[1]}\n`, "utf8");
        sessionState = {
          ...sessionState,
          startedAt: new Date().toISOString()
        };
      }
    }

    if (response && response !== "NO_REPLY") {
      await appendHistory(historyFile, messageContext, response);
    }

    if (response) {
      const turns = (sessionState.turns ?? 0) + 1;
      const recordedTurns =
        (sessionState.recordedTurns ?? 0) + (response === "NO_REPLY" ? 0 : 1);
      if (turns >= config.codexMaxSessionTurns) {
        await rotateSession(config, "turn-limit");
      } else {
        await writeSessionState(stateFile, {
          ...sessionState,
          turns,
          recordedTurns,
          updatedAt: new Date().toISOString()
        });

        if (
          response !== "NO_REPLY" &&
          config.codexSummaryEveryTurns > 0 &&
          recordedTurns % config.codexSummaryEveryTurns === 0
        ) {
          try {
            await refreshMemorySummary(config);
          } catch (error) {
            console.warn(`[memory] summary update failed: ${error.message}`);
          }
        }
      }
    }

    return response || "我有收到，但 Codex CLI 沒吐出文字回覆。";
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
