import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "../src/config.js";

const config = getConfig({ requireDiscord: false });
const prompt = process.argv.slice(2).join(" ").trim() ||
  "Reply with one short sentence. Do not edit files.";
const logFile = resolve(process.cwd(), "logs/codex-stream-probe.ndjson");
const outputFile = resolve(process.cwd(), "logs/codex-stream-probe-output.txt");
const args = [
  "exec",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "-o",
  outputFile,
  prompt
];

await mkdir(dirname(logFile), { recursive: true });
await writeFile(logFile, "", "utf8");

function writeProbeEvent(event) {
  return appendFile(logFile, `${JSON.stringify({
    ts: new Date().toISOString(),
    ...event
  })}\n`, "utf8");
}

await writeProbeEvent({
  event: "probe_start",
  command: config.codexCliPath,
  args,
  prompt
});

const child = spawn(config.codexCliPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk) => {
  writeProbeEvent({
    event: "stdout",
    text: chunk
  }).catch(() => {});
});

child.stderr.on("data", (chunk) => {
  writeProbeEvent({
    event: "stderr",
    text: chunk
  }).catch(() => {});
});

child.on("error", async (error) => {
  await writeProbeEvent({
    event: "probe_error",
    error: error.message
  });
  process.exitCode = 1;
});

child.on("close", async (code) => {
  await writeProbeEvent({
    event: "probe_close",
    code
  });

  console.log(`Probe log: ${logFile}`);
  console.log(`Final output: ${outputFile}`);
  process.exitCode = code ?? 1;
});
