import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { lookOnPath, type Quality } from "../../core/ffmpeg.js";
import { makeJobDir, removeDir, resolveOutput, round, type RenderResult } from "../../core/output.js";
import { renderFrames } from "../frames/index.js";
import { DRIVER_PY } from "./driver.js";

export const BLENDER_INSTALL_HINT = `Blender was not found. Install it, then retry.
  macOS:   brew install --cask blender
  Ubuntu:  sudo snap install blender --classic
  Windows: winget install BlenderFoundation.Blender
Or download it from https://www.blender.org/download/ and set BLENDER_PATH to the blender binary.`;

export class BlenderMissingError extends Error {
  constructor() {
    super(BLENDER_INSTALL_HINT);
    this.name = "BlenderMissingError";
  }
}

export const RENDERERS = ["cycles", "eevee", "workbench"] as const;
export type Renderer = (typeof RENDERERS)[number];

/** Drafts are for checking, so they stay small and quick. */
const DRAFT_SHORT_SIDE = 360;
const DRAFT_MAX_SAMPLES = 16;
const DRAFT_MAX_FRAMES = 120;

/** Locate the user's Blender. openmode never ships or downloads it. */
export function detectBlender(): string {
  const fromEnv = process.env.BLENDER_PATH?.trim();
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw new Error(`BLENDER_PATH points at ${fromEnv}, which does not exist.\n${BLENDER_INSTALL_HINT}`);
  }
  const onPath = lookOnPath("blender");
  if (onPath) return onPath;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Blender.app/Contents/MacOS/Blender",
      join(homedir(), "Applications", "Blender.app", "Contents", "MacOS", "Blender"),
    );
  } else if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      const base = join(root, "Blender Foundation");
      try {
        // Newest version first: "Blender 5.3" sorts after "Blender 4.2".
        for (const name of readdirSync(base).sort().reverse()) candidates.push(join(base, name, "blender.exe"));
      } catch {
        // no Blender Foundation folder here
      }
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new BlenderMissingError();
  return found;
}

type Run = { code: number | null; output: string };

function runBlender(bin: string, args: string[], onLine?: (line: string) => void): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const kept: string[] = [];
    let pending = "";
    const take = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        kept.push(line);
        if (kept.length > 60) kept.shift();
        onLine?.(line);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output: kept.join("\n") }));
  });
}

export async function blenderVersion(bin = detectBlender()): Promise<string> {
  const { output } = await runBlender(bin, ["--version"]);
  return output.match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? "unknown";
}

/** "1-48" or "12" → the first and last frame to render. */
export function parseRange(range: string): { start: number; end: number } {
  const match = range.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) throw new Error(`Frame range must look like 1-48 or 12 (got "${range}").`);
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (end < start) throw new Error(`Frame range ${range} ends before it starts.`);
  return { start, end };
}

export type BlenderRenderRequest = {
  /** A .blend file, or a Python script that builds the scene with bpy. */
  file: string;
  quality?: Quality;
  /** Frames to render, for example "1-48" or "12". Default: the scene's own range. */
  range?: string;
  /** Render every Nth frame. The film still plays at normal speed. */
  step?: number;
  /** Override the scene's renderer. */
  renderer?: Renderer;
  /** Override the scene's samples per pixel. */
  samples?: number;
  /** Scale so the short side is this many pixels. Never scales up. */
  shortSide?: number;
  /** Soundtrack laid under the film. */
  audio?: string;
  /** Target loudness in LUFS for the soundtrack. */
  loudness?: number;
  /** Let Python inside the .blend run (drivers, rig scripts). Off by default. */
  allowScripts?: boolean;
  out?: string;
  /** Called after each frame with how many are done and how many there are. */
  onProgress?: (done: number, total: number) => void;
};

type DriverResult = {
  count: number;
  start: number;
  end: number;
  step: number;
  autoStep: boolean;
  fps: number;
  width: number;
  height: number;
  renderer: string;
  samples: number | null;
};

const RENDERER_NAMES: Record<string, string> = {
  CYCLES: "Cycles",
  BLENDER_EEVEE: "EEVEE",
  BLENDER_EEVEE_NEXT: "EEVEE",
  BLENDER_WORKBENCH: "Workbench",
};

/**
 * Render a Blender scene to an MP4. Blender writes one PNG per frame into a
 * temporary folder, then the frames engine joins them. A draft is small, uses
 * few samples and may skip frames, so an agent can check the scene quickly.
 */
