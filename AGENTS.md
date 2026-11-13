# openmode: notes for agents working on this repo

openmode is a CLI and MCP server that lets coding agents edit and render video locally with ffmpeg. Read README.md for what it does and CONTRIBUTING.md for how to extend it.

- Node 20+, TypeScript, ESM. Imports use `.js` extensions.
- `npm run typecheck && npm test && npm run build` must pass. Tests render real video with the ffmpeg on PATH; do not replace them with mocks.
- Source layout: `src/core` (ffmpeg, media, output), `src/look`, `src/engines/<name>`, `src/versions`, `src/cli.ts`, `src/mcp.ts`.
- User-facing text (errors, tool descriptions, README) is plain and specific. An error names the field or file and the fix.
- The MCP tool list must stay small (`test/mcp.test.ts` enforces a size limit).
- Never add telemetry, hosted calls or bundled binaries.
