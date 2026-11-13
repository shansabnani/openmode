import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Quality = "draft" | "final";

export const FFMPEG_INSTALL_HINT = `ffmpeg was not found. Install it, then retry.
  macOS:   brew install ffmpeg
  Ubuntu:  sudo apt-get install ffmpeg
  Windows: winget install ffmpeg
Or set FFMPEG_PATH to the ffmpeg binary.`;

export class FfmpegMissingError extends Error {
  constructor() {
    super(FFMPEG_INSTALL_HINT);
    this.name = "FfmpegMissingError";
  }
}

/** ffmpeg exited non-zero. The message carries the last lines ffmpeg printed. */
export class FfmpegError extends Error {
  constructor(detail: string) {
    super(detail ? `ffmpeg failed: ${detail}` : "ffmpeg failed.");
    this.name = "FfmpegError";
  }
}

export type EncoderName =
  | "libx264"
  | "h264_nvenc"
  | "h264_qsv"
  | "h264_videotoolbox"
  | "h264_amf";

export type ProbeInfo = {
  path: string;
  kind: "video" | "image" | "audio";
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  frames?: number;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
  hasAudio: boolean;
  bitrate?: number;
  size?: number;
};

const HW_ENCODERS: EncoderName[] = [
  "h264_videotoolbox",
  "h264_nvenc",
  "h264_amf",
  "h264_qsv",
];

let cachedBin: string | null | undefined;
let cachedPick: EncoderName | undefined;
let cachedFilters: Set<string> | undefined;

export function resetFfmpegCache(): void {
  cachedBin = undefined;
  cachedPick = undefined;
  cachedFilters = undefined;
}

export function lookOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Locate the user's ffmpeg. openmode never ships or downloads a binary. */
export function detectFfmpeg(): string {
  if (cachedBin !== undefined) {
    if (!cachedBin) throw new FfmpegMissingError();
    return cachedBin;
  }
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  const found = fromEnv && existsSync(fromEnv) ? fromEnv : lookOnPath("ffmpeg");
  cachedBin = found ?? null;
  if (!found) throw new FfmpegMissingError();
  return found;
}

export function detectFfprobe(ffmpegPath = detectFfmpeg()): string {
  const fromEnv = process.env.FFPROBE_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const sibling = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (_m, ext?: string) =>
    ext ? "ffprobe.exe" : "ffprobe",
  );
  if (sibling !== ffmpegPath && existsSync(sibling)) return sibling;
  const found = lookOnPath("ffprobe");
  if (!found) throw new FfmpegMissingError();
  return found;
}

function tail(text: string, lines = 6): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ")
    .slice(0, 1200);
}