export async function renderBlender(request: BlenderRenderRequest): Promise<RenderResult> {
  const started = Date.now();
  const quality: Quality = request.quality ?? "draft";
  const file = resolve(request.file);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    // reported below
  }
  if (!isFile) throw new Error(`Scene not found: ${file}`);
  const ext = extname(file).toLowerCase();
  if (ext !== ".blend" && ext !== ".py") {
    throw new Error(`The Blender engine renders .blend files and .py scene scripts (got ${basename(file)}).`);
  }
  if (request.step !== undefined && !(Number.isInteger(request.step) && request.step >= 1)) {
    throw new Error("step must be a whole number, 1 or more.");
  }
  if (request.samples !== undefined && !(Number.isInteger(request.samples) && request.samples >= 1)) {
    throw new Error("samples must be a whole number, 1 or more.");
  }
  if (request.renderer !== undefined && !RENDERERS.includes(request.renderer)) {
    throw new Error(`renderer must be one of ${RENDERERS.join(", ")}.`);
  }
  const range = request.range ? parseRange(request.range) : undefined;
  const name = basename(file, ext);
  const output = resolveOutput(request.out, join(dirname(file), "renders", `${name}-${quality}.mp4`), [file]);

  const bin = detectBlender();
  const version = await blenderVersion(bin);
  const jobDir = makeJobDir();
  try {
    const driver = join(jobDir, "driver.py");
    const jobFile = join(jobDir, "job.json");
    writeFileSync(driver, DRIVER_PY);
    writeFileSync(
      jobFile,
      JSON.stringify({
        script: ext === ".py" ? file : null,
        start: range?.start,
        end: range?.end,
        step: request.step,
        renderer: request.renderer,
        samples: request.samples,
        shortSide: request.shortSide ?? (quality === "draft" ? DRAFT_SHORT_SIDE : undefined),
        maxSamples: quality === "draft" ? DRAFT_MAX_SAMPLES : undefined,
        maxFrames: quality === "draft" ? DRAFT_MAX_FRAMES : undefined,
      }),
    );
    const args = [
      "--background",
      ...(ext === ".blend"
        ? [request.allowScripts ? "--enable-autoexec" : "--disable-autoexec", file]
        : ["--factory-startup"]),
      "--python-exit-code", "1",
      "--python", driver,
      "--", jobFile,
    ];
    const run = await runBlender(bin, args, (line) => {
      const progress = line.match(/^OPENMODE (\d+)\/(\d+)$/);
      if (progress) request.onProgress?.(Number(progress[1]), Number(progress[2]));
    });

    const errorFile = join(jobDir, "error.json");
    if (existsSync(errorFile)) {
      throw new Error((JSON.parse(readFileSync(errorFile, "utf8")) as { message: string }).message);
    }
    const resultFile = join(jobDir, "result.json");
    if (run.code !== 0 || !existsSync(resultFile)) {
      const last = run.output.split("\n").filter((line) => !line.startsWith("OPENMODE ")).slice(-6).join(" | ");
      throw new Error(`Blender ${version} stopped before the render finished${last ? `: ${last.slice(0, 1200)}` : "."}`);
    }
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as DriverResult;

    // Skipped frames are made up for by a lower frame rate, so the film keeps its length.
    const fps = round(result.fps / result.step, 3);
    if (fps < 1) {
      throw new Error(`step ${result.step} leaves less than one frame per second at ${result.fps} fps. Use a smaller step.`);
    }
    const film = await renderFrames({
      dir: join(jobDir, "frames"),
      fps,
      audio: request.audio,
      loudness: request.loudness,
      quality,
      out: output,
    });
    const renderer = RENDERER_NAMES[result.renderer] ?? result.renderer;
    return {
      ...film,
      engine: "blender",
      quality,
      seconds: round((Date.now() - started) / 1000),
      notes: [
        `Blender ${version}, ${renderer}${result.samples ? `, ${result.samples} samples` : ""}`,
        `${result.count} frame${result.count === 1 ? "" : "s"} (${result.start}-${result.end}${
          result.step > 1 ? `, every ${result.step}${ordinal(result.step)} frame` : ""
        })`,
        ...(result.autoStep
          ? [`Draft skipped frames to stay quick. Pass step 1 to render every frame.`]
          : []),
      ],
    };
  } finally {
    removeDir(jobDir);
  }
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
}
