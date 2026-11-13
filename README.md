# openmode

**Video editing and rendering for coding agents.** openmode is an open-source command line tool and MCP server that lets Claude Code, Codex, Cursor and other agents edit video the way they edit code: look at the footage, write a small edit file, render it, look at the result, and keep every version.

It runs on your own machine with your own ffmpeg. No account, no upload, no API key, no cost.

```bash
claude mcp add openmode -- npx -y openmode mcp
```

Then ask: *"Cut the silences out of interview.mp4, add captions, and make a vertical version."*

## What it gives an agent

| | What it does | Why an agent needs it |
|---|---|---|
| **look** | Turns a video, image or folder of frames into one contact sheet with timestamps, plus facts: length, size, loudness, silent stretches, black frames, missing frames. | Agents cannot watch video. One image and a few numbers let them check footage and their own renders. |
| **render** | Turns an edit file (clips, trims, speed, fades, captions, music) or a folder of numbered frames into an MP4. Draft in about a second, final at up to 4K. | No hand-written ffmpeg filter graphs, no wasted tokens, errors that name the exact field to fix. |
| **versions** | Saves the whole film folder with a message and the prompt behind it. List, compare, restore. | An undo for video. Restoring never loses work: unsaved changes are saved first and the restore is itself a new version. |

## Install

openmode needs [Node.js](https://nodejs.org) 20 or newer and [ffmpeg](https://ffmpeg.org) on your PATH (`brew install ffmpeg`, `sudo apt-get install ffmpeg`, or `winget install ffmpeg`).

**Claude Code**

```bash
claude mcp add openmode -- npx -y openmode mcp
```

Or install it as a plugin, which also adds a video-editing skill so Claude reaches for openmode on its own:

```
/plugin marketplace add shansabnani/openmode
/plugin install openmode@openmode
```

**Codex**

```bash
codex mcp add openmode -- npx -y openmode mcp
```

**Cursor, Windsurf, Claude Desktop and other MCP clients**

```json
{
  "mcpServers": {
    "openmode": { "command": "npx", "args": ["-y", "openmode", "mcp"] }
  }
}
```

**Any agent that can run commands** (no MCP needed)

```bash
npx -y openmode init     # adds a short openmode section to AGENTS.md in this folder
```

## The loop

```bash
npx -y openmode look interview.mp4             # see it: sheet + facts
npx -y openmode schema                         # the edit file format
npx -y openmode render cut.json --draft        # 360p in about a second
npx -y openmode look renders/cut-draft.mp4     # check the draft
npx -y openmode render cut.json --final        # full quality
npx -y openmode save -m "first cut" --prompt "cut the silences, add captions"
```

Every command takes `--json`.

## The edit file

An edit is a JSON file next to your footage. Paths are relative to the file; times are in seconds.

```json
{
  "version": 1,
  "format": "9:16",
  "fit": "cover",
  "clips": [
    { "src": "footage/intro.mp4", "start": 1.2, "end": 4, "caption": "I rebuilt our onboarding in a weekend." },
    { "src": "footage/demo.mp4", "start": 10, "end": 16.5, "speed": 1.25, "transition": "fade" },
    { "src": "stills/logo.png", "duration": 2 }
  ],
  "audio": [{ "src": "music/bed.mp3", "volume": 0.25, "fadeIn": 0.5, "fadeOut": 1.5 }],
  "captions": [{ "start": 4, "end": 7, "text": "Here is the whole flow." }],
  "endCard": "openmode.ai",
  "loudness": -14
}
```

| Field | Meaning |
|---|---|
| `format` | `16:9`, `9:16`, `1:1` or `4:5`. Default `16:9`. |
| `resolution` | Size of a final render: `720p`, `1080p`, `1440p` or `4k`. Default `1080p`. Drafts are always 360p. |
| `fps` | 12 to 60. Default 30. |
| `fit` | `contain` (whole picture, with bars) or `cover` (fill the frame, crop). Per clip or for the whole edit. |
| `clips[]` | Played in order. `src` is a video or image, a local path or an https URL. `start`/`end` (or `duration`) choose the part to use. `speed` 0.5 to 4 keeps pitch. `volume`, `mute`. `transition: "fade"` crossfades into the next clip. `caption` shows for the whole clip. Images need `duration`. |
| `audio[]` | Music, voiceover, effects, mixed with the clips' own sound. `at` (where it starts in the film), `start`, `duration`, `volume`, `fadeIn`, `fadeOut`. |
| `captions[]` | Timed text. Long lines wrap. `style: "title"` is large and centred. |
| `endCard` | One line over the last two seconds. |
| `loudness` | Target loudness in LUFS (for example `-14` for the web). The result is close to the target, not exact. |

Unknown fields are rejected with their exact path (`clips[2].sped`), so a typo never renders silently wrong.

### Recipes

- **Remove silences or mistakes.** `look` at the footage and read `silences`. List one clip per stretch you keep: same `src`, different `start`/`end`.
- **Vertical cut of landscape footage.** `"format": "9:16", "fit": "cover"`.
- **Captions.** Put a `caption` on each clip, or timed entries in `captions`.
- **Slideshow.** Image clips with a `duration` and `"transition": "fade"`.
- **Frames from Blender or a browser capture.** `openmode render frames/ --fps 24 --audio music.wav --loudness -14`. Missing frame numbers are reported before anything is encoded.

## MCP tools

| Tool | Use |
|---|---|
| `look` | See a video, image or frames folder: contact sheet image + facts. |
| `render_edit` | Render an edit file or inline edit to MP4. `validateOnly` checks without rendering. |
| `render_frames` | Join numbered frames and a soundtrack into an MP4. |
| `versions` | `save`, `list`, `restore`, `diff`. |
| `edit_schema` | The edit format with an example. |
| `status` | Check ffmpeg and which features work on this machine. |

Six tools, under 6 KB of tool descriptions.

## Versions

```bash
openmode save -m "tighter intro" --prompt "make the intro punchier"
openmode versions
openmode diff v2 v3          # which files changed, with a line diff for text files
openmode restore v2          # recorded as a new version; unsaved work is saved first
```

Versions live in `.openmode/` inside the film folder. Files are stored by content hash, so footage that does not change is stored once however many versions you save. On APFS, Btrfs and XFS the copies are copy-on-write and take no extra space. List folders to skip in `.openmodeignore`.

## Use it as a library

```ts
import { look, render, saveVersion } from "openmode";

const draft = await render("cut.json", { quality: "draft" });
const { image, ...facts } = await look({ path: draft.path });
await saveVersion({ message: "first cut" });
```

## How it is built

```
src/
  core/       ffmpeg detection, probing, encoder choice, safe media fetching
  look/       contact sheets and footage analysis
  engines/    one folder per thing openmode can render
    edit/       edit file → MP4
    frames/     numbered frames → MP4
  versions/   content-addressed snapshots, restore, diff
  cli.ts      command line
  mcp.ts      MCP server
```

An engine is one folder with a `render` function, listed in `src/engines/index.ts`. That is the main way openmode grows.

## Roadmap

- **Blender engine**: render a `.blend` or a Python scene script, draft-size first, then full quality.
- **HTML engine**: render [HyperFrames](https://github.com/heygen-com/hyperframes) compositions.
- **Runners**: send the same job to your own GPUs (Runpod, Vast, Modal) with a quote first, and get an MP4 back.
- **Edit operations**: transcripts and captions from speech, colour match, masks.
- **Kits**: shareable Blender scenes, characters and worlds, installed with one command.

Want one of these sooner? Open an issue, or build it: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. openmode calls the ffmpeg already on your machine and ships no binaries.
