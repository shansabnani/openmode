import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { status } from "./core/status.js";
import { EXAMPLE_EDIT, renderEdit, validateEdit } from "./engines/edit/index.js";
import { renderFrames } from "./engines/frames/index.js";
import { look } from "./look/index.js";
import { diffVersions, listVersions, restoreVersion, saveVersion } from "./versions/index.js";

export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const INSTRUCTIONS = `openmode gives you eyes, a render button and an undo for video work. Everything runs on this machine with the user's own ffmpeg: no account, no upload, no cost.

Use it whenever the user wants to edit, cut, trim, caption, combine, speed up, add music to, review or render video.

The loop:
1. look at the footage (and at every render you make) instead of guessing. One call returns a contact sheet with timestamps plus length, loudness, silent stretches and black frames.
2. Write an edit file (JSON, see the edit_schema tool) next to the footage and call render_edit with quality "draft" (360p, about a second).
3. look at the draft. Fix the edit file. Repeat until it is right.
4. render_edit with quality "final".
5. versions save after each change the user might want back, with the user's prompt in "prompt".

Folders of numbered frames (from Blender, a browser capture, any renderer) become an MP4 with render_frames.

Paths are relative to the working directory the server was started in unless absolute.`;

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 1) }],
});

async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

const quality = z
  .enum(["draft", "final"])
  .describe("draft = fast and small, to check your work; final = full quality.");

