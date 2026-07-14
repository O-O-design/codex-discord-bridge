import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_ID_PATTERN = /session id:\s*([0-9a-f-]+)/i;

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

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 3_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectProcess(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        const error = new Error(`Codex CLI timed out after ${timeoutMs}ms`);
        error.stdout = stdout;
        error.stderr = stderr;
        rejectProcess(error);
        return;
      }

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

function buildDiscordPrompt({ author, authorProfile, channel, guild, content, recentContext }) {
  return [
    "你現在是被 Discord bot「歐歐」呼叫的本機 Codex CLI。",
    "Discord bot 只是聲帶；真正回覆的是這條 Codex session。",
    "請直接輸出要送回 Discord 的回覆。",
    "保持繁體中文，短、自然、像聊天。可以回應動作，不要硬梆梆，但要認真工作。",
    "",
    `Discord 來源：${guild} / ${channel}`,
    `使用者：${author}`,
    authorProfile ? `使用者身份資料：${authorProfile}` : "",
    "",
    recentContext ? `最近頻道上下文（舊到新）：\n${recentContext}\n` : "",
    "使用者訊息：",
    content
  ].join("\n");
}

export async function seedCodexSession(config, seedPrompt) {
  const outputDir = await mkdtemp(join(tmpdir(), "oo-bridge-seed-"));
  const outputFile = join(outputDir, "last-message.txt");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    config.codexSandbox,
    "-o",
    outputFile,
    seedPrompt
  ];

  try {
    const result = await runProcess(config.codexCliPath, args, {
      cwd: process.cwd(),
      timeoutMs: config.codexTimeoutMs
    });
    const match = `${result.stdout}\n${result.stderr}`.match(SESSION_ID_PATTERN);

    if (!match) {
      throw new Error("Codex CLI did not print a session id.");
    }

    await writeFile(config.codexSessionFile, `${match[1]}\n`, "utf8");
    return (await readFile(outputFile, "utf8")).trim();
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

export async function askCodex(config, messageContext) {
  const sessionId = await readSessionId(config.codexSessionFile);

  if (!sessionId) {
    throw new Error("Missing Codex session. Run `npm run seed` first.");
  }

  const outputDir = await mkdtemp(join(tmpdir(), "oo-bridge-codex-"));
  const outputFile = join(outputDir, "last-message.txt");
  const prompt = buildDiscordPrompt(messageContext);
  const args = [
    "exec",
    "resume",
    "--skip-git-repo-check",
    "-o",
    outputFile,
    sessionId,
    prompt
  ];

  try {
    await runProcess(config.codexCliPath, args, {
      cwd: process.cwd(),
      timeoutMs: config.codexTimeoutMs
    });
    return (await readFile(outputFile, "utf8")).trim() || "我有收到，但 Codex 沒吐出文字回覆。";
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
