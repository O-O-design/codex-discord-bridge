import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getConfig } from "./config.js";
import { seedCodexSession } from "./codex.js";

const config = getConfig({ requireDiscord: false });
const seedPath = resolve(process.cwd(), process.env.CODEX_SEED_FILE?.trim() || "memory/default-seed.md");
const seedPrompt = await readFile(seedPath, "utf8");
const response = await seedCodexSession(config, seedPrompt);

console.log(response || "Seeded Codex session.");
console.log(`Session stored at ${config.codexSessionFile}`);
