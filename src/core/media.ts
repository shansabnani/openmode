import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

export const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".mkv", ".m4v"] as const;
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"] as const;
export const AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"] as const;

export type MediaKind = "video" | "image" | "audio";

const DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_MAX_REDIRECTS = 4;

export function isUrl(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}

/** Lower-cased extension (with the dot) of a local path or URL. */
export function mediaExt(src: string): string {
  let pathname = src.trim();
  if (isUrl(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      // fall through with the raw string
    }
  }
  return extname(pathname).toLowerCase();
}

export function mediaKind(src: string): MediaKind | null {
  const ext = mediaExt(src);
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) return "video";
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return "image";
  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return "audio";
  return null;
}

function isPrivateIPv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Only public https media may be fetched (http is allowed for localhost). An
 * agent can be handed a crafted URL, so private and link-local addresses are
 * refused before any request is made.
 */
export function assertFetchableUrl(src: string): void {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new Error(`Not a valid URL: ${src}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "127.0.0.1" || host === "localhost";
  if (url.protocol === "http:" && local) return;
  if (url.protocol !== "https:") {
    throw new Error("Media URLs must be https (http is allowed for localhost only).");
  }
  if (
    local ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    isPrivateIPv4(host) ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("::ffff:")
  ) {
    throw new Error("Refusing to fetch media from a private address.");
  }
}

async function download(src: string, dest: string): Promise<void> {
  let current = src;
  for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop += 1) {
    assertFetchableUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Media redirect has no Location header.");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error(`Could not fetch ${src} (HTTP ${response.status}).`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > DOWNLOAD_MAX_BYTES) throw new Error(`${src} is larger than 2 GB.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > DOWNLOAD_MAX_BYTES) throw new Error(`${src} is larger than 2 GB.`);
    writeFileSync(dest, buffer);
    return;
  }
  throw new Error(`Too many redirects fetching ${src}.`);
}

/**
 * Turn a source (a local path, relative to baseDir, or an https URL) into a
 * local file path. URLs are downloaded once into cacheDir.
 */
export async function materialize(
  src: string,
  options: { baseDir: string; cacheDir: string },
): Promise<string> {
  if (isUrl(src)) {
    mkdirSync(options.cacheDir, { recursive: true });
    const stamp = createHash("sha1").update(src).digest("hex").slice(0, 16);
    const dest = join(options.cacheDir, `${stamp}${mediaExt(src) || ".bin"}`);
    try {
      if (statSync(dest).size > 0) return dest;
    } catch {
      // not cached yet
    }
    await download(src, dest);
    return dest;
  }
  const path = isAbsolute(src) ? src : resolve(options.baseDir, src);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    // reported below
  }
  if (!isFile) throw new Error(`File not found: ${src} (looked at ${path})`);
  return path;
}
