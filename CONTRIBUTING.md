# Contributing to openmode

openmode grows by small, tested additions. Most contributions are one of these.

## Set up

```bash
git clone https://github.com/shansabnani/openmode.git
cd openmode
npm install
npm test          # needs ffmpeg on your PATH; tests render real video
npm run dev -- look some-video.mp4
```

`npm run typecheck`, `npm test` and `npm run build` must pass before a pull request.

## Add an engine

An engine turns one kind of input into an MP4.

1. Create `src/engines/<name>/index.ts` with a function that takes a request and returns a `RenderResult` (see `src/core/output.ts`). `src/engines/frames/index.ts` is the shortest example.
2. List it in `src/engines/index.ts` with an `accepts` rule, so `openmode render <input>` picks it by file type.
3. Add an MCP tool for it in `src/mcp.ts` with a description that says when to use it.
4. Test it against the real tool it drives. A test that only checks the command line it would have run does not count.

## Add a check to `look`

`look` reports facts an agent can act on (silences, black frames, loudness). A new check belongs in `src/look/index.ts` if an agent would otherwise have to watch the video to know it. Keep the output small: numbers and time spans, not prose.

## Rules of the road

- **Errors are for agents.** Name the field or file and say what would fix it (`clips[2]: asks for 12.0s of a.mp4, which is only 8.2s long`).
- **Nothing leaves the machine.** No telemetry, no hosted calls, no API keys in this package. Paid compute is always the user's own account, with a quote and a confirmation first.
- **Never lose work.** Anything that overwrites or deletes user files saves them first.
- **Keep the tool list small.** Every MCP tool costs tokens in every conversation. Extend an existing tool before adding one.
- **No new dependencies without a reason.** The runtime dependencies are the MCP SDK and zod.
- Licences: MIT-compatible code only. openmode calls ffmpeg and Blender as separate programs and never bundles them.
