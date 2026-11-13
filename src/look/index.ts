import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  detectFfmpeg,
  detectFfprobe,
  even,
  ffmpegFilters,
  probeFile,
  runFfmpeg,
  type ProbeInfo,
} from "../core/ffmpeg.js";
import { makeJobDir, removeDir, round } from "../core/output.js";
import { describeMissing, findSequence } from "../engines/frames/index.js";

export type LookRequest = {
  /** A video, an image, or a folder of numbered frames. */
  path: string;
  /** How many frames to show on the sheet. Default 12, max 30. */
  frames?: number;
  /** Look only at this stretch of the video, in seconds. */
  start?: number;
  end?: number;
  /** Return one full frame at this second instead of a sheet. */
  at?: number;
  /** Save the picture here (.jpg). Default: a temp file that is returned as bytes only. */
  out?: string;
  /** Skip the sound and black-frame analysis (faster on long files). */
  quick?: boolean;
};

export type Span = { start: number; end: number };

export type LookResult = {
  kind: "video" | "image" | "frames";
  path: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  frameCount?: number;
  videoCodec?: string;
  sizeBytes?: number;
  hasAudio?: boolean;
  /** Integrated loudness in LUFS and true peak in dBFS. */
  loudness?: { lufs: number; peak?: number };
  /** Stretches with no sound (quieter than -35 dB for 0.4 s or more). */
  silences?: Span[];
  /** Stretches where the picture is black. */
  black?: Span[];
  /** Missing frame numbers, for a frames folder. */
  missingFrames?: string;
  /** What each tile on the sheet shows, left to right, top to bottom. */
  tiles: { label: string; seconds?: number; frame?: number }[];
  sheet: { path?: string; width: number; height: number; columns: number; rows: number };
  notes: string[];
  /** JPEG bytes of the sheet. */
  image: Buffer;
};

const SHEET_LONG_EDGE = 1536;

function timeLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function grid(count: number, aspect: number) {
  // Portrait frames are narrow, so more of them fit across.
  const columns = Math.min(count, aspect < 0.8 ? 6 : aspect < 1.2 ? 5 : 4);
  const rows = Math.ceil(count / columns);
  let tileWidth = Math.min(384, Math.floor(SHEET_LONG_EDGE / columns));
  let tileHeight = tileWidth / aspect;
  if (tileHeight * rows > SHEET_LONG_EDGE) {
    tileHeight = SHEET_LONG_EDGE / rows;
    tileWidth = tileHeight * aspect;
  }
  return { columns, rows, tileWidth: even(tileWidth), tileHeight: even(tileHeight) };
}

function parseSpans(log: string, startKey: string, endKey: string): Span[] {
  const spans: Span[] = [];
  const starts = [...log.matchAll(new RegExp(`${startKey}[:=]\\s*(-?[0-9.]+)`, "g"))].map((m) => Number(m[1]));
  const ends = [...log.matchAll(new RegExp(`${endKey}[:=]\\s*(-?[0-9.]+)`, "g"))].map((m) => Number(m[1]));
  starts.forEach((start, i) => {
    const end = ends[i];
    spans.push({ start: round(Math.max(0, start)), end: round(end ?? start) });
  });
  return spans;
}

