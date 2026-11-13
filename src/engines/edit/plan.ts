import { filterPath, type ProbeInfo, type Quality } from "../../core/ffmpeg.js";
import { mediaKind } from "../../core/media.js";
import { EditError, frameSize, type Clip, type Edit } from "./schema.js";

const AUDIO_FORMAT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

/** One clip placed on the timeline, with every time resolved to seconds. */
export type PlacedClip = {
  index: number;
  kind: "video" | "image";
  path: string;
  /** Start and length read from the source. */
  sourceStart: number;
  sourceDuration: number;
  speed: number;
  /** Seconds on screen. */
  duration: number;
  /** Second on the film's timeline where the clip begins. */
  at: number;
  /** Overlap with the next clip (0 for a cut). */
  fadeOut: number;
  hasAudio: boolean;
  volume: number;
  fit: "contain" | "cover";
  caption?: string;
};

export type Timeline = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  clips: PlacedClip[];
};

const label = (index: number) => `clips[${index}]`;

/** Resolve trims, speeds and fades into exact timeline positions. */
export function placeClips(
  edit: Edit,
  probes: ReadonlyMap<string, ProbeInfo>,
  quality: Quality,
): Timeline {
  const fps = edit.fps ?? 30;
  const { width, height } = frameSize(
    edit.format ?? "16:9",
    quality === "draft" ? "360p" : (edit.resolution ?? "1080p"),
  );
  const placed: PlacedClip[] = [];
  edit.clips.forEach((clip: Clip, index) => {
    const probe = probes.get(clip.src);
    if (!probe) throw new EditError(`${label(index)}: ${clip.src} was not probed.`);
    const kind = mediaKind(clip.src) === "image" ? "image" : "video";
    const speed = clip.speed ?? 1;
    let sourceStart = 0;
    let sourceDuration: number;
    if (kind === "image") {
      sourceDuration = clip.duration!;
    } else {
      if (probe.kind !== "video" || !probe.duration) {
        throw new EditError(`${label(index)}: ${clip.src} has no video stream.`);
      }
      sourceStart = clip.start ?? 0;
      const sourceEnd =
        clip.end ?? (clip.duration !== undefined ? sourceStart + clip.duration * speed : probe.duration);
      if (sourceStart >= probe.duration) {
        throw new EditError(
          `${label(index)}: start ${sourceStart}s is past the end of ${clip.src} (${probe.duration.toFixed(2)}s long).`,
        );
      }
      if (sourceEnd > probe.duration + 0.05) {
        throw new EditError(
          `${label(index)}: asks for ${sourceEnd.toFixed(2)}s of ${clip.src}, which is only ${probe.duration.toFixed(2)}s long.`,
        );
      }
      sourceDuration = Math.min(sourceEnd, probe.duration) - sourceStart;
    }
    const duration = kind === "image" ? sourceDuration : sourceDuration / speed;
    if (duration < 1 / fps) {
      throw new EditError(`${label(index)}: clip is shorter than one frame.`);
    }
    placed.push({
      index,
      kind,
      path: probe.path,
      sourceStart,
      sourceDuration,
      speed,
      duration,
      at: 0,
      fadeOut: 0,
      hasAudio: kind === "video" && probe.hasAudio && !clip.mute && (clip.volume ?? 1) > 0,
      volume: clip.volume ?? 1,
      fit: clip.fit ?? edit.fit ?? "contain",
      caption: clip.caption?.trim() || undefined,
    });
  });

  let at = 0;
  placed.forEach((clip, index) => {
    clip.at = at;
    const source = edit.clips[index]!;
    const next = placed[index + 1];
    if (next && source.transition === "fade") {
      const wanted = source.transitionDuration ?? 0.5;
      clip.fadeOut = Math.max(0, Math.min(wanted, clip.duration * 0.45, next.duration * 0.45));
    }
    at += clip.duration - clip.fadeOut;
  });
  return { width, height, fps, duration: at, clips: placed };
}

