import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { lineDiff } from "./diff.js";

/**
 * Versions for a film folder. Every save records the whole folder: a manifest
 * of file hashes plus the files themselves in a content-addressed store, so
 * unchanged footage is stored once however many versions exist. Restoring
 * never loses work: unsaved changes are saved first, and the restore itself
 * is recorded as a new version.
 */

const STORE = ".openmode";
const MAX_FILES = 20_000;
const DEFAULT_IGNORES = [
  ".openmode",
  ".git",
  "node_modules",
  "__pycache__",
  ".DS_Store",
  "*.blend1",
  "*.tmp",
];

export type FileEntry = { path: string; sha: string; size: number };

export type VersionMeta = {
  id: string;
  createdAt: string;
  message: string;
  /** The prompt that produced this version, if the agent recorded it. */
  prompt?: string;
  model?: string;
  parent?: string;
  restoredFrom?: string;
  files: number;
  bytes: number;
};

type Manifest = VersionMeta & { entries: FileEntry[] };

type HashCache = Record<string, { size: number; mtimeMs: number; sha: string }>;

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionError";
  }
}

/** The film folder: the nearest parent that already has versions, else dir. */
export function findProjectRoot(dir = process.cwd()): string {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, STORE, "versions"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(dir);
    current = parent;
  }
}

function parseId(id: string): number {
  const match = /^v(\d{1,6})$/.exec(id.trim());
  if (!match) throw new VersionError(`"${id}" is not a version id. Use v1, v2, ...`);
  return Number(match[1]);
}

function versionsDir(root: string) {
  return join(root, STORE, "versions");
}

function objectPath(root: string, sha: string) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new VersionError("Corrupt version manifest (bad hash).");
  return join(root, STORE, "objects", sha.slice(0, 2), sha);
}

function readIgnores(root: string): string[] {
  const file = join(root, ".openmodeignore");
  const extra = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];
  return [...DEFAULT_IGNORES, ...extra];
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/** A pattern without a slash matches any path segment; with one, the path from the root. */
export function isIgnored(path: string, patterns: readonly string[]): boolean {
  const segments = path.split("/");
  return patterns.some((raw) => {
    const pattern = raw.replace(/\/+$/, "");
    const matcher = globToRegExp(pattern.replace(/^\//, ""));
    if (pattern.includes("/")) {
      return segments.some((_, i) => matcher.test(segments.slice(0, i + 1).join("/")));
    }
    return segments.some((segment) => matcher.test(segment));
  });
}

function walk(root: string, patterns: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      if (isIgnored(rel, patterns)) continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });
}

function loadCache(root: string): HashCache {
  try {
    return JSON.parse(readFileSync(join(root, STORE, "hash-cache.json"), "utf8")) as HashCache;
  } catch {
    return {};
  }
}

/** Hash the working folder. Files whose size and mtime are unchanged reuse their cached hash. */
async function scan(root: string): Promise<FileEntry[]> {
  if (root === homedir() || dirname(root) === root) {
    throw new VersionError(
      `${root} is not a film folder. Run this inside the folder that holds the film's files.`,
    );
  }
  const paths = walk(root, readIgnores(root));
  if (paths.length > MAX_FILES) {
    throw new VersionError(
      `${root} holds ${paths.length} files, more than a film folder should (${MAX_FILES}). Run this inside the film's own folder, or list folders to skip in .openmodeignore.`,
    );
  }
  const cache = loadCache(root);
  const next: HashCache = {};
  const entries: FileEntry[] = [];
  for (const path of paths) {
    const full = join(root, path);
    const stat = lstatSync(full);
    const cached = cache[path];
    const sha =
      cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
        ? cached.sha
        : await hashFile(full);
    next[path] = { size: stat.size, mtimeMs: stat.mtimeMs, sha };
    entries.push({ path, sha, size: stat.size });
  }
  if (existsSync(join(root, STORE))) {
    writeFileSync(join(root, STORE, "hash-cache.json"), JSON.stringify(next));
  }
  return entries;
}

function readManifest(root: string, id: string): Manifest {
  const file = join(versionsDir(root), `v${parseId(id)}.json`);
  if (!existsSync(file)) {
    const known = listVersions(root).map((version) => version.id);
    throw new VersionError(
      known.length
        ? `No version ${id}. Saved versions: ${known.join(", ")}.`
        : "No versions saved here yet. Save one first.",
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

export function listVersions(dir?: string): VersionMeta[] {
  const root = findProjectRoot(dir);
  if (!existsSync(versionsDir(root))) return [];
  return readdirSync(versionsDir(root))
    .filter((name) => /^v\d+\.json$/.test(name))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)))
    .map((name) => {
      const { entries: _entries, ...meta } = JSON.parse(
        readFileSync(join(versionsDir(root), name), "utf8"),
      ) as Manifest;
      return meta;
    });
}

function sameFiles(a: FileEntry[], b: FileEntry[]): boolean {
  if (a.length !== b.length) return false;
  const index = new Map(a.map((entry) => [entry.path, entry.sha]));
  return b.every((entry) => index.get(entry.path) === entry.sha);
}

export type SaveRequest = {
  dir?: string;
  message?: string;
  prompt?: string;
  model?: string;
  /** Save even when nothing changed since the last version. */
  force?: boolean;
};

export type SaveResult = { version: VersionMeta; saved: boolean; root: string };