export async function runFfmpeg(
  args: string[],
  options: { timeoutMs?: number; bin?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = options.bin ?? detectFfmpeg();
  try {
    return await execFileAsync(bin, args, {
      timeout: options.timeoutMs ?? 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const killed = (error as { killed?: boolean }).killed;
    throw new FfmpegError(killed ? "timed out." : tail(stderr));
  }
}

export async function ffmpegVersion(bin = detectFfmpeg()): Promise<string> {
  const { stdout } = await runFfmpeg(["-version"], { bin, timeoutMs: 10_000 });
  return stdout.split("\n")[0]?.replace(/^ffmpeg version\s+/, "").split(" ")[0] ?? "unknown";
}

/** Names of the filters this ffmpeg build has (ass, drawtext, xfade, ...). */
export async function ffmpegFilters(bin = detectFfmpeg()): Promise<Set<string>> {
  if (cachedFilters) return cachedFilters;
  const { stdout } = await runFfmpeg(["-hide_banner", "-filters"], {
    bin,
    timeoutMs: 10_000,
  });
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*[A-Z.|]{2,3}\s+(\S+)\s/);
    if (match) names.add(match[1]!);
  }
  cachedFilters = names;
  return names;
}

export function encoderArgs(name: EncoderName, quality: Quality): string[] {
  const draft = quality === "draft";
  switch (name) {
    case "h264_nvenc":
      return ["-c:v", name, "-preset", draft ? "p1" : "p5", "-cq", draft ? "32" : "18", "-b:v", "0"];
    case "h264_qsv":
      return ["-c:v", name, "-preset", draft ? "veryfast" : "medium", "-global_quality", draft ? "32" : "20"];
    case "h264_videotoolbox":
      return ["-c:v", name, "-q:v", draft ? "45" : "68"];
    case "h264_amf":
      return ["-c:v", name, "-quality", draft ? "speed" : "quality", "-rc", "cqp", "-qp_i", draft ? "32" : "18"];
    default:
      return ["-c:v", "libx264", "-preset", draft ? "ultrafast" : "medium", "-crf", draft ? "30" : "17"];
  }
}

async function encoderWorks(bin: string, name: EncoderName): Promise<boolean> {
  try {
    await runFfmpeg(
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
        "-frames:v", "1",
        ...encoderArgs(name, "draft"),
        "-f", "null", "-",
      ],
      { bin, timeoutMs: 8_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Fastest H.264 encoder that really works on this machine. Hardware encoders
 * are tried with a one-frame encode because ffmpeg lists them even when the
 * device is missing. OPENMODE_ENCODER=libx264 forces software.
 */
export async function pickEncoder(bin = detectFfmpeg()): Promise<EncoderName> {
  if (cachedPick) return cachedPick;
  const forced = process.env.OPENMODE_ENCODER?.trim() as EncoderName | undefined;
  if (forced === "libx264" || (forced && HW_ENCODERS.includes(forced))) {
    cachedPick = forced;
    return forced;
  }
  const { stdout } = await runFfmpeg(["-hide_banner", "-encoders"], { bin, timeoutMs: 10_000 });
  for (const name of HW_ENCODERS) {
    if (stdout.includes(` ${name} `) && (await encoderWorks(bin, name))) {
      cachedPick = name;
      return name;
    }
  }
  cachedPick = "libx264";
  return "libx264";
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate || rate === "0/0" || rate === "N/A") return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (num !== undefined && den && Number.isFinite(num / den)) return num / den;
  const plain = Number(rate);
  return Number.isFinite(plain) && plain > 0 ? plain : undefined;
}

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  pix_fmt?: string;
  disposition?: { attached_pic?: number };
};

const STILL_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff", "gif", "jpeg2000"]);

export async function probeFile(path: string, ffprobe = detectFfprobe()): Promise<ProbeInfo> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`Could not read ${path}: ${tail(stderr, 2) || "not a media file"}`);
  }
  const json = JSON.parse(stdout) as {
    streams?: FfprobeStream[];
    format?: { duration?: string; bit_rate?: string; size?: string; format_name?: string };
  };
  const streams = json.streams ?? [];
  const video = streams.find(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(json.format?.duration ?? video?.duration ?? audio?.duration);
  const formatName = json.format?.format_name ?? "";
  const still =
    Boolean(video) &&
    !audio &&
    (formatName.includes("image2") ||
      formatName.endsWith("_pipe") ||
      (STILL_CODECS.has(video?.codec_name ?? "") && !(Number(video?.nb_frames) > 1)));
  const frames = Number(video?.nb_frames);
  return {
    path,
    kind: !video ? "audio" : still ? "image" : "video",
    width: video?.width,
    height: video?.height,
    fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    duration: !still && Number.isFinite(duration) && duration > 0 ? duration : undefined,
    frames: Number.isFinite(frames) && frames > 0 ? frames : undefined,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    pixFmt: video?.pix_fmt,
    hasAudio: Boolean(audio),
    bitrate: Number(json.format?.bit_rate) || undefined,
    size: Number(json.format?.size) || undefined,
  };
}

/** Round to an even pixel count (H.264 with yuv420p needs even sides). */
export function even(n: number): number {
  const rounded = Math.max(16, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/** Escape a path for use inside a single-quoted ffmpeg filter argument. */
export function filterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
