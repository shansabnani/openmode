import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  detectFfmpeg,
  detectFfprobe,
  encoderArgs,
  ffmpegFilters,
  pickEncoder,
  probeFile,
  runFfmpeg,
  type EncoderName,
  type ProbeInfo,
  type Quality,
} from "../../core/ffmpeg.js";
import { materialize } from "../../core/media.js";
import {
  cacheDir,
  makeJobDir,
  removeDir,
  resolveOutput,
  round,
  type RenderResult,
} from "../../core/output.js";
import { collectCaptions, writeAssFile } from "./captions.js";
import { placeClips, placeTracks, planFfmpeg } from "./plan.js";
import { EditError, parseEdit, type Edit } from "./schema.js";

export * from "./schema.js";
export { placeClips, placeTracks, planFfmpeg } from "./plan.js";
export { collectCaptions } from "./captions.js";

export type EditRenderRequest = {
  /** Path to an edit JSON file. Clip paths are relative to this file. */
  file?: string;
  /** Or the edit itself. Clip paths are then relative to baseDir. */
  edit?: unknown;
  baseDir?: string;
  quality?: Quality;
  out?: string;
};

export function loadEdit(request: EditRenderRequest): { edit: Edit; baseDir: string; name: string } {
  if (request.file) {
    const path = resolve(request.baseDir ?? process.cwd(), request.file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new EditError(`Could not read ${path}: ${(error as Error).message}`);
    }
    return {
      edit: parseEdit(raw),
      baseDir: dirname(path),
      name: basename(path).replace(/\.json$/i, ""),
    };
  }
  if (request.edit === undefined) throw new EditError("Give an edit file or an edit object.");
  return {
    edit: parseEdit(request.edit),
    baseDir: resolve(request.baseDir ?? process.cwd()),
    name: "edit",
  };
}

async function probeSources(edit: Edit, baseDir: string, ffprobe: string) {
  const probes = new Map<string, ProbeInfo>();
  const sources = [...edit.clips.map((clip) => clip.src), ...(edit.audio ?? []).map((t) => t.src)];
  for (const src of sources) {
    if (probes.has(src)) continue;
    const path = await materialize(src, { baseDir, cacheDir: cacheDir() });
    probes.set(src, await probeFile(path, ffprobe));
  }
  return probes;
}

/** Check an edit without rendering it: schema, files, and every time range. */
export async function validateEdit(request: EditRenderRequest) {
  const { edit, baseDir } = loadEdit(request);
  const probes = await probeSources(edit, baseDir, detectFfprobe());
  const timeline = placeClips(edit, probes, request.quality ?? "final");
  placeTracks(edit, probes, timeline.duration);
  return {
    ok: true as const,
    duration: round(timeline.duration),
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    clips: timeline.clips.map((clip) => ({
      index: clip.index,
      at: round(clip.at),
      duration: round(clip.duration),
    })),
  };
}

/** Render an edit (clips, captions, music) to an MP4 with the local ffmpeg. */
export async function renderEdit(request: EditRenderRequest): Promise<RenderResult> {
  const started = Date.now();
  const quality: Quality = request.quality ?? "draft";
  const { edit, baseDir, name } = loadEdit(request);
  const ffmpeg = detectFfmpeg();
  const probes = await probeSources(edit, baseDir, detectFfprobe(ffmpeg));
  const timeline = placeClips(edit, probes, quality);
  const tracks = placeTracks(edit, probes, timeline.duration);
  const output = resolveOutput(
    request.out,
    join(baseDir, "renders", `${name}-${quality}.mp4`),
    [...probes.values()].map((probe) => probe.path),
  );

  const jobDir = makeJobDir();
  try {
    const captions = collectCaptions(edit, timeline);
    let assPath: string | undefined;
    if (captions.length) {
      if (!(await ffmpegFilters(ffmpeg)).has("ass")) {
        throw new EditError(
          "This ffmpeg build cannot draw captions (it was built without libass). Install a full ffmpeg build, or remove captions and endCard.",
        );
      }
      assPath = join(jobDir, "captions.ass");
      writeAssFile(captions, timeline, assPath);
    }
    const plan = planFfmpeg(edit, timeline, tracks, { assPath });
    const argv = (encoder: EncoderName) => [
      "-y", "-hide_banner", "-loglevel", "error",
      ...plan.inputs,
      "-filter_complex", plan.filterComplex,
      ...plan.maps,
      ...encoderArgs(encoder, quality),
      "-pix_fmt", "yuv420p",
      ...(plan.hasAudio
        ? ["-c:a", "aac", "-b:a", quality === "draft" ? "128k" : "192k", "-ar", "48000"]
        : ["-an"]),
      "-movflags", "+faststart",
      "-t", plan.duration.toFixed(4),
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
      engine: "edit",
      path: output,
      quality,
      duration: round(timeline.duration),
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      size: statSync(output).size,
      seconds: round((Date.now() - started) / 1000),
      hasAudio: plan.hasAudio,
      encoder,
    };
  } finally {
    removeDir(jobDir);
  }
}