async function writeVersion(
  root: string,
  entries: FileEntry[],
  meta: { message?: string; prompt?: string; model?: string; restoredFrom?: string },
): Promise<VersionMeta> {
  mkdirSync(versionsDir(root), { recursive: true });
  for (const entry of entries) {
    const dest = objectPath(root, entry.sha);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    // Copy-on-write where the filesystem supports it (APFS, Btrfs, XFS):
    // large footage then takes no extra disk space.
    copyFileSync(join(root, entry.path), dest, constants.COPYFILE_FICLONE);
  }
  const existing = listVersions(root);
  const parent = existing.at(-1)?.id;
  const number = (existing.length ? parseId(parent!) : 0) + 1;
  const manifest: Manifest = {
    id: `v${number}`,
    createdAt: new Date().toISOString(),
    message: meta.message?.trim() || `Version ${number}`,
    ...(meta.prompt?.trim() ? { prompt: meta.prompt.trim() } : {}),
    ...(meta.model?.trim() ? { model: meta.model.trim() } : {}),
    ...(parent ? { parent } : {}),
    ...(meta.restoredFrom ? { restoredFrom: meta.restoredFrom } : {}),
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    entries,
  };
  writeFileSync(join(versionsDir(root), `${manifest.id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  const { entries: _entries, ...version } = manifest;
  return version;
}

/** Save the film folder as the next version. A no-op when nothing changed. */
export async function saveVersion(request: SaveRequest = {}): Promise<SaveResult> {
  const root = findProjectRoot(request.dir);
  const entries = await scan(root);
  if (entries.length === 0) throw new VersionError(`Nothing to save: ${root} has no files.`);
  const latest = listVersions(root).at(-1);
  if (latest && !request.force && sameFiles(readManifest(root, latest.id).entries, entries)) {
    return { version: latest, saved: false, root };
  }
  return { version: await writeVersion(root, entries, request), saved: true, root };
}

export type RestoreResult = {
  restored: string;
  version: VersionMeta;
  /** Set when unsaved work was saved before restoring. */
  autoSaved?: VersionMeta;
  written: number;
  removed: number;
  root: string;
};

function insideRoot(root: string, path: string): string {
  const full = resolve(root, path);
  if (path.startsWith("/") || path.split("/").includes("..") || !full.startsWith(resolve(root) + sep)) {
    throw new VersionError(`Corrupt version manifest (path escapes the folder): ${path}`);
  }
  return full;
}

/** Put the folder back to a saved version, then record that as a new version. */
export async function restoreVersion(request: { dir?: string; id: string }): Promise<RestoreResult> {
  const root = findProjectRoot(request.dir);
  const target = readManifest(root, request.id);
  for (const entry of target.entries) {
    if (!existsSync(objectPath(root, entry.sha))) {
      throw new VersionError(`${target.id} is incomplete: stored copy of ${entry.path} is missing.`);
    }
  }
  const current = await scan(root);
  const latest = listVersions(root).at(-1);
  let autoSaved: VersionMeta | undefined;
  if (current.length && (!latest || !sameFiles(readManifest(root, latest.id).entries, current))) {
    autoSaved = await writeVersion(root, current, {
      message: `Auto-save before restoring ${target.id}`,
    });
  }
  const wanted = new Map(target.entries.map((entry) => [entry.path, entry]));
  const have = new Map(current.map((entry) => [entry.path, entry.sha]));
  let removed = 0;
  for (const entry of current) {
    if (!wanted.has(entry.path)) {
      rmSync(insideRoot(root, entry.path), { force: true });
      removed += 1;
    }
  }
  let written = 0;
  for (const entry of target.entries) {
    if (have.get(entry.path) === entry.sha) continue;
    const dest = insideRoot(root, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    copyFileSync(objectPath(root, entry.sha), dest, constants.COPYFILE_FICLONE);
    written += 1;
  }
  const version = await writeVersion(root, await scan(root), {
    message: `Restore ${target.id}: ${target.message}`,
    prompt: target.prompt,
    model: target.model,
    restoredFrom: target.id,
  });
  return { restored: target.id, version, autoSaved, written, removed, root };
}

export type DiffResult = {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  changed: { path: string; fromSize: number; toSize: number; diff?: string }[];
  unchanged: number;
};

const TEXT_LIMIT = 256 * 1024;

function readText(root: string, entry: FileEntry, working: boolean): string | null {
  if (entry.size > TEXT_LIMIT) return null;
  const buffer = readFileSync(working ? join(root, entry.path) : objectPath(root, entry.sha));
  return buffer.includes(0) ? null : buffer.toString("utf8");
}

/** Compare two versions, or a version with the folder as it is now ("current"). */
export async function diffVersions(request: {
  dir?: string;
  from: string;
  to?: string;
}): Promise<DiffResult> {
  const root = findProjectRoot(request.dir);
  const toId = request.to ?? "current";
  const load = async (id: string) =>
    id === "current" ? await scan(root) : readManifest(root, id).entries;
  const from = await load(request.from);
  const to = await load(toId);
  const fromIndex = new Map(from.map((entry) => [entry.path, entry]));
  const toIndex = new Map(to.map((entry) => [entry.path, entry]));
  const result: DiffResult = {
    from: request.from,
    to: toId,
    added: to.filter((entry) => !fromIndex.has(entry.path)).map((entry) => entry.path),
    removed: from.filter((entry) => !toIndex.has(entry.path)).map((entry) => entry.path),
    changed: [],
    unchanged: 0,
  };
  for (const after of to) {
    const before = fromIndex.get(after.path);
    if (!before) continue;
    if (before.sha === after.sha) {
      result.unchanged += 1;
      continue;
    }
    const a = readText(root, before, request.from === "current");
    const b = readText(root, after, toId === "current");
    result.changed.push({
      path: after.path,
      fromSize: before.size,
      toSize: after.size,
      ...(a !== null && b !== null ? { diff: lineDiff(a, b) } : {}),
    });
  }
  return result;
}
