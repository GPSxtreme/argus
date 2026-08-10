import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const policy = join(repositoryRoot, "scripts/ci/assert-stable-bundle-change.mjs");
const temporaryRepositories: string[] = [];

const git = (directory: string, arguments_: readonly string[]): string =>
  execFileSync("git", arguments_, { cwd: directory, encoding: "utf8" });

const createRepository = (): { directory: string; base: string } => {
  const directory = mkdtempSync(join(tmpdir(), "argus-stable-bundle-policy-"));
  temporaryRepositories.push(directory);
  git(directory, ["init", "--initial-branch=main"]);
  git(directory, ["config", "user.email", "test@example.invalid"]);
  git(directory, ["config", "user.name", "Argus test"]);
  writeFileSync(join(directory, "README.md"), "base\n");
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "-m", "base"]);
  return { directory, base: git(directory, ["rev-parse", "HEAD"]).trim() };
};

const commit = (directory: string, files: Record<string, string>): string => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "change"]);
  return git(directory, ["rev-parse", "HEAD"]).trim();
};

const runPolicy = (directory: string, base: string, head: string) =>
  spawnSync(process.execPath, [policy, base, head], {
    cwd: directory,
    encoding: "utf8",
  });

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stable bundle change policy", () => {
  it("allows unrelated changes when the stable bundle is untouched", () => {
    const { directory, base } = createRepository();
    const head = commit(directory, { "apps/web/app/page.tsx": "export {};\n" });

    expect(runPolicy(directory, base, head).status).toBe(0);
  });

  it("allows the exact three stable bundle members alongside unrelated changes", () => {
    const { directory, base } = createRepository();
    const head = commit(directory, {
      "apps/web/public/releases/stable/install.sh": "#!/bin/sh\n",
      "apps/web/public/releases/stable/manifest.json": "{}\n",
      "apps/web/public/releases/stable/manifest.sig": "signature\n",
      "docs/operations.md": "also changed\n",
    });

    expect(runPolicy(directory, base, head).status).toBe(0);
  });

  it("rejects a partial stable bundle change", () => {
    const { directory, base } = createRepository();
    const head = commit(directory, {
      "apps/web/public/releases/stable/manifest.json": "{}\n",
    });

    const result = runPolicy(directory, base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing install.sh, manifest.sig");
  });

  it("rejects extra files under the stable directory", () => {
    const { directory, base } = createRepository();
    const head = commit(directory, {
      "apps/web/public/releases/stable/install.sh": "#!/bin/sh\n",
      "apps/web/public/releases/stable/manifest.json": "{}\n",
      "apps/web/public/releases/stable/manifest.sig": "signature\n",
      "apps/web/public/releases/stable/notes.txt": "not a bundle member\n",
    });

    const result = runPolicy(directory, base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected notes.txt");
  });
});