export function createServer(): McpServer {
  const server = new McpServer({ name: "openmode", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "look",
    {
      title: "Look at a video",
      description:
        "See a video, an image or a folder of frames. Returns one contact sheet (evenly spaced frames, each labelled with its timestamp) and facts: duration, size, fps, loudness in LUFS, silent stretches, black stretches, missing frames. Use it before editing footage and after every render to check your own work. Pass `at` for one full-size frame, or `start`/`end` to look closer at a stretch.",
      inputSchema: {
        path: z.string().describe("Video file, image file, or folder of numbered frames."),
        frames: z.number().int().min(1).max(30).optional().describe("Tiles on the sheet. Default 12."),
        start: z.number().nonnegative().optional().describe("Look from this second."),
        end: z.number().positive().optional().describe("Look up to this second."),
        at: z.number().nonnegative().optional().describe("Return one full frame at this second."),
        out: z.string().optional().describe("Also save the sheet here (.jpg)."),
        quick: z.boolean().optional().describe("Skip sound and black-frame analysis."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(async () => {
        const { image, ...facts } = await look(args);
        return {
          content: [
            { type: "text", text: JSON.stringify(facts, null, 1) },
            { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
          ],
        };
      }),
  );

  server.registerTool(
    "render_edit",
    {
      title: "Render an edit to MP4",
      description:
        "Render an edit file to an MP4 with the local ffmpeg. An edit lists clips in order (video or image, with trims, speed, volume, cut or fade), audio tracks (music, voiceover), timed captions, an end card and a target loudness. Call edit_schema once to see the format. Render with quality draft first, look at it, then final. Returns the MP4 path, duration, size and render time.",
      inputSchema: {
        file: z
          .string()
          .optional()
          .describe("Path to the edit JSON file. Clip paths inside are relative to this file. Preferred."),
        edit: z.unknown().optional().describe("Or the edit object itself, instead of a file."),
        baseDir: z
          .string()
          .optional()
          .describe("With `edit`: the folder clip paths are relative to. Default: the working directory."),
        quality: quality.optional(),
        out: z.string().optional().describe("Output .mp4 path. Default: renders/<name>-<quality>.mp4 next to the edit file."),
        validateOnly: z.boolean().optional().describe("Check the edit and report the timeline without rendering."),
      },
    },
    ({ file, edit, baseDir, quality: q, out, validateOnly }) =>
      guard(async () =>
        json(
          validateOnly
            ? await validateEdit({ file, edit, baseDir, quality: q })
            : await renderEdit({ file, edit, baseDir, quality: q ?? "draft", out }),
        ),
      ),
  );

  server.registerTool(
    "render_frames",
    {
      title: "Render frames to MP4",
      description:
        "Join a folder of numbered image frames (frame_0001.png ...) into an MP4, with an optional soundtrack. Use it for the output of Blender, a headless-browser capture, or any renderer that writes frames. Reports missing frame numbers instead of producing a broken film.",
      inputSchema: {
        dir: z.string().describe("Folder of numbered frames."),
        fps: z.number().min(1).max(120).optional().describe("Frames per second. Default 24."),
        audio: z.string().optional().describe("Soundtrack file to lay under the frames."),
        loudness: z.number().min(-40).max(-5).optional().describe("Target loudness in LUFS, e.g. -14."),
        quality: quality.optional(),
        out: z.string().optional().describe("Output .mp4 path."),
      },
    },
    (args) => guard(async () => json(await renderFrames(args))),
  );

  server.registerTool(
    "versions",
    {
      title: "Save, list, restore and compare versions",
      description:
        "Version history for the film folder (the working directory, or `dir`). save records every file with a message and the prompt that led to it; unchanged footage is stored once. list shows the history. restore puts the folder back to a version: unsaved work is saved first and the restore becomes a new version, so nothing is ever lost. diff shows which files changed between two versions (or a version and now), with a line diff for text files such as the edit.",
      inputSchema: {
        action: z.enum(["save", "list", "restore", "diff"]),
        dir: z.string().optional().describe("Film folder. Default: the working directory."),
        message: z.string().max(500).optional().describe("save: what changed, in one line."),
        prompt: z.string().max(8000).optional().describe("save: the user's request that led to this version."),
        model: z.string().max(120).optional().describe("save: the model that made it."),
        id: z.string().optional().describe("restore: the version to go back to, e.g. v3."),
        from: z.string().optional().describe("diff: older version, e.g. v2."),
        to: z.string().optional().describe('diff: newer version, or "current" (default).'),
      },
    },
    ({ action, dir, message, prompt, model, id, from, to }) =>
      guard(async () => {
        if (action === "save") return json(await saveVersion({ dir, message, prompt, model }));
        if (action === "list") return json({ versions: listVersions(dir) });
        if (action === "restore") {
          if (!id) throw new Error("restore needs an id, e.g. v3.");
          return json(await restoreVersion({ dir, id }));
        }
        if (!from) throw new Error("diff needs from, e.g. v2.");
        return json(await diffVersions({ dir, from, to }));
      }),
  );

  server.registerTool(
    "edit_schema",
    {
      title: "Edit file format",
      description:
        "The format of the edit file render_edit reads, with an example. Call once before writing your first edit.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(async () => ({
        content: [{ type: "text", text: EDIT_GUIDE }],
      })),
  );

  server.registerTool(
    "status",
    {
      title: "Check this machine",
      description:
        "Check that ffmpeg is installed and which features work here (hardware encoder, captions). Call it if a render fails for a reason that is not the edit.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => json({ version: VERSION, cwd: resolve("."), ...(await status()) })),
  );

  return server;
}

export const EDIT_GUIDE = `An edit is a JSON file. Paths are relative to the file. Times are seconds.

{
  "version": 1,                    // required
  "format": "16:9",                // "16:9" | "9:16" | "1:1" | "4:5". Default 16:9
  "resolution": "1080p",           // final size: 720p | 1080p | 1440p | 4k. Drafts are always 360p
  "fps": 30,                       // 12-60. Default 30
  "fit": "contain",                // default for clips. contain = bars, cover = fill and crop
  "background": "#000000",         // colour behind contained clips
  "clips": [                       // play in this order
    {
      "src": "footage/a.mp4",      // video or image; local path or https URL
      "start": 1.2, "end": 4.0,    // part of the source to use (video). Or "duration"
      "speed": 1.25,               // 0.5-4, pitch kept
      "volume": 1, "mute": false,  // the clip's own sound
      "fit": "cover",              // overrides the default
      "transition": "fade",        // into the NEXT clip. Default "cut"
      "transitionDuration": 0.5,
      "caption": "Shown for the whole clip"
    },
    { "src": "stills/logo.png", "duration": 2 }   // images need a duration
  ],
  "audio": [                       // mixed with the clips' own sound
    { "src": "music.mp3", "at": 0, "start": 0, "duration": 30, "volume": 0.25, "fadeIn": 0.5, "fadeOut": 1.5 }
  ],
  "captions": [                    // timed text; long lines wrap
    { "start": 4, "end": 7, "text": "Bottom caption" },
    { "start": 7, "end": 9, "text": "Big centred title", "style": "title" }
  ],
  "endCard": "One line over the last two seconds",
  "loudness": -14                  // target LUFS for the whole mix
}

Recipes:
- Remove silences or mistakes: look at the footage, read "silences", then list one clip per stretch you keep (same src, different start/end).
- Vertical cut of landscape footage: "format": "9:16", "fit": "cover".
- Slideshow: image clips with durations, "transition": "fade".
- Unknown keys are rejected with the exact path, so fix what the error names.

Example:
${JSON.stringify(EXAMPLE_EDIT, null, 2)}`;

export async function runStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