function fitFilter(clip: PlacedClip, width: number, height: number, background: string): string {
  if (clip.fit === "cover") {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${background}`;
}

const f = (n: number) => n.toFixed(4);

export type FfmpegPlan = {
  inputs: string[];
  filterComplex: string;
  maps: string[];
  hasAudio: boolean;
  duration: number;
};

export type PlacedTrack = {
  path: string;
  at: number;
  start: number;
  duration: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
};

/** Resolve audio tracks against the film length and their own length. */
export function placeTracks(
  edit: Edit,
  probes: ReadonlyMap<string, ProbeInfo>,
  filmDuration: number,
): PlacedTrack[] {
  return (edit.audio ?? []).flatMap((track, index) => {
    const probe = probes.get(track.src);
    if (!probe?.hasAudio || !probe.duration) {
      throw new EditError(`audio[${index}]: ${track.src} has no sound.`);
    }
    const at = track.at ?? 0;
    const start = track.start ?? 0;
    if (start >= probe.duration) {
      throw new EditError(
        `audio[${index}]: start ${start}s is past the end of ${track.src} (${probe.duration.toFixed(2)}s long).`,
      );
    }
    if (at >= filmDuration) return [];
    const duration = Math.min(
      track.duration ?? Number.POSITIVE_INFINITY,
      probe.duration - start,
      filmDuration - at,
    );
    return [
      {
        path: probe.path,
        at,
        start,
        duration,
        volume: track.volume ?? 1,
        fadeIn: Math.min(track.fadeIn ?? 0, duration / 2),
        fadeOut: Math.min(track.fadeOut ?? 0, duration / 2),
      },
    ];
  });
}

/**
 * Build one ffmpeg invocation for the whole edit. Every clip is its own input
 * with an input-side seek, so a long source is never decoded from the start.
 */
export function planFfmpeg(
  edit: Edit,
  timeline: Timeline,
  tracks: PlacedTrack[],
  options: { assPath?: string },
): FfmpegPlan {
  const { width, height, fps, clips } = timeline;
  const background = `0x${(edit.background ?? "#000000").slice(1)}`;
  const withAudio = clips.some((clip) => clip.hasAudio) || tracks.length > 0;
  const inputs: string[] = [];
  const filters: string[] = [];

  clips.forEach((clip, i) => {
    if (clip.kind === "image") {
      inputs.push("-loop", "1", "-framerate", String(fps), "-t", f(clip.duration + 1), "-i", clip.path);
    } else {
      inputs.push("-ss", f(clip.sourceStart), "-t", f(clip.sourceDuration + 0.5), "-i", clip.path);
    }
    const video = [
      clip.kind === "video" && clip.speed !== 1
        ? `setpts=(PTS-STARTPTS)/${clip.speed}`
        : "setpts=PTS-STARTPTS",
      fitFilter(clip, width, height, background),
      "setsar=1",
      `fps=${fps}`,
      "format=yuv420p",
      // Hold the last frame if the source runs a few frames short, then cut
      // to the exact length so later clips never drift.
      "tpad=stop_mode=clone:stop_duration=1",
      `trim=duration=${f(clip.duration)}`,
      "setpts=PTS-STARTPTS",
      `settb=1/${fps}`,
    ];
    filters.push(`[${i}:v]${video.join(",")}[v${i}]`);
    if (!withAudio) return;
    if (clip.hasAudio) {
      const audio = [
        `atrim=duration=${f(clip.sourceDuration)}`,
        "asetpts=PTS-STARTPTS",
        ...(clip.speed !== 1 ? [`atempo=${clip.speed}`] : []),
        ...(clip.volume !== 1 ? [`volume=${clip.volume}`] : []),
        AUDIO_FORMAT,
        "apad",
        `atrim=duration=${f(clip.duration)}`,
        "asetpts=PTS-STARTPTS",
      ];
      filters.push(`[${i}:a]${audio.join(",")}[a${i}]`);
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp,atrim=duration=${f(clip.duration)}[a${i}]`,
      );
    }
  });

  // Clips joined by cuts form a run and are concatenated in one filter.
  // Runs are then joined to each other with crossfades.
  const runs: PlacedClip[][] = [];
  let run: PlacedClip[] = [];
  for (const clip of clips) {
    run.push(clip);
    if (clip.fadeOut > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  const runLabels = runs.map((members, r) => {
    const duration = members.reduce((sum, clip) => sum + clip.duration, 0);
    if (members.length === 1) {
      const only = members[0]!.index;
      return { v: `v${only}`, a: `a${only}`, duration };
    }
    const pads = members
      .map((clip) => (withAudio ? `[v${clip.index}][a${clip.index}]` : `[v${clip.index}]`))
      .join("");
    const out = withAudio ? `[rvr${r}][ra${r}]` : `[rvr${r}]`;
    filters.push(`${pads}concat=n=${members.length}:v=1:a=${withAudio ? 1 : 0}${out}`);
    filters.push(`[rvr${r}]fps=${fps},format=yuv420p,setsar=1,settb=1/${fps}[rv${r}]`);
    return { v: `rv${r}`, a: `ra${r}`, duration };
  });

  let current = runLabels[0]!;
  for (let r = 1; r < runLabels.length; r += 1) {
    const next = runLabels[r]!;
    const lastOfPrev = runs[r - 1]!.at(-1)!;
    const overlap = lastOfPrev.fadeOut;
    const offset = Math.max(0, current.duration - overlap);
    filters.push(
      `[${current.v}][${next.v}]xfade=transition=fade:duration=${f(overlap)}:offset=${f(offset)},fps=${fps},format=yuv420p,settb=1/${fps}[xv${r}]`,
    );
    if (withAudio) {
      filters.push(`[${current.a}][${next.a}]acrossfade=d=${f(overlap)}:c1=tri:c2=tri[xa${r}]`);
    }
    current = { v: `xv${r}`, a: `xa${r}`, duration: current.duration + next.duration - overlap };
  }

  let videoOut = current.v;
  if (options.assPath) {
    filters.push(`[${videoOut}]ass='${filterPath(options.assPath)}'[vcap]`);
    videoOut = "vcap";
  }

  let audioOut: string | null = null;
  if (withAudio) {
    audioOut = current.a;
    tracks.forEach((track, t) => {
      const input = clips.length + t;
      inputs.push("-ss", f(track.start), "-t", f(track.duration + 0.5), "-i", track.path);
      const chain = [
        `atrim=duration=${f(track.duration)}`,
        "asetpts=PTS-STARTPTS",
        ...(track.volume !== 1 ? [`volume=${track.volume}`] : []),
        ...(track.fadeIn > 0 ? [`afade=t=in:st=0:d=${f(track.fadeIn)}`] : []),
        ...(track.fadeOut > 0
          ? [`afade=t=out:st=${f(track.duration - track.fadeOut)}:d=${f(track.fadeOut)}`]
          : []),
        AUDIO_FORMAT,
        ...(track.at > 0 ? [`adelay=${Math.round(track.at * 1000)}:all=1`] : []),
      ];
      filters.push(`[${input}:a]${chain.join(",")}[m${t}]`);
    });
    if (tracks.length) {
      const pads = `[${audioOut}]${tracks.map((_, t) => `[m${t}]`).join("")}`;
      filters.push(
        `${pads}amix=inputs=${tracks.length + 1}:duration=first:dropout_transition=0:normalize=0[amixed]`,
      );
      audioOut = "amixed";
    }
    const finish = [
      ...(edit.loudness !== undefined ? [`loudnorm=I=${edit.loudness}:TP=-1.5:LRA=11`] : []),
      "alimiter=limit=0.97",
      "aresample=48000",
    ];
    filters.push(`[${audioOut}]${finish.join(",")}[aout]`);
    audioOut = "aout";
  }

  return {
    inputs,
    filterComplex: filters.join(";"),
    maps: ["-map", `[${videoOut}]`, ...(audioOut ? ["-map", `[${audioOut}]`] : [])],
    hasAudio: Boolean(audioOut),
    duration: timeline.duration,
  };
}
