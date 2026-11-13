import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";
import { makeMedia, tempDir } from "./helpers.js";

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];

let client: Client;
let dir: string;

beforeAll(async () => {
  dir = tempDir("mcp");
  makeMedia(dir);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return { content: result.content as Content, isError: Boolean(result.isError) };
};

describe("mcp server", () => {
  it("offers a small, described tool set and usage instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["edit_schema", "look", "render_blender", "render_edit", "render_frames", "status", "versions"],
    );
    expect(JSON.stringify(tools).length).toBeLessThan(9000);
    expect(client.getInstructions()).toMatch(/look at the draft/);
  });

  it("runs the loop: render a draft, look at it, save a version", async () => {
    const edit = {
      version: 1,
      clips: [{ src: "footage/talk.mp4", end: 2, caption: "Hello" }, { src: "footage/logo.png", duration: 1 }],
    };
    const rendered = await call("render_edit", { edit, baseDir: dir, quality: "draft", out: join(dir, "draft.mp4") });
    expect(rendered.isError).toBe(false);
    const result = JSON.parse(rendered.content[0]!.text!) as { path: string; duration: number };
    expect(result.duration).toBe(3);

    const seen = await call("look", { path: result.path, frames: 4 });
    expect(seen.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(seen.content[1]!.data!.length).toBeGreaterThan(1000);
    expect(JSON.parse(seen.content[0]!.text!)).toMatchObject({ kind: "video", duration: 3 });

    const saved = await call("versions", { action: "save", dir, message: "first cut", prompt: "say hello" });
    expect(JSON.parse(saved.content[0]!.text!)).toMatchObject({ saved: true, version: { id: "v1" } });
    const listed = await call("versions", { action: "list", dir });
    expect(JSON.parse(listed.content[0]!.text!).versions).toHaveLength(1);
  });

  it("returns errors the agent can act on", async () => {
    const lost = await call("render_blender", { file: join(dir, "missing.blend") });
    expect(lost.isError).toBe(true);
    expect(lost.content[0]!.text).toMatch(/Scene not found: .*missing\.blend/);

    const bad = await call("render_edit", { edit: { version: 1, clips: [{ src: "footage/talk.mp4", sped: 2 }] } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/clips\[0\]/);
    const missing = await call("versions", { action: "restore", dir });
    expect(missing.content[0]!.text).toMatch(/needs an id/);
  });

  it("explains the edit format", async () => {
    const guide = await call("edit_schema", {});
    expect(guide.content[0]!.text).toMatch(/"version": 1/);
  });
});
