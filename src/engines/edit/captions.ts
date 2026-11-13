import { writeFileSync } from "node:fs";
import type { Edit } from "./schema.js";
import type { Timeline } from "./plan.js";

export type TimedCaption = {
  start: number;
  end: number;
  text: string;
  style: "caption" | "title";
};

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

function escapeAss(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

/** Clip captions, timed captions and the end card as one sorted list. */
export function collectCaptions(edit: Edit, timeline: Timeline): TimedCaption[] {
  const all: TimedCaption[] = [];
  for (const clip of timeline.clips) {
    if (clip.caption) {
      all.push({
        start: clip.at,
        end: clip.at + clip.duration - clip.fadeOut,
        text: clip.caption,
        style: "caption",
      });
    }
  }
  for (const caption of edit.captions ?? []) {
    const text = caption.text.trim();
    if (!text || caption.start >= timeline.duration) continue;
    all.push({
      start: caption.start,
      end: Math.min(caption.end, timeline.duration),
      text,
      style: caption.style ?? "caption",
    });
  }
  const endCard = edit.endCard?.trim();
  if (endCard) {
    const hold = Math.min(2, timeline.duration);
    all.push({
      start: timeline.duration - hold,
      end: timeline.duration,
      text: endCard,
      style: "title",
    });
  }
  return all.filter((caption) => caption.end > caption.start).sort((a, b) => a.start - b.start);
}

/**
 * Write captions as an ASS subtitle file sized for the frame. WrapStyle 0
 * wraps long lines evenly, so text never runs off a narrow 9:16 frame.
 */
export function writeAssFile(
  captions: TimedCaption[],
  size: { width: number; height: number },
  path: string,
): void {
  const short = Math.min(size.width, size.height);
  const captionSize = Math.max(14, Math.round(short * 0.052));
  const titleSize = Math.max(18, Math.round(short * 0.085));
  const side = Math.round(size.width * 0.07);
  const bottom = Math.round(size.height * 0.08);
  const outline = Math.max(1, Math.round(short * 0.004));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${size.width}
PlayResY: ${size.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${captionSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${outline},${outline},2,${side},${side},${bottom},1
Style: Title,Arial,${titleSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${outline + 1},${outline},5,${side},${side},${bottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = captions
    .map(
      (caption) =>
        `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},${caption.style === "title" ? "Title" : "Caption"},,0,0,0,,${escapeAss(caption.text)}`,
    )
    .join("\n");
  writeFileSync(path, `${header}${events}\n`, "utf8");
}
