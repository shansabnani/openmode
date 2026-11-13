import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEdit, renderEdit, validateEdit, EditError, frameSize } from "../src/engines/edit/index.js";
import { makeMedia, probe, tempDir } from "./helpers.js";

let dir: string;
beforeAll(() => {
  dir = tempDir("edit");
  makeMedia(dir);
});

const base = {
  version: 1,
  format: "9:16",
  clips: [
    { src: "footage/talk.mp4", start: 0.5, end: 2.5, caption: "A caption long enough that it has to wrap on a narrow frame." },
    { src: "footage/silent.mp4", duration: 1.5, transition: "fade" },
    { src: "footage/talk.mp4", start: 2, end: 4, speed: 2 },
    { src: "footage/logo.png", duration: 1 },
  ],
  audio: [{ src: "footage/music.wav", volume: 0.3, at: 0.5, fadeOut: 0.5 }],
  endCard: "The end",
};

describe("edit schema", () => {
  it("names the exact field that is wrong", () => {
    expect(() => parseEdit({ version: 1, clips: [{ src: "a.mp4", strat: 1 }] })).toThrow(/clips\[0\]/);
    expect(() => parseEdit({ version: 1, clips: [{ src: "logo.png" }] })).toThrow(/clips\[0\]\.duration/);
    expect(() => parseEdit({ version: 1, clips: [{ src: "notes.txt" }] })).toThrow(/video .* or image/);
    expect(() => parseEdit({ version: 2, clips: [{ src: "a.mp4" }] })).toThrow(/version/);
    expect(() => parseEdit({ version: 1, clips: [{ src: "ftp://host/a.mp4" }] })).toThrow(/local path or an https URL/);
  });

  it("computes even frame sizes for every format", () => {
    expect(frameSize("16:9", "1080p")).toEqual({ width: 1920, height: 1080 });
    expect(frameSize("9:16", "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(frameSize("4:5", "1080p")).toEqual({ width: 1080, height: 1350 });
    expect(frameSize("16:9", "4k")).toEqual({ width: 3840, height: 2160 });
    expect(frameSize("16:9", "360p")).toEqual({ width: 640, height: 360 });
  });
});

describe("edit render", () => {
  it("places clips with trims, speed and fades", async () => {
    const result = await validateEdit({ edit: base, baseDir: dir });
    // 2 + 1.5 + (2 / 2) + 1, minus a 0.45 s fade (45% of the 1 s clip that follows)
    expect(result.duration).toBeCloseTo(5.05, 2);
    expect(result.clips.map((clip) => clip.at)).toEqual([0, 2, 3.05, 4.05]);
  });

  it("renders a draft with sound, at the right size and length", async () => {
    const out = join(dir, "out", "draft.mp4");
    const result = await renderEdit({ edit: base, baseDir: dir, quality: "draft", out });
    expect(result).toMatchObject({ width: 360, height: 640, hasAudio: true, quality: "draft" });
    const info = probe(out);
    const video = info.streams.find((stream) => stream.codec_type === "video")!;
    expect(video.width).toBe(360);
    expect(video.height).toBe(640);
    expect(info.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
    expect(Number(info.format.duration)).toBeCloseTo(5.05, 0);
  });

  it("renders a final from an edit file, relative to that file", async () => {
    writeFileSync(join(dir, "cut.json"), JSON.stringify({ ...base, resolution: "720p", audio: undefined }));
    const result = await renderEdit({ file: join(dir, "cut.json"), quality: "final" });
    expect(result.path).toBe(join(dir, "renders", "cut-final.mp4"));
    expect(result).toMatchObject({ width: 720, height: 1280 });
    expect(existsSync(result.path)).toBe(true);
  });

  it("renders silent footage with no audio stream", async () => {
    const result = await renderEdit({
      edit: { version: 1, clips: [{ src: "footage/silent.mp4" }, { src: "footage/logo.png", duration: 1 }] },
      baseDir: dir,
      out: join(dir, "out", "silent.mp4"),
    });
    expect(result.hasAudio).toBe(false);
    expect(result.duration).toBeCloseTo(4, 1);
  });

  it("explains a trim that runs past the end of the source", async () => {
    await expect(
      validateEdit({ edit: { version: 1, clips: [{ src: "footage/talk.mp4", start: 1, end: 9 }] }, baseDir: dir }),
    ).rejects.toThrow(/clips\[0\].*only 4\.\d+s long/);
  });

  it("explains a missing file", async () => {
    await expect(
      renderEdit({ edit: { version: 1, clips: [{ src: "footage/nope.mp4" }] }, baseDir: dir }),
    ).rejects.toThrow(/File not found: footage\/nope\.mp4/);
  });

  it("refuses to write the render over an input", async () => {
    await expect(
      renderEdit({
        edit: { version: 1, clips: [{ src: "footage/talk.mp4" }] },
        baseDir: dir,
        out: join(dir, "footage", "talk.mp4"),
      }),
    ).rejects.toThrow(/over one of its own inputs/);
    expect(() => parseEdit({ version: 1, clips: [] })).toThrow(EditError);
  });
});
