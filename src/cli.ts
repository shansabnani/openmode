#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { status } from "./core/status.js";
import { validateEdit } from "./engines/edit/index.js";
import type { Renderer } from "./engines/blender/index.js";
import { engines, render } from "./engines/index.js";
import { look } from "./look/index.js";
import { EDIT_GUIDE, VERSION, runStdioServer } from "./mcp.js";
import { diffVersions, listVersions, restoreVersion, saveVersion } from "./versions/index.js";

const HELP = `openmode ${VERSION} — video rendering and editing for coding agents

  openmode look <video|image|frames-dir>     See it: contact sheet + facts
      [--frames 12] [--start s] [--end s] [--at s] [--out sheet.jpg] [--quick]
  openmode render <edit.json|frames-dir>     Make the MP4
      [--draft | --final] [--out film.mp4] [--fps 24] [--audio music.wav] [--loudness -14]
  openmode render <scene.blend|scene.py>     Render a Blender scene with your Blender
      [--draft | --final] [--range 1-48] [--step 2] [--renderer cycles|eevee|workbench]
      [--samples 32] [--audio music.wav] [--scripts] [--out film.mp4]
  openmode check <edit.json>                 Validate an edit without rendering
  openmode save [-m "what changed"] [--prompt "..."] [--model name]
  openmode versions                          List saved versions
  openmode restore <v3>                      Go back (recorded as a new version)
  openmode diff <v2> [v3|current]            What changed between versions
  openmode schema                            The edit file format
  openmode status                            Check ffmpeg, Blender and features
  openmode init                              Add openmode notes to AGENTS.md
  openmode mcp                               Run the MCP server (stdio)

Connect an agent:
  claude mcp add openmode -- npx -y openmode mcp
  codex mcp add openmode -- npx -y openmode mcp

Add --json to any command for machine-readable output.`;

const AGENTS_SECTION = `## Video work: openmode

Use openmode for any video task in this folder (cut, trim, caption, combine, add music, render, review). It runs locally on ffmpeg.

- See footage or a render: \`npx -y openmode look <file> --out sheet.jpg\`, then read the sheet image and the printed facts (length, loudness, silences, black frames).
- Edit: write an edit file (\`npx -y openmode schema\` shows the format), then \`npx -y openmode render edit.json --draft\`, look at the result, fix, and finish with \`--final\`.
- 3D: \`npx -y openmode render scene.blend --draft\` (or a Python scene script, \`scene.py\`) renders a Blender scene with the Blender on this machine. Look at the draft, then \`--final\`.
- Frames from another renderer or a browser capture: \`npx -y openmode render <frames-dir> --fps 24 --audio music.wav\`.
- Keep every version: \`npx -y openmode save -m "what changed" --prompt "<the request>"\`. \`openmode versions\`, \`openmode diff v1 v2\` and \`openmode restore v1\` are safe: restore never loses work.
- Always look at a draft before rendering final, and before telling the user it is done.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function print(asJson: boolean, value: unknown, text: () => string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`);
}

