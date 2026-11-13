import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** What every render returns, whatever engine made it. */
export type RenderResult = {
  engine: string;
  path: string;
  quality: "draft" | "final";
  /** Length of the film in seconds. */
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** File size in bytes. */
  size: number;
  /** Wall-clock seconds the render took. */
  seconds: number;
  hasAudio: boolean;
  encoder: string;
  notes?: string[];
};

export function cacheDir(): string {
  return process.env.OPENMODE_CACHE_DIR?.trim() || join(tmpdir(), "openmode", "cache");
}

export function makeJobDir(): string {
  const root = join(tmpdir(), "openmode");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "job-"));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Where a render is written. Renders may replace an earlier render at the
 * same path, but never one of their own inputs and never a non-MP4 file.
 */
export function resolveOutput(
  out: string | undefined,
  fallback: string,
  inputs: readonly string[] = [],
): string {
  const path = resolve(out?.trim() || fallback);
  if (!path.toLowerCase().endsWith(".mp4")) {
    throw new Error(`Output must end with .mp4 (got ${path}).`);
  }
  if (inputs.some((input) => resolve(input) === path)) {
    throw new Error(`Refusing to write the render over one of its own inputs: ${path}`);
  }
  try {
    if (!statSync(path).isFile()) throw new Error(`Output path is not a file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function round(n: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}
