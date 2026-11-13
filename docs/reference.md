# openmode reference

Everything the [README](../README.md) leaves out: every field of the edit file, recipes, how versions are stored, the library API and the source layout. `openmode schema` prints the edit format too.

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