const num = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`--${name} must be a number.`);
  return n;
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "mcp") return runStdioServer();

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      out: { type: "string", short: "o" },
      frames: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      at: { type: "string" },
      quick: { type: "boolean" },
      draft: { type: "boolean" },
      final: { type: "boolean" },
      fps: { type: "string" },
      audio: { type: "string" },
      loudness: { type: "string" },
      message: { type: "string", short: "m" },
      prompt: { type: "string" },
      model: { type: "string" },
      dir: { type: "string" },
      force: { type: "boolean" },
      range: { type: "string" },
      step: { type: "string" },
      renderer: { type: "string" },
      samples: { type: "string" },
      scripts: { type: "boolean" },
    },
  });
  const asJson = Boolean(values.json);
  const first = positionals[0];

  switch (command) {
    case "look": {
      if (!first) fail("Usage: openmode look <video|image|frames-dir>");
      const out = values.out ?? "openmode-look.jpg";
      const { image: _image, ...facts } = await look({
        path: first,
        frames: num(values.frames, "frames"),
        start: num(values.start, "start"),
        end: num(values.end, "end"),
        at: num(values.at, "at"),
        quick: values.quick,
        out,
      });
      print(asJson, facts, () => {
        const lines = [`Sheet: ${facts.sheet.path} (${facts.sheet.columns}x${facts.sheet.rows} tiles)`];
        if (facts.kind === "video") {
          lines.push(
            `Video: ${facts.duration}s, ${facts.width}x${facts.height}, ${facts.fps} fps, ${facts.videoCodec}, ${mb(facts.sizeBytes ?? 0)}`,
          );
          if (facts.loudness) lines.push(`Loudness: ${facts.loudness.lufs} LUFS, peak ${facts.loudness.peak ?? "?"} dBFS`);
          if (facts.silences?.length) {
            lines.push(`Silences: ${facts.silences.map((s) => `${s.start}-${s.end}s`).join(", ")}`);
          }
          if (facts.black?.length) {
            lines.push(`Black: ${facts.black.map((s) => `${s.start}-${s.end}s`).join(", ")}`);
          }
        } else if (facts.kind === "frames") {
          lines.push(`Frames: ${facts.frameCount} at ${facts.width}x${facts.height}`);
          if (facts.missingFrames) lines.push(`Missing: ${facts.missingFrames}`);
        } else {
          lines.push(`Image: ${facts.width}x${facts.height}`);
        }
        lines.push(`Tiles: ${facts.tiles.map((tile) => tile.label).join("  ")}`, ...facts.notes);
        return lines.join("\n");
      });
      return;
    }
    case "render": {
      if (!first) fail(`Usage: openmode render <input>\nRenders: ${engines.map((e) => e.summary).join("\n         ")}`);
      if (values.draft && values.final) fail("Choose --draft or --final, not both.");
      const result = await render(first, {
        quality: values.final ? "final" : values.draft ? "draft" : undefined,
        out: values.out,
        fps: num(values.fps, "fps"),
        audio: values.audio,
        loudness: num(values.loudness, "loudness"),
        range: values.range,
        step: num(values.step, "step"),
        renderer: values.renderer as Renderer | undefined,
        samples: num(values.samples, "samples"),
        allowScripts: values.scripts,
        // Long Blender renders say where they are, on stderr so --json stays clean.
        onProgress: (done, total) => {
          if (process.stderr.isTTY) process.stderr.write(`\rframe ${done}/${total}${done === total ? "\n" : ""}`);
        },
      });
      print(asJson, result, () =>
        [
          result.path,
          `${result.quality}: ${result.duration}s, ${result.width}x${result.height}, ${result.fps} fps, ${mb(result.size)}, ${result.hasAudio ? "with sound" : "no sound"}`,
          `Rendered in ${result.seconds}s (${result.encoder})`,
          ...(result.notes ?? []),
        ].join("\n"),
      );
      return;
    }
    case "check": {
      if (!first) fail("Usage: openmode check <edit.json>");
      const result = await validateEdit({ file: first });
      print(asJson, result, () =>
        `OK: ${result.duration}s, ${result.width}x${result.height} at ${result.fps} fps, ${result.clips.length} clips`,
      );
      return;
    }
    case "save": {
      const result = await saveVersion({
        dir: values.dir,
        message: values.message,
        prompt: values.prompt,
        model: values.model,
        force: values.force,
      });
      print(asJson, result, () =>
        result.saved
          ? `Saved ${result.version.id}: ${result.version.message} (${result.version.files} files, ${mb(result.version.bytes)})`
          : `Nothing changed since ${result.version.id}.`,
      );
      return;
    }
    case "versions":
    case "log": {
      const versions = listVersions(values.dir);
      print(asJson, { versions }, () =>
        versions.length
          ? versions
              .map((v) => `${v.id.padEnd(5)} ${v.createdAt.slice(0, 16).replace("T", " ")}  ${v.message}`)
              .join("\n")
          : "No versions yet. Save one with: openmode save -m \"first cut\"",
      );
      return;
    }
    case "restore": {
      if (!first) fail("Usage: openmode restore <v3>");
      const result = await restoreVersion({ dir: values.dir, id: first });
      print(asJson, result, () =>
        [
          ...(result.autoSaved ? [`Your unsaved work was saved as ${result.autoSaved.id}.`] : []),
          `Restored ${result.restored} as ${result.version.id} (${result.written} files written, ${result.removed} removed).`,
        ].join("\n"),
      );
      return;
    }
    case "diff": {
      if (!first) fail("Usage: openmode diff <v2> [v3|current]");
      const result = await diffVersions({ dir: values.dir, from: first, to: positionals[1] });
      print(asJson, result, () =>
        [
          `${result.from} → ${result.to}: ${result.added.length} added, ${result.removed.length} removed, ${result.changed.length} changed, ${result.unchanged} unchanged`,
          ...result.added.map((path) => `+ ${path}`),
          ...result.removed.map((path) => `- ${path}`),
          ...result.changed.flatMap((file) => [
            `~ ${file.path} (${file.fromSize} → ${file.toSize} bytes)`,
            ...(file.diff ? file.diff.split("\n").map((line) => `    ${line}`) : []),
          ]),
        ].join("\n"),
      );
      return;
    }
    case "schema":
      process.stdout.write(`${EDIT_GUIDE}\n`);
      return;
    case "status": {
      const result = await status();
      print(asJson, { version: VERSION, ...result }, () =>
        [
          `openmode ${VERSION}`,
          result.ffmpeg
            ? `ffmpeg ${result.ffmpeg.version} at ${result.ffmpeg.path} (encoder ${result.ffmpeg.encoder}, captions ${result.ffmpeg.captions ? "yes" : "no"})`
            : "ffmpeg: not found",
          result.blender
            ? `blender ${result.blender.version} at ${result.blender.path}`
            : "blender: not found (only needed to render .blend files and Blender scripts)",
          ...engines.map((engine) => `engine ${engine.name}: ${engine.summary}`),
          ...result.problems,
        ].join("\n"),
      );
      if (!result.ready) process.exitCode = 1;
      return;
    }
    case "init": {
      const file = resolve(values.dir ?? ".", "AGENTS.md");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (existing.includes("## Video work: openmode")) {
        print(asJson, { file, changed: false }, () => `${file} already has the openmode section.`);
        return;
      }
      writeFileSync(file, `${existing}${existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : ""}${AGENTS_SECTION}`);
      print(asJson, { file, changed: true }, () =>
        `Added the openmode section to ${file}.\nConnect the MCP server with:\n  claude mcp add openmode -- npx -y openmode mcp`,
      );
      return;
    }
    default:
      fail(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
