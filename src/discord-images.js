import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"]
]);

function isTrustedDiscordUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" ||
        url.hostname === "media.discordapp.net")
    );
  } catch {
    return false;
  }
}

function getCustomEmojiSources(content) {
  const matches = content.matchAll(/<a?:([A-Za-z0-9_]+):(\d+)>/g);
  const seen = new Set();
  const sources = [];

  for (const match of matches) {
    const [, name, id] = match;
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    sources.push({
      contentType: "image/png",
      name,
      size: null,
      url: `https://cdn.discordapp.com/emojis/${id}.png?size=128&quality=lossless`
    });
  }

  return sources;
}

export function hasCustomEmoji(content) {
  return /<a?:[A-Za-z0-9_]+:\d+>/.test(content);
}

export async function downloadDiscordImages(message, config) {
  const sources = [
    ...message.attachments.values(),
    ...getCustomEmojiSources(message.content)
  ];
  const eligible = sources
    .filter(
      (source) =>
        IMAGE_EXTENSIONS.has(source.contentType) &&
        (source.size === null || source.size <= config.imageMaxBytes) &&
        isTrustedDiscordUrl(source.url)
    )
    .slice(0, config.imageMaxCount);

  if (eligible.length === 0) {
    return { paths: [], cleanup: async () => {} };
  }

  const directory = await mkdtemp(join(tmpdir(), "rin-ye-discord-images-"));
  const paths = [];

  try {
    for (const [index, source] of eligible.entries()) {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`Image download failed with HTTP ${response.status}`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > config.imageMaxBytes) {
        throw new Error("Downloaded image exceeded the configured size limit");
      }

      const path = join(
        directory,
        `image-${index + 1}${IMAGE_EXTENSIONS.get(source.contentType)}`
      );
      await writeFile(path, data);
      paths.push(path);
    }

    return {
      paths,
      cleanup: () => rm(directory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
