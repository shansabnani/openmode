import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { lineDiff } from "../src/versions/diff.js";
import { diffVersions, isIgnored, listVersions, restoreVersion, saveVersion } from "../src/versions/index.js";
import { tempDir } from "./helpers.js";

let dir: string;
beforeEach(() => {
  // tempDir is behind a symlink on macOS (/var → /private/var): versions must work there.
  dir = tempDir("versions");
  mkdirSync(join(dir, "footage"));
  writeFileSync(join(dir, "edit.json"), '{\n  "version": 1,\n  "clips": []\n}\n');
  writeFileSync(join(dir, "footage", "a.bin"), Buffer.alloc(4096, 7));
});

describe("versions", () => {
  it("saves, skips unchanged saves, and stores unchanged files once", async () => {
    const first = await saveVersion({ dir, message: "first cut", prompt: "make it punchy", model: "test" });
    expect(first).toMatchObject({ saved: true, version: { id: "v1", message: "first cut", files: 2 } });
    expect((await saveVersion({ dir })).saved).toBe(false);

    writeFileSync(join(dir, "edit.json"), '{\n  "version": 1,\n  "clips": [1]\n}\n');
    const second = await saveVersion({ dir, message: "second cut" });
    expect(second.version).toMatchObject({ id: "v2", parent: "v1" });
    expect(listVersions(dir).map((version) => version.id)).toEqual(["v1", "v2"]);
    expect(listVersions(dir)[0]).toMatchObject({ prompt: "make it punchy", model: "test" });

    // 2 files in v1 + 1 changed file in v2 = 3 stored objects, not 4.
    const { readdirSync } = await import("node:fs");
    const objects = readdirSync(join(dir, ".openmode", "objects")).flatMap((prefix) =>
      readdirSync(join(dir, ".openmode", "objects", prefix)),
    );
    expect(objects).toHaveLength(3);
  });

  it("restores without losing unsaved work, and records the restore", async () => {
    await saveVersion({ dir, message: "first cut" });
    writeFileSync(join(dir, "edit.json"), "changed and never saved\n");
    writeFileSync(join(dir, "extra.txt"), "new file\n");
    rmSync(join(dir, "footage", "a.bin"));

    const result = await restoreVersion({ dir, id: "v1" });
    expect(result.autoSaved?.id).toBe("v2");
    expect(result.version).toMatchObject({ id: "v3", restoredFrom: "v1" });
    expect(readFileSync(join(dir, "edit.json"), "utf8")).toContain('"clips": []');
    expect(existsSync(join(dir, "footage", "a.bin"))).toBe(true);
    expect(existsSync(join(dir, "extra.txt"))).toBe(false);

    // The unsaved work is one restore away.
    await restoreVersion({ dir, id: "v2" });
    expect(readFileSync(join(dir, "edit.json"), "utf8")).toBe("changed and never saved\n");
    expect(readFileSync(join(dir, "extra.txt"), "utf8")).toBe("new file\n");
  });

  it("diffs versions with a line diff for text files", async () => {
    await saveVersion({ dir });
    writeFileSync(join(dir, "edit.json"), '{\n  "version": 1,\n  "clips": [1]\n}\n');
    writeFileSync(join(dir, "notes.md"), "hello\n");
    rmSync(join(dir, "footage", "a.bin"));
    const diff = await diffVersions({ dir, from: "v1" });
    expect(diff).toMatchObject({ to: "current", added: ["notes.md"], removed: ["footage/a.bin"], unchanged: 0 });
    expect(diff.changed[0]!.path).toBe("edit.json");
    expect(diff.changed[0]!.diff).toContain('-   "clips": []');
    expect(diff.changed[0]!.diff).toContain('+   "clips": [1]');
  });

  it("ignores stores, dependencies and listed patterns, and never follows symlinks", async () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "x");
    mkdirSync(join(dir, "renders"));
    writeFileSync(join(dir, "renders", "draft.mp4"), "x");
    writeFileSync(join(dir, ".openmodeignore"), "# drafts are cheap to remake\nrenders/\n*.log\n");
    writeFileSync(join(dir, "debug.log"), "x");
    symlinkSync("/etc", join(dir, "link"));
    const { version } = await saveVersion({ dir });
    expect(version.files).toBe(3); // edit.json, footage/a.bin, .openmodeignore
    expect(isIgnored("a/b/node_modules/c.js", ["node_modules"])).toBe(true);
    expect(isIgnored("renders/x.mp4", ["renders/"])).toBe(true);
    expect(isIgnored("src/renders.ts", ["renders/"])).toBe(false);
  });

  it("gives clear errors", async () => {
    await expect(restoreVersion({ dir, id: "v9" })).rejects.toThrow(/No versions saved here yet/);
    await saveVersion({ dir });
    await expect(restoreVersion({ dir, id: "v9" })).rejects.toThrow(/No version v9\. Saved versions: v1/);
    await expect(restoreVersion({ dir, id: "../v1" })).rejects.toThrow(/not a version id/);
  });
});

describe("lineDiff", () => {
  it("shows changed lines with context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g"].join("\n");
    expect(lineDiff(before, after)).toBe(["  b", "  c", "- d", "+ D", "  e", "  f"].join("\n"));
  });
});
