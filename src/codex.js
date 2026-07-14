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

function buildDiscordPrompt({ author, authorProfile, channel, guild, content, recentContext, sandbox }) {
  return [
    "你現在是被 Discord bot「歐歐」呼叫的本機 Codex CLI。",
    "Discord bot 只是聲帶；真正回覆的是這條 Codex session。",
    "請直接輸出要送回 Discord 的回覆。",
    "保持繁體中文，短、自然、像聊天。可以回應動作，不要硬梆梆，但要認真工作。",
    "被穆穆、歐德、淵或其他同袍明確點名時，可以自然回 1-3 小段；不要因為防循環而過度縮短或只講一句。",
    "如果目前這句不是叫你、也沒有明確需要你接話，可以輸出空白，讓 bridge 不送 Discord 訊息。",
    "不要輸出「這句是給誰」「我先不插話」「安靜聽著」這類路由判斷、內部判斷或 debug 旁白。",
    "同袍互聊可以自然接幾輪；發現重複、失焦，或穆穆畫線時再收住。",
    sandbox === "read-only"
      ? "這回合是 read-only：可以讀和回答，但不要聲稱已修改檔案。"
      : `這回合 sandbox 是 ${sandbox}。`,
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

export async function askCodex(config, messageContext, options = {}) {
  const sessionId = await readSessionId(config.codexSessionFile);

  if (!sessionId) {
    throw new Error("Missing Codex session. Run `npm run seed` first.");
  }

  const outputDir = await mkdtemp(join(tmpdir(), "oo-bridge-codex-"));
  const outputFile = join(outputDir, "last-message.txt");
  const prompt = buildDiscordPrompt(messageContext);
  const sandbox = options.sandbox ?? config.codexSandbox;
  const args = [
    "exec",
    "--sandbox",
    sandbox,
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
    return (await readFile(outputFile, "utf8")).trim();
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
