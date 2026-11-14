import { blenderVersion, detectBlender } from "../engines/blender/index.js";
import { detectFfmpeg, detectFfprobe, ffmpegFilters, ffmpegVersion, pickEncoder } from "./ffmpeg.js";

export type Status = {
  ready: boolean;
  ffmpeg?: { path: string; version: string; encoder: string; captions: boolean };
  /** Only needed to render .blend files and Blender scene scripts. */
  blender?: { path: string; version: string };
  problems: string[];
};

/** What this machine can do, and how to fix what it cannot. */
export async function status(): Promise<Status> {
  const problems: string[] = [];
  let ffmpeg: Status["ffmpeg"];
  try {
    const path = detectFfmpeg();
    detectFfprobe(path);
    const filters = await ffmpegFilters(path);
    ffmpeg = {
      path,
      version: await ffmpegVersion(path),
      encoder: await pickEncoder(path),
      captions: filters.has("ass"),
    };
    if (!ffmpeg.captions) {
      problems.push("This ffmpeg cannot draw captions (no libass). Install a full ffmpeg build to use captions.");
    }
  } catch (error) {
    problems.push((error as Error).message);
  }
  let blender: Status["blender"];
  try {
    const path = detectBlender();
    blender = { path, version: await blenderVersion(path) };
  } catch {
    // Blender is optional: everything except the Blender engine works without it.
  }
  return { ready: Boolean(ffmpeg), ffmpeg, blender, problems };
}
