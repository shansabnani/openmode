import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BLENDER_INSTALL_HINT, detectBlender, parseRange, renderBlender } from "../src/engines/blender/index.js";
import { render } from "../src/engines/index.js";
import { makeMedia, probe, tempDir } from "./helpers.js";

/** These tests render with the real Blender. Machines without it skip them. */
function findBlender(): string | null {
  try {
    return detectBlender();
  } catch {
    return null;
  }
}
const blender = findBlender();

// Six frames of a cube at 320x180, one Cycles sample: Cycles renders on a CPU with no display.
const SCENE = `
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.mesh.primitive_cube_add(size=2)
cube = bpy.context.object
bpy.ops.object.light_add(type="SUN", location=(3, -3, 5))
bpy.ops.object.camera_add(location=(0, -7, 2), rotation=(1.3, 0, 0))
scene.camera = bpy.context.object
scene.render.engine = "CYCLES"
scene.cycles.samples = 1
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = 320, 180
scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 6
cube.keyframe_insert("rotation_euler", frame=1)
cube.rotation_euler = (0, 0, 1.5)
cube.keyframe_insert("rotation_euler", frame=6)
`;

describe("blender: without Blender", () => {
  const saved = process.env.BLENDER_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.BLENDER_PATH;
    else process.env.BLENDER_PATH = saved;
  });

  it("says how to install Blender when BLENDER_PATH is wrong", () => {
    process.env.BLENDER_PATH = "/nowhere/blender";
    expect(() => detectBlender()).toThrow(/\/nowhere\/blender, which does not exist/);
    expect(() => detectBlender()).toThrow(BLENDER_INSTALL_HINT.split("\n")[1]!);
  });

  it("reads frame ranges", () => {
    expect(parseRange("1-48")).toEqual({ start: 1, end: 48 });
    expect(parseRange("12")).toEqual({ start: 12, end: 12 });
    expect(() => parseRange("48-1")).toThrow(/ends before it starts/);
    expect(() => parseRange("first")).toThrow(/1-48 or 12/);
  });

  it("refuses files that are not scenes", async () => {
    const dir = tempDir("blender-kind");
    writeFileSync(join(dir, "notes.txt"), "hello");
    await expect(renderBlender({ file: join(dir, "notes.txt") })).rejects.toThrow(/\.blend files and \.py scene scripts/);
    await expect(renderBlender({ file: join(dir, "missing.blend") })).rejects.toThrow(/Scene not found/);
  });
});

describe.skipIf(!blender)("blender: rendering", () => {
  let dir: string;
  let script: string;
  let blend: string;

  beforeAll(() => {
    dir = tempDir("blender");
    script = join(dir, "cube.py");
    writeFileSync(script, SCENE);
    // The same scene saved as a .blend, by Blender itself.
    blend = join(dir, "cube.blend");
    const save = join(dir, "save.py");
    writeFileSync(save, `${SCENE}\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})\n`);
    execFileSync(blender!, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", save], {
      stdio: "pipe",
    });
  }, 120_000);

  it("renders a scene script to an MP4 and reports what Blender did", async () => {
    const seen: number[] = [];
    const result = await renderBlender({ file: script, onProgress: (done) => seen.push(done) });
    expect(result).toMatchObject({
      engine: "blender",
      quality: "draft",
      width: 320,
      height: 180,
      fps: 24,
      duration: 0.25,
      hasAudio: false,
    });
    expect(result.path).toBe(join(dir, "renders", "cube-draft.mp4"));
    expect(result.notes?.[0]).toMatch(/^Blender \d+\.\d+.*Cycles, 1 samples$/);
    expect(result.notes?.[1]).toBe("6 frames (1-6)");
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    const video = probe(result.path).streams.find((stream) => stream.codec_type === "video");
    expect(video).toMatchObject({ width: 320, height: 180 });
  }, 180_000);

  it("is picked for a .blend, and honours range, step and a soundtrack", async () => {
    const { music } = makeMedia(dir);
    const result = await render(blend, {
      quality: "final",
      range: "1-6",
      step: 2,
      audio: music,
      out: join(dir, "stepped.mp4"),
    });
    expect(result.engine).toBe("blender");
    // Frames 1, 3 and 5 at half the frame rate: the film keeps its quarter second.
    expect(result).toMatchObject({ fps: 12, duration: 0.25, hasAudio: true });
    expect(result.notes?.[1]).toBe("3 frames (1-6, every 2nd frame)");
    expect(existsSync(join(dir, "stepped.mp4"))).toBe(true);
  }, 180_000);

  it("makes a draft smaller than the scene, and lets the renderer be changed", async () => {
    const big = join(dir, "big.py");
    writeFileSync(
      big,
      `${SCENE}\nscene.render.resolution_x, scene.render.resolution_y = 1280, 720\nscene.cycles.samples = 64\n`,
    );
    const draft = await renderBlender({ file: big, range: "1" });
    expect(draft).toMatchObject({ width: 640, height: 360 });
    expect(draft.notes?.[0]).toMatch(/Cycles, 16 samples$/);
    const workbench = await renderBlender({ file: big, range: "1", renderer: "workbench", out: join(dir, "wb.mp4") });
    expect(workbench.notes?.[0]).toMatch(/Workbench$/);
  }, 180_000);

  it("explains a scene with no camera", async () => {
    const blind = join(dir, "blind.py");
    writeFileSync(blind, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\n`);
    await expect(renderBlender({ file: blind })).rejects.toThrow(/The scene has no camera/);
  }, 120_000);

  it("passes on the error from a broken scene script", async () => {
    const broken = join(dir, "broken.py");
    writeFileSync(broken, `import bpy\nbpy.ops.mesh.primitive_teapot_add()\n`);
    await expect(renderBlender({ file: broken })).rejects.toThrow(/The scene script failed: .*primitive_teapot_add/);
  }, 120_000);
});
