import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { describeMissing, findSequence, renderFrames } from "../src/engines/frames/index.js";
import { render } from "../src/engines/index.js";
import { look } from "../src/look/index.js";
import { ffmpeg, makeMedia, probe, tempDir } from "./helpers.js";

let dir: string;
let media: ReturnType<typeof makeMedia>;
let frames: string;

beforeAll(() => {
  dir = tempDir("frames");
  media = makeMedia(dir);
  frames = join(dir, "frames");
  mkdirSync(frames);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=641x361:r=24:d=2", "-start_number", "1", join(frames, "frame_%04d.png")]);
});

describe("frames", () => {
  it("finds the sequence and joins it with a soundtrack", async () => {
    const sequence = findSequence(frames);
    expect(sequence).toMatchObject({ first: 1, last: 48, count: 48, pattern: "frame_%04d.png", missing: [] });
    const result = await renderFrames({ dir: frames, fps: 24, audio: media.music, out: join(dir, "film.mp4") });
    // Odd frame sizes are rounded to even ones so H.264 accepts them.
    expect(result).toMatchObject({ width: 640, height: 360, duration: 2, hasAudio: true });
    expect(Number(probe(result.path).format.duration)).toBeCloseTo(2, 1);
  });

  it("is picked automatically for a folder", async () => {
    const result = await render(frames, { quality: "draft", fps: 12, out: join(dir, "auto.mp4") });
    expect(result.engine).toBe("frames");
    expect(result.duration).toBe(4);
  });

  it("names the missing frames instead of rendering a broken film", async () => {
    rmSync(join(frames, "frame_0010.png"));
    rmSync(join(frames, "frame_0011.png"));
    rmSync(join(frames, "frame_0030.png"));
    await expect(renderFrames({ dir: frames })).rejects.toThrow(/3 frame\(s\) are missing.*10-11, 30/);
    expect(describeMissing([1, 2, 3, 7, 9, 10])).toBe("1-3, 7, 9-10");
  });

  it("explains an empty folder", () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(() => findSequence(empty)).toThrow(/No numbered image sequence/);
  });
});

describe("look", () => {
  it("returns a labelled sheet and the facts of a video", async () => {
    const out = join(dir, "sheet.jpg");
    const result = await look({ path: media.gappy, frames: 8, out });
    expect(result.kind).toBe("video");
    expect(result.duration).toBeCloseTo(3.5, 1);
    expect(result.tiles).toHaveLength(8);
    expect(result.sheet).toMatchObject({ columns: 4, rows: 2 });
    expect(existsSync(out)).toBe(true);
    expect(result.image.subarray(0, 2).toString("hex")).toBe("ffd8");
    // The middle stretch is silent and black; look must find both.
    expect(result.silences).toHaveLength(1);
    expect(result.silences![0]!.start).toBeCloseTo(1, 0);
    expect(result.silences![0]!.end).toBeCloseTo(2.5, 0);
    expect(result.black).toHaveLength(1);
    expect(result.black![0]!.start).toBeCloseTo(1, 0);
    expect(result.loudness?.lufs).toBeLessThan(0);
  });

  it("returns one full frame with `at`", async () => {
    const result = await look({ path: media.talk, at: 2, quick: true });
    expect(result.tiles).toEqual([{ label: "0:02.0", seconds: 2 }]);
    expect(result.sheet.width).toBe(1536);
    expect(result.loudness).toBeUndefined();
  });

  it("looks at a frames folder and reports gaps", async () => {
    const result = await look({ path: frames, frames: 6 });
    expect(result.kind).toBe("frames");
    expect(result.frameCount).toBe(45);
    expect(result.missingFrames).toBe("10-11, 30");
  });

  it("rejects sound-only files and bad ranges", async () => {
    await expect(look({ path: media.music })).rejects.toThrow(/no picture/);
    await expect(look({ path: media.talk, at: 99 })).rejects.toThrow(/between 0 and/);
    await expect(look({ path: join(dir, "nope.mp4") })).rejects.toThrow(/Not found/);
  });
});
