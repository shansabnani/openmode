# openmode

[![npm](https://img.shields.io/npm/v/openmode)](https://www.npmjs.com/package/openmode)
[![CI](https://github.com/shansabnani/openmode/actions/workflows/ci.yml/badge.svg)](https://github.com/shansabnani/openmode/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

**Video editing and rendering for coding agents.** An open-source CLI and MCP server that lets Claude Code, Codex and Cursor look at footage, cut it, caption it and render an MP4. It runs on your machine with your own ffmpeg: no account, no upload, no API key, no cost.

```bash
claude mcp add openmode -- npx -y openmode mcp
```

Then ask: *"Cut the silences out of interview.mp4, add captions, and make a vertical version."*

[![Frames from a 35-second Apollo 11 trailer cut by Claude with openmode](site/img/apollo-draft-look.jpg)](https://openmode.ai)

Claude cut this Apollo 11 trailer from NASA footage with openmode. [Watch the replay](https://openmode.ai) or [render it yourself](examples/apollo-11).

## What an agent can do with it

- **Look.** See a video as one image of timestamped frames, plus its length, loudness, silent stretches and black frames.
- **Render.** Turn a small edit file (clips, trims, speed, fades, captions, music) or a folder of frames into an MP4. Drafts take seconds; finals go up to 4K.
- **Keep versions.** Save, compare and restore the whole project, like undo for video.

Use it when you ask an agent to cut, trim, caption, combine, speed up, add music to, review or render video.

## Install

Needs [Node.js](https://nodejs.org) 20 or newer and [ffmpeg](https://ffmpeg.org).

| Agent | Command |
|---|---|
| Claude Code | `claude mcp add openmode -- npx -y openmode mcp` |
| Codex | `codex mcp add openmode -- npx -y openmode mcp` |
| No MCP | `npx -y openmode init` (adds a short section to `AGENTS.md`) |

<details>
<summary>Cursor, Windsurf, Claude Desktop and other MCP clients</summary>

```json
{
  "mcpServers": {
    "openmode": { "command": "npx", "args": ["-y", "openmode", "mcp"] }
  }
}
```

</details>

<details>
<summary>Claude Code plugin, with a video-editing skill</summary>

```
/plugin marketplace add shansabnani/openmode
/plugin install openmode@openmode
```

</details>

## The loop

```bash
npx -y openmode look interview.mp4             # see the footage
npx -y openmode render cut.json --draft        # 360p draft in seconds
npx -y openmode look renders/cut-draft.mp4     # check the draft
npx -y openmode render cut.json --final        # full quality
npx -y openmode save -m "first cut"            # keep this version
```

## The edit file

A small JSON file next to your footage. Times are in seconds.

```json
{
  "version": 1,
  "format": "9:16",
  "fit": "cover",
  "clips": [
    { "src": "footage/intro.mp4", "start": 1.2, "end": 4, "caption": "I rebuilt our onboarding in a weekend.", "transition": "fade" },
    { "src": "footage/demo.mp4", "start": 10, "end": 16.5, "speed": 1.25 }
  ],
  "audio": [{ "src": "music/bed.mp3", "volume": 0.25 }],
  "endCard": "openmode.ai"
}
```

`npx -y openmode schema` prints every field. The [reference](docs/reference.md) has the full table and recipes.

## MCP tools

| Tool | Use |
|---|---|
| `look` | See a video, image or frames folder as one image, with its facts. |
| `render_edit` | Turn an edit file into an MP4, or check it without rendering. |
| `render_frames` | Turn numbered frames and a soundtrack into an MP4. |
| `versions` | Save, list, restore and compare. |
| `edit_schema` | The edit file format, with an example. |
| `status` | Check that ffmpeg is ready. |

## Roadmap

Blender engine, HTML ([HyperFrames](https://github.com/heygen-com/hyperframes)) engine, rendering on your own GPUs, captions from speech, and shareable kits of scenes and characters.

## Contribute

A star helps other people find it. To ask for a feature, [open an issue](https://github.com/shansabnani/openmode/issues). To add one, start with [CONTRIBUTING.md](./CONTRIBUTING.md): an engine is one folder with a `render` function.

## License

MIT. openmode calls the ffmpeg already on your machine and ships no binaries.
