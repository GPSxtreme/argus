import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { zipSync, type Zippable } from "fflate";

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const sourceDate = (): Date => {
  const raw = process.env.SOURCE_DATE_EPOCH ?? "315532800";
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new TypeError("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  const timestamp = Number(raw) * 1_000;
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(timestamp)) {
    throw new TypeError("SOURCE_DATE_EPOCH is outside the supported date range.");
  }
  const date = new Date(timestamp);
  if (date.getUTCFullYear() < 1980 || date.getUTCFullYear() > 2099) {
    throw new TypeError("SOURCE_DATE_EPOCH is outside the ZIP timestamp range.");
  }
  return date;
};

const collectFiles = async (root: string, path = root): Promise<string[]> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Skill archive rejects symlink: ${path}`);
  if (!metadata.isDirectory()) return [path];

  const files: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    files.push(...(await collectFiles(root, resolve(path, entry.name))));
  }
  return files;
};

const archivePath = (root: string, file: string): string | undefined => {
  const path = relative(root, file).split(sep).join("/");
  if (path === "SKILL.md" || path === "LICENSE.txt") return `argus-setup/${path}`;
  if (path.startsWith("references/") && path.endsWith(".md")) {
    return `argus-setup/${path}`;
  }
  return undefined;
};

/** Builds a portable Argus skill ZIP with reproducible bytes. */
export const buildSkillArchive = async (
  input: string,
): Promise<{ bytes: Uint8Array; sha256: string }> => {
  const inputMetadata = await lstat(resolve(input));
  if (inputMetadata.isSymbolicLink()) throw new Error("Skill archive root cannot be a symlink.");
  const root = await realpath(resolve(input));
  const files = await collectFiles(root);
  const mtime = sourceDate();
  const entries: Array<[string, Uint8Array]> = [];

  for (const file of files) {
    const resolvedFile = await realpath(file);
    if (!isWithin(root, resolvedFile)) throw new Error(`Skill archive rejects out-of-root file: ${file}`);
    const path = archivePath(root, file);
    if (path) entries.push([path, await readFile(file)]);
  }

  const required = new Set(["argus-setup/SKILL.md", "argus-setup/LICENSE.txt"]);
  for (const path of required) {
    if (!entries.some(([entry]) => entry === path)) throw new Error(`Skill archive requires ${path}.`);
  }

  const contents: Zippable = {};
  for (const [path, bytes] of entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    contents[path] = [bytes, { attrs: 0o644 << 16, level: 9, mtime, os: 3 }];
  }
  const bytes = zipSync(contents, { level: 9, mtime, os: 3, attrs: 0o644 << 16 });
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
};
