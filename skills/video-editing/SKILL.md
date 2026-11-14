---
name: video-editing
description: Edit and render video with openmode, a local ffmpeg-based tool. Use whenever the user wants to edit, cut, trim, shorten, join or combine video clips, remove silences or mistakes, add captions, subtitles, titles, music or a voiceover, change speed, make a vertical (9:16) or square version, render a Blender scene (.blend file or bpy Python script) to video, turn images or rendered frames into an MP4, review or check a video, or keep and restore versions of a video project.
---

# Video editing with openmode

openmode lets you edit video the way you edit code: look at it, write a small edit file, render, look again, save a version. It runs locally on the user's ffmpeg. Nothing is uploaded.

If the openmode MCP tools (`look`, `render_edit`, `render_frames`, `render_blender`, `versions`, `edit_schema`, `status`) are available, use them. Otherwise run the same things with `npx -y openmode <command>`; add `--json` for structured output.

## The loop

1. **Look before you edit.** `look` the footage (`npx -y openmode look clip.mp4 --out sheet.jpg`, then read `sheet.jpg`). You get a contact sheet with a timestamp on every tile, plus duration, size, loudness, silent stretches and black stretches. Use `start`/`end` to look closer at a stretch and `at` for one full frame.
2. **Write an edit file** (JSON) next to the footage. Call `edit_schema` (`npx -y openmode schema`) once for the format.
3. **Render a draft**: `render_edit` with quality `draft` (`npx -y openmode render cut.json --draft`). It takes about a second.
4. **Look at the draft.** Check that the cuts land where you meant, captions fit, and nothing is black or silent by accident. Fix the edit file and render again.
5. **Render final** (`--final`) only when the draft is right.
6. **Save a version** after each change the user may want back: `versions` action `save` with a `message` and the user's request as `prompt` (`npx -y openmode save -m "..." --prompt "..."`).

Never tell the user a video is done without having looked at the render.

## Edit file

```json
{
  "version": 1,
  "format": "9:16",
  "fit": "cover",
  "clips": [
    { "src": "footage/a.mp4", "start": 1.2, "end": 4, "caption": "Shown for this clip" },
    { "src": "footage/b.mp4", "start": 10, "end": 16.5, "speed": 1.25, "transition": "fade" },
    { "src": "stills/logo.png", "duration": 2 }
  ],
  "audio": [{ "src": "music.mp3", "volume": 0.25, "fadeIn": 0.5, "fadeOut": 1.5 }],
  "captions": [{ "start": 4, "end": 7, "text": "Timed text" }],
  "endCard": "One line over the last two seconds",
  "loudness": -14
}
```

- Paths are relative to the edit file. Times are seconds.
- `format`: `16:9` (default), `9:16`, `1:1`, `4:5`. `resolution` for finals: `720p`, `1080p` (default), `1440p`, `4k`.
- `fit`: `contain` keeps the whole picture with bars; `cover` fills the frame and crops.
- `transition: "fade"` on a clip crossfades into the next clip. Default is a cut.
- A clip keeps its own sound unless `mute` is true. `audio` tracks are mixed on top.
- Unknown fields are errors that name the exact path. Fix what the error names.

## Common jobs

- **Remove silences or mistakes**: read `silences` from `look`, then list one clip per stretch to keep (same `src`, different `start`/`end`). Leave about 0.15 s of air around speech.
- **Vertical version of landscape footage**: `"format": "9:16", "fit": "cover"`.
- **Captions**: `caption` on each clip, or timed entries in `captions`. Keep each to one or two short lines.
- **Music under speech**: an `audio` track with `volume` around 0.15 to 0.3 and a `fadeOut`.
- **Frames to film** (browser capture, another renderer): `render_frames` with the folder, `fps` and optional `audio` (`npx -y openmode render frames/ --fps 24 --audio music.wav`). Missing frames are reported; render them before trying again.
- **Go back**: `versions` action `list`, then `restore` with the id. Restoring is safe: unsaved work is saved first.

## 3D with Blender

`render_blender` (`npx -y openmode render scene.blend --draft`) renders a `.blend` file, or a `.py` script that builds a scene with `bpy`, using the Blender on this machine.

1. Render a **draft** first. It is 360p, uses at most 16 samples and may skip frames, so it comes back in seconds.
2. **Look** at the draft: is the subject in frame, lit, and moving as intended?
3. Fix the scene or script, draft again, then render **final** (the scene's own size and samples).

Useful options: `range` ("1-48"), `step` (every Nth frame), `renderer` (`cycles`, `eevee`, `workbench`), `samples`, `audio`. A scene needs a camera. On a machine with no GPU use `renderer: "cycles"`. To cut the result together with other footage, use the rendered MP4 as a clip in an edit file.

## If something fails

Call `status` (`npx -y openmode status`). It reports whether ffmpeg is installed, whether Blender is, and whether captions are supported, with the install command if not.
