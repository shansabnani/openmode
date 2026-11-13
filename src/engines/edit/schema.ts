import { z } from "zod";
import { even } from "../../core/ffmpeg.js";
import { isUrl, mediaKind } from "../../core/media.js";

/** Version of the edit file agents write. Bump only for breaking changes. */
export const EDIT_VERSION = 1 as const;

export const FORMATS = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
  "4:5": [4, 5],
} as const;
export type Format = keyof typeof FORMATS;

/** Short side of the frame in pixels. */
export const RESOLUTIONS = {
  "360p": 360,
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "4k": 2160,
} as const;
export type Resolution = keyof typeof RESOLUTIONS;

export function frameSize(format: Format, resolution: Resolution) {
  const [w, h] = FORMATS[format];
  const short = RESOLUTIONS[resolution];
  return w >= h
    ? { width: even((short * w) / h), height: even(short) }
    : { width: even(short), height: even((short * h) / w) };
}

const src = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f]/.test(value), "Path contains control characters.")
  .refine(
    (value) => isUrl(value) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value),
    "Use a local path or an https URL.",
  );

const seconds = z.number().nonnegative().max(86_400);

export const clipSchema = z
  .strictObject({
    /** Video or image file: a local path (relative to the edit file) or https URL. */
    src,
    /** Where to start in the source, in seconds. Video only. */
    start: seconds.optional(),
    /** Where to stop in the source, in seconds. Video only. */
    end: seconds.optional(),
    /** Seconds on screen. Required for images; for video an alternative to `end`. */
    duration: z.number().positive().max(3600).optional(),
    /** Playback speed, 0.5 to 4. Audio pitch is kept. */
    speed: z.number().min(0.5).max(4).optional(),
    /** Volume of the clip's own sound, 0 to 2. Default 1. */
    volume: z.number().min(0).max(2).optional(),
    /** Drop the clip's own sound. */
    mute: z.boolean().optional(),
    /** contain = whole picture with bars; cover = fill the frame and crop. */
    fit: z.enum(["contain", "cover"]).optional(),
    /** How this clip hands over to the NEXT clip. Default cut. */
    transition: z.enum(["cut", "fade"]).optional(),
    /** Length of the fade in seconds. Default 0.5. */
    transitionDuration: z.number().positive().max(5).optional(),
    /** Caption shown for the whole clip. */
    caption: z.string().max(500).optional(),
  })
  .superRefine((clip, ctx) => {
    const kind = mediaKind(clip.src);
    if (kind !== "video" && kind !== "image") {
      ctx.addIssue({
        code: "custom",
        path: ["src"],
        message:
          "Clips must be video (.mp4 .mov .webm .mkv .m4v) or image (.png .jpg .jpeg .webp .bmp .tif) files.",
      });
      return;
    }
    if (kind === "image") {
      if (!clip.duration) {
        ctx.addIssue({
          code: "custom",
          path: ["duration"],
          message: "Image clips need a duration in seconds.",
        });
      }
      for (const key of ["start", "end", "speed", "volume"] as const) {
        if (clip[key] !== undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: `${key} only applies to video clips.` });
        }
      }
    }
    if (clip.end !== undefined && clip.end <= (clip.start ?? 0)) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "end must be after start." });
    }
    if (clip.end !== undefined && clip.duration !== undefined && kind === "video") {
      ctx.addIssue({
        code: "custom",
        path: ["duration"],
        message: "Give either end or duration for a video clip, not both.",
      });
    }
  });

export const audioTrackSchema = z
  .strictObject({
    /** Music, voiceover or effect: a local path or https URL. */
    src,
    /** Second on the film's timeline where the track starts. Default 0. */
    at: seconds.optional(),
    /** Where to start inside the audio file, in seconds. Default 0. */
    start: seconds.optional(),
    /** Seconds to play. Default: to the end of the file or film. */
    duration: z.number().positive().max(86_400).optional(),
    /** 0 to 2. Default 1. */
    volume: z.number().min(0).max(2).optional(),
    fadeIn: z.number().nonnegative().max(30).optional(),
    fadeOut: z.number().nonnegative().max(30).optional(),
  })
  .superRefine((track, ctx) => {
    const kind = mediaKind(track.src);
    if (kind !== "audio" && kind !== "video") {
      ctx.addIssue({
        code: "custom",
        path: ["src"],
        message: "Audio tracks must be .wav .mp3 .m4a .aac .ogg .flac (or a video file with sound).",
      });
    }
  });

export const captionSchema = z
  .strictObject({
    start: seconds,
    end: seconds,
    text: z.string().min(1).max(500),
    /** caption = bottom of the frame; title = large, centred. */
    style: z.enum(["caption", "title"]).optional(),
  })
  .refine((caption) => caption.end > caption.start, {
    path: ["end"],
    message: "end must be after start.",
  });

export const editSchema = z.strictObject({
  version: z.literal(EDIT_VERSION),
  /** Shape of the frame. Choose it when you plan the film. Default 16:9. */
  format: z.enum(Object.keys(FORMATS) as [Format, ...Format[]]).optional(),
  /** Size of a final render. Default 1080p. Drafts are always 360p. */
  resolution: z.enum(Object.keys(RESOLUTIONS) as [Resolution, ...Resolution[]]).optional(),
  fps: z.number().int().min(12).max(60).optional(),
  /** Default fit for every clip. Default contain. */
  fit: z.enum(["contain", "cover"]).optional(),
  /** Colour behind clips that do not fill the frame, as #rrggbb. Default black. */
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour.")
    .optional(),
  /** Clips in the order they play. */
  clips: z.array(clipSchema).min(1).max(400),
  /** Music, voiceover and effects, mixed with the clips' own sound. */
  audio: z.array(audioTrackSchema).max(16).optional(),
  /** Timed text. A clip's own `caption` is added to these. */
  captions: z.array(captionSchema).max(2000).optional(),
  /** One line shown large over the last two seconds. */
  endCard: z.string().max(200).optional(),
  /** Target loudness in LUFS, for example -14 for the web. */
  loudness: z.number().min(-40).max(-5).optional(),
});

export type Clip = z.infer<typeof clipSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type Caption = z.infer<typeof captionSchema>;
export type Edit = z.infer<typeof editSchema>;

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length
        ? issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("").replace(/^\./, "")
        : "edit";
      return `${where}: ${issue.message}`;
    })
    .join("\n");
}

export function parseEdit(raw: unknown): Edit {
  const result = editSchema.safeParse(raw);
  if (!result.success) throw new EditError(formatIssues(result.error));
  return result.data;
}

export const EXAMPLE_EDIT: Edit = {
  version: 1,
  format: "9:16",
  fps: 30,
  fit: "cover",
  clips: [
    { src: "footage/intro.mp4", start: 1.2, end: 4, caption: "I rebuilt our onboarding in a weekend." },
    { src: "footage/demo.mp4", start: 10, end: 16.5, speed: 1.25, transition: "fade" },
    { src: "stills/logo.png", duration: 2 },
  ],
  audio: [{ src: "music/bed.mp3", volume: 0.25, fadeIn: 0.5, fadeOut: 1.5 }],
  captions: [{ start: 4, end: 7, text: "Here is the whole flow." }],
  endCard: "openmode.ai",
  loudness: -14,
};