async function analyseSound(ffmpeg: string, path: string, duration: number) {
  const { stderr } = await runFfmpeg(
    [
      "-hide_banner", "-nostats", "-i", path, "-vn",
      "-af", "silencedetect=noise=-35dB:d=0.4,ebur128=peak=true",
      "-f", "null", "-",
    ],
    { bin: ffmpeg },
  );
  const silences = parseSpans(stderr, "silence_start", "silence_end").map((span) => ({
    start: span.start,
    end: span.end > span.start ? span.end : round(duration),
  }));
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const lufs = Number(summary.match(/I:\s*(-?[0-9.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/Peak:\s*(-?[0-9.]+) dBFS/)?.[1]);
  return {
    silences,
    loudness: Number.isFinite(lufs) ? { lufs, peak: Number.isFinite(peak) ? peak : undefined } : undefined,
  };
}

async function analyseBlack(ffmpeg: string, path: string): Promise<Span[]> {
  const { stderr } = await runFfmpeg(
    [
      "-hide_banner", "-nostats", "-i", path, "-an",
      "-vf", "scale=160:-2,blackdetect=d=0.2:pix_th=0.10",
      "-f", "null", "-",
    ],
    { bin: ffmpeg },
  );
  return parseSpans(stderr, "black_start", "black_end");
}

type Tile = { input: string[]; label: string; seconds?: number; frame?: number };

async function buildSheet(
  ffmpeg: string,
  tiles: Tile[],
  aspect: number,
  outPath: string,
  single: boolean,
): Promise<{ width: number; height: number; columns: number; rows: number }> {
  const canLabel = (await ffmpegFilters(ffmpeg)).has("drawtext");
  const layout = single
    ? {
        columns: 1,
        rows: 1,
        tileWidth: even(aspect >= 1 ? SHEET_LONG_EDGE : SHEET_LONG_EDGE * aspect),
        tileHeight: even(aspect >= 1 ? SHEET_LONG_EDGE / aspect : SHEET_LONG_EDGE),
      }
    : grid(tiles.length, aspect);
  const { tileWidth: w, tileHeight: h, columns, rows } = layout;
  const fontSize = Math.max(12, Math.round(w / 16));
  const build = (labels: boolean) => {
    const filters = tiles.map((tile, i) => {
      const chain = [
        "trim=end_frame=1",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
        "setsar=1",
        "format=yuv420p",
      ];
      if (labels && !single) {
        const text = tile.label.replace(/:/g, "\\:");
        chain.push(
          `drawtext=text='${text}':x=6:y=6:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`,
        );
      }
      return `[${i}:v]${chain.join(",")}[t${i}]`;
    });
    const pads = tiles.map((_, i) => `[t${i}]`).join("");
    filters.push(
      tiles.length === 1
        ? `${pads}null[sheet]`
        : `${pads}concat=n=${tiles.length}:v=1:a=0,tile=${columns}x${rows}[sheet]`,
    );
    return [
      "-y", "-hide_banner", "-loglevel", "error",
      ...tiles.flatMap((tile) => tile.input),
      "-filter_complex", filters.join(";"),
      "-map", "[sheet]", "-frames:v", "1", "-q:v", "4", outPath,
    ];
  };
  try {
    await runFfmpeg(build(canLabel), { bin: ffmpeg });
  } catch (error) {
    if (!canLabel) throw error;
    // drawtext exists but has no usable font on this machine: go without labels.
    await runFfmpeg(build(false), { bin: ffmpeg });
  }
  return { width: w * columns, height: h * rows, columns, rows };
}

/**
 * Let an agent see a video: one contact sheet of evenly spaced frames, plus
 * the facts it needs to judge its own work (length, size, loudness, silent
 * and black stretches). Costs one image instead of a hand-written ffmpeg run.
 */
export async function look(request: LookRequest): Promise<LookResult> {
  const path = resolve(request.path);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`Not found: ${path}`);
  }
  const ffmpeg = detectFfmpeg();
  const ffprobe = detectFfprobe(ffmpeg);
  const count = Math.max(1, Math.min(30, Math.round(request.frames ?? 12)));
  const notes: string[] = [];
  const jobDir = makeJobDir();
  const outPath = request.out ? resolve(request.out) : join(jobDir, "sheet.jpg");
  if (!/\.jpe?g$/i.test(outPath)) throw new Error("The sheet path must end with .jpg");

  try {
    let result: Omit<LookResult, "sheet" | "image">;
    let tiles: Tile[];
    let aspect: number;
    let single = false;

    if (stat.isDirectory()) {
      const sequence = findSequence(path);
      const first = await probeFile(join(path, sequence.files[0]!), ffprobe);
      aspect = (first.width ?? 16) / (first.height ?? 9);
      const picks = Math.min(count, sequence.count);
      const chosen = Array.from({ length: picks }, (_, i) =>
        sequence.files[Math.min(sequence.count - 1, Math.floor(((i + 0.5) * sequence.count) / picks))]!,
      );
      tiles = chosen.map((file) => {
        const frame = Number(file.match(/(\d+)\.[A-Za-z0-9]+$/)?.[1]);
        return { input: ["-i", join(path, file)], label: `#${frame}`, frame };
      });
      result = {
        kind: "frames",
        path,
        width: first.width,
        height: first.height,
        frameCount: sequence.count,
        missingFrames: sequence.missing.length ? describeMissing(sequence.missing) : undefined,
        tiles: [],
        notes,
      };
      notes.push(`Frames ${sequence.first}-${sequence.last}.`);
      if (sequence.missing.length) notes.push(`${sequence.missing.length} frame(s) missing.`);
    } else {
      const probe: ProbeInfo = await probeFile(path, ffprobe);
      if (probe.kind === "audio") {
        throw new Error(`${path} has no picture. look works on videos, images and frame folders.`);
      }
      aspect = (probe.width ?? 16) / (probe.height ?? 9);
      if (probe.kind === "image") {
        single = true;
        tiles = [{ input: ["-i", path], label: "image" }];
        result = {
          kind: "image",
          path,
          width: probe.width,
          height: probe.height,
          sizeBytes: stat.size,
          tiles: [],
          notes,
        };
      } else {
        const duration = probe.duration ?? 0;
        result = {
          kind: "video",
          path,
          duration: round(duration),
          width: probe.width,
          height: probe.height,
          fps: probe.fps ? round(probe.fps, 3) : undefined,
          frameCount: probe.frames,
          videoCodec: probe.videoCodec,
          sizeBytes: stat.size,
          hasAudio: probe.hasAudio,
          tiles: [],
          notes,
        };
        if (request.at !== undefined) {
          if (request.at < 0 || request.at > duration) {
            throw new Error(`at must be between 0 and ${duration.toFixed(2)} seconds.`);
          }
          single = true;
          const seconds = Math.min(request.at, Math.max(0, duration - 0.05));
          tiles = [
            { input: ["-ss", seconds.toFixed(3), "-i", path], label: timeLabel(seconds), seconds: round(seconds) },
          ];
        } else {
          const from = Math.max(0, request.start ?? 0);
          const to = Math.min(duration, request.end ?? duration);
          if (to <= from) throw new Error("end must be after start, inside the video.");
          tiles = Array.from({ length: count }, (_, i) => {
            const seconds = Math.min(from + ((i + 0.5) * (to - from)) / count, Math.max(0, duration - 0.05));
            return {
              input: ["-ss", seconds.toFixed(3), "-i", path],
              label: timeLabel(seconds),
              seconds: round(seconds),
            };
          });
        }
        if (!request.quick) {
          if (probe.hasAudio) {
            const sound = await analyseSound(ffmpeg, path, duration);
            result.loudness = sound.loudness;
            result.silences = sound.silences;
          } else {
            notes.push("No sound.");
          }
          if (duration <= 20 * 60) result.black = await analyseBlack(ffmpeg, path);
          else notes.push("Black-frame check skipped (video is longer than 20 minutes).");
        }
      }
    }

    const sheet = await buildSheet(ffmpeg, tiles, aspect, outPath, single);
    const image = readFileSync(outPath);
    return {
      ...result,
      tiles: tiles.map(({ label, seconds, frame }) => ({ label, seconds, frame })),
      sheet: { ...sheet, path: request.out ? outPath : undefined },
      image,
    };
  } finally {
    removeDir(jobDir);
  }
}
