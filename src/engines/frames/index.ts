import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  detectFfmpeg,
  detectFfprobe,
  encoderArgs,
  even,
  pickEncoder,
  probeFile,
  runFfmpeg,
  type EncoderName,
  type Quality,
} from "../../core/ffmpeg.js";
import { IMAGE_EXTS } from "../../core/media.js";
import { resolveOutput, round, type RenderResult } from "../../core/output.js";

export type FrameSequence = {
  dir: string;
  /** printf-style pattern ffmpeg reads, for example frame_%04d.png */
  pattern: string;
  first: number;
  last: number;
  count: number;
  /** Frame numbers absent between first and last. */
  missing: number[];
  files: string[];
};

/**
 * Find the numbered image sequence in a folder (frame_0001.png, 0001.png,
 * shot.12.jpg ...). The largest group of same-named, same-padded files wins.
 */
export function findSequence(dir: string): FrameSequence {
  const root = resolve(dir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    throw new Error(`Frames folder not found: ${root}`);
  }
  const groups = new Map<string, { prefix: string; pad: number; ext: string; numbers: Map<number, string> }>();
  for (const name of names) {
    const match = name.match(/^(.*?)(\d+)(\.[A-Za-z0-9]+)$/);
    if (!match) continue;
    const [, prefix = "", digits = "", ext = ""] = match;
    if (!(IMAGE_EXTS as readonly string[]).includes(ext.toLowerCase())) continue;
    // Zero-padded names share a width; unpadded names (1.png ... 100.png) do not.
    const pad = digits.startsWith("0") && digits.length > 1 ? digits.length : 0;
    const key = `${prefix}|${pad}|${ext}`;
    const group = groups.get(key) ?? { prefix, pad, ext, numbers: new Map() };
    group.numbers.set(Number(digits), name);
    groups.set(key, group);
  }
  // 0001 … 0999 and 1000 … belong to one padded run; merge unpadded numbers
  // of the same width into the padded group they continue.
  for (const [key, group] of groups) {
    if (group.pad !== 0) continue;
    for (const [otherKey, other] of groups) {
      if (otherKey === key || other.pad === 0) continue;
      if (other.prefix !== group.prefix || other.ext !== group.ext) continue;
      const fits = [...group.numbers.keys()].every((n) => String(n).length === other.pad);
      if (fits) {
        for (const [n, name] of group.numbers) other.numbers.set(n, name);
        groups.delete(key);
      }
    }
  }
  const best = [...groups.values()].sort((a, b) => b.numbers.size - a.numbers.size)[0];
  if (!best || best.numbers.size === 0) {
    throw new Error(
      `No numbered image sequence in ${root}. Expected files like frame_0001.png, frame_0002.png ...`,
    );
  }
  const numbers = [...best.numbers.keys()].sort((a, b) => a - b);
  const first = numbers[0]!;
  const last = numbers.at(-1)!;
  const missing: number[] = [];
  for (let n = first; n <= last; n += 1) if (!best.numbers.has(n)) missing.push(n);
  const escaped = best.prefix.replace(/%/g, "%%");
  return {
    dir: root,
    pattern: `${escaped}%${best.pad ? `0${best.pad}` : ""}d${best.ext}`,
    first,
    last,
    count: numbers.length,
    missing,
    files: numbers.map((n) => best.numbers.get(n)!),
  };
}

export function describeMissing(missing: number[]): string {
  const ranges: string[] = [];
  let start = missing[0];
  let prev = missing[0];
  for (const n of [...missing.slice(1), Number.NaN]) {
    if (n === (prev ?? 0) + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return ranges.slice(0, 12).join(", ") + (ranges.length > 12 ? ", ..." : "");
}

export type FramesRenderRequest = {
  /** Folder of numbered images. */
  dir: string;
  fps?: number;
  /** Optional soundtrack laid under the frames. */
  audio?: string;
  /** Target loudness in LUFS for the soundtrack, for example -14. */
  loudness?: number;
  quality?: Quality;
  /** Scale so the short side is this many pixels. Default: keep the frame size. */
  shortSide?: number;
  out?: string;
};

/** Join a folder of rendered frames (and a soundtrack) into an MP4. */
export async function renderFrames(request: FramesRenderRequest): Promise<RenderResult> {
  const started = Date.now();
  const quality: Quality = request.quality ?? "final";
  const fps = request.fps ?? 24;
  if (!(fps >= 1 && fps <= 120)) throw new Error("fps must be between 1 and 120.");
  const sequence = findSequence(request.dir);
  if (sequence.missing.length) {
    throw new Error(
      `${sequence.missing.length} frame(s) are missing between ${sequence.first} and ${sequence.last}: ${describeMissing(sequence.missing)}. Render them, then try again.`,
    );
  }
  const ffmpeg = detectFfmpeg();
  const ffprobe = detectFfprobe(ffmpeg);
  const firstFrame = await probeFile(join(sequence.dir, sequence.files[0]!), ffprobe);
  if (!firstFrame.width || !firstFrame.height) {
    throw new Error(`Could not read the size of ${sequence.files[0]}.`);
  }
  const short = Math.min(firstFrame.width, firstFrame.height);
  const target = request.shortSide ?? (quality === "draft" ? Math.min(short, 540) : short);
  const scale = target / short;
  const width = even(firstFrame.width * scale);
  const height = even(firstFrame.height * scale);
  const duration = sequence.count / fps;

  let audioPath: string | undefined;
  if (request.audio) {
    audioPath = resolve(request.audio);
    let ok = false;
    try {
      ok = statSync(audioPath).isFile();
    } catch {
      // reported below
    }
    if (!ok) throw new Error(`Audio file not found: ${audioPath}`);
    if (!(await probeFile(audioPath, ffprobe)).hasAudio) {
      throw new Error(`${audioPath} has no sound.`);
    }
  }
  const output = resolveOutput(
    request.out,
    join(sequence.dir, "..", `${basename(sequence.dir)}-${quality}.mp4`),
    audioPath ? [audioPath] : [],
  );

  const audioFilters = [
    "aresample=48000",
    ...(request.loudness !== undefined ? [`loudnorm=I=${request.loudness}:TP=-1.5:LRA=11`, "aresample=48000"] : []),
    "apad",
  ].join(",");
  const argv = (encoder: EncoderName) => [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(fps),
    "-start_number", String(sequence.first),
    "-i", join(sequence.dir, sequence.pattern),
    ...(audioPath ? ["-i", audioPath] : []),
    "-vf", `scale=${width}:${height}:flags=lanczos,setsar=1,format=yuv420p`,
    ...(audioPath ? ["-af", audioFilters, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    ...encoderArgs(encoder, quality),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-t", duration.toFixed(4),
    output,
  ];
  let encoder = await pickEncoder(ffmpeg);
  try {
    await runFfmpeg(argv(encoder), { bin: ffmpeg });
  } catch (error) {
    if (encoder === "libx264") throw error;
    encoder = "libx264";
    await runFfmpeg(argv(encoder), { bin: ffmpeg });
  }
  return {
    engine: "frames",
    path: output,
    quality,
    duration: round(duration),
    width,
    height,
    fps,
    size: statSync(output).size,
    seconds: round((Date.now() - started) / 1000),
    hasAudio: Boolean(audioPath),
    encoder,
    notes: [`${sequence.count} frames (${sequence.first}-${sequence.last})`],
  };
}
