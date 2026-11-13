import { statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Quality } from "../core/ffmpeg.js";
import type { RenderResult } from "../core/output.js";
import { renderEdit } from "./edit/index.js";
import { renderFrames } from "./frames/index.js";

/** Options every engine understands. Engines ignore the ones they do not use. */
export type RenderOptions = {
  quality?: Quality;
  out?: string;
  fps?: number;
  audio?: string;
  loudness?: number;
};

/**
 * An engine turns one kind of input into an MP4. To add one (Blender, HTML
 * compositions, a model API), create src/engines/<name>/ and list it here:
 * the CLI picks it up through `accepts`, and the MCP server through its tool.
 */
export type Engine = {
  name: string;
  /** One line shown by `openmode status`. */
  summary: string;
  /** Does this engine render that input? `isDir` is true for folders. */
  accepts(input: string, isDir: boolean): boolean;
  render(input: string, options: RenderOptions): Promise<RenderResult>;
};

export const engines: Engine[] = [
  {
    name: "edit",
    summary: "An edit file (.json): clips, trims, speed, fades, captions, music → MP4",
    accepts: (input, isDir) => !isDir && extname(input).toLowerCase() === ".json",
    render: (input, options) => renderEdit({ file: input, quality: options.quality, out: options.out }),
  },
  {
    name: "frames",
    summary: "A folder of numbered frames (+ a soundtrack) → MP4",
    accepts: (_input, isDir) => isDir,
    render: (input, options) =>
      renderFrames({
        dir: input,
        fps: options.fps,
        audio: options.audio,
        loudness: options.loudness,
        quality: options.quality,
        out: options.out,
      }),
  },
];

/** Render whatever the agent made, choosing the engine from the input. */
export async function render(input: string, options: RenderOptions = {}): Promise<RenderResult> {
  const path = resolve(input);
  let isDir: boolean;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    throw new Error(`Not found: ${path}`);
  }
  const engine = engines.find((candidate) => candidate.accepts(path, isDir));
  if (!engine) {
    throw new Error(
      `openmode does not know how to render ${path}. It renders: ${engines
        .map((candidate) => candidate.summary)
        .join("; ")}.`,
    );
  }
  return engine.render(path, options);
}
