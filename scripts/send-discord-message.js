import "dotenv/config";
import { AttachmentBuilder, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    files: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--channel") {
      options.channelId = next;
      index += 1;
    } else if (arg === "--dm") {
      options.dmUserId = next;
      index += 1;
    } else if (arg === "--reply") {
      options.replyTo = next;
      index += 1;
    } else if (arg === "--content") {
      options.content = next;
      index += 1;
    } else if (arg === "--content-file") {
      options.contentFile = next;
      index += 1;
    } else if (arg === "--file") {
      options.files.push(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run dc:send -- --channel <channel-id> --content-file <file> [--reply <message-id>] [--file <path>]",
    "  npm run dc:send -- --dm <user-id> --content-file <file> [--file <path>]"
  ].join("\n");
}

async function readContent(options) {
  if (options.contentFile) {
    return (await readFile(resolve(options.contentFile), "utf8")).trim();
  }

  return options.content?.trim() ?? "";
}

async function assertFiles(filePaths) {
  for (const filePath of filePaths) {
    const file = await stat(resolve(filePath));

    if (!file.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
  }
}

async function sendMessage(client, options, content) {
  const files = options.files.map((filePath) => new AttachmentBuilder(resolve(filePath)));

  if (options.dmUserId) {
    const user = await client.users.fetch(options.dmUserId);
    const dm = await user.createDM();
    await dm.send({ content: content || undefined, files });
    return;
  }

  const channel = await client.channels.fetch(options.channelId);
  if (!channel || typeof channel.send !== "function") {
    throw new Error(`Channel is not sendable: ${options.channelId}`);
  }

  if (options.replyTo && "messages" in channel) {
    try {
      const message = await channel.messages.fetch(options.replyTo);
      await message.reply({ content: content || undefined, files });
      return;
    } catch {
      // Fall through to a plain channel send when the referenced message is gone.
    }
  }

  await channel.send({ content: content || undefined, files });
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(usage());
  process.exit(0);
}

if (!process.env.DISCORD_TOKEN?.trim()) {
  throw new Error("Missing DISCORD_TOKEN.");
}

if (!options.channelId && !options.dmUserId) {
  throw new Error("Pass --channel or --dm.\n\n" + usage());
}

const content = await readContent(options);
await assertFiles(options.files);

if (!content && options.files.length === 0) {
  throw new Error("Nothing to send. Pass --content, --content-file, or --file.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  try {
    await sendMessage(client, options, content);
    console.log("sent");
  } finally {
    client.destroy();
  }
});

await client.login(process.env.DISCORD_TOKEN.trim());
