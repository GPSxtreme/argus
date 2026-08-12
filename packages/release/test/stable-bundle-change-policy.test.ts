import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const policy = join(repositoryRoot, "scripts/ci/assert-stable-bundle-change.mjs");
const manifest = "apps/web/public/releases/stable/manifest.json";
const signature = "apps/web/public/releases/stable/manifest.sig";
const installer = "apps/web/public/releases/stable/install.sh";
const temporaryRepositories: string[] = [];
const gitLocalEnvironmentVariables = execFileSync(
  "git",
  ["rev-parse", "--local-env-vars"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const withoutGitRepositoryState = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const name of gitLocalEnvironmentVariables) {
    delete environment[name];
  }
  return environment;
};

const git = (directory: string, arguments_: readonly string[]): string =>
  execFileSync("git", arguments_, {
    cwd: directory,
    encoding: "utf8",
    env: withoutGitRepositoryState(),
  });

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

const filesFor = (paths: readonly string[]): Record<string, string> =>
  Object.fromEntries(paths.map((path) => [path, `${path}\n`]));

const runPolicy = (directory: string, base: string, head: string) =>
  spawnSync(process.execPath, [policy, base, head], {
    cwd: directory,
    encoding: "utf8",
    env: withoutGitRepositoryState(),
  });

const withInheritedGitRepositoryState = <Result>(
  directory: string,
  run: () => Result,
): Result => {
  const inheritedEnvironment = {
    GIT_DIR: join(directory, ".git"),
    GIT_INDEX_FILE: join(directory, ".git", "index"),
    GIT_WORK_TREE: directory,
  };
  const previousEnvironment = new Map(
    Object.keys(inheritedEnvironment).map((name) => [name, process.env[name]]),
  );

  Object.assign(process.env, inheritedEnvironment);
  try {
    return run();
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stable bundle change policy", () => {
  it("ignores inherited Git repository state when creating and checking fixture commits", () => {
    const ambient = createRepository();

    const result = withInheritedGitRepositoryState(ambient.directory, () => {
      const { directory, base } = createRepository();
      const head = commit(directory, { "apps/web/app/page.tsx": "export {};\n" });
      return runPolicy(directory, base, head);
    });

    expect(result.status).toBe(0);
    expect(git(ambient.directory, ["rev-parse", "HEAD"]).trim()).toBe(ambient.base);
    expect(git(ambient.directory, ["status", "--porcelain"])).toBe("");
  });

  it("allows unrelated changes when the stable bundle is untouched", () => {
    const { directory, base } = createRepository();
    const head = commit(directory, { "apps/web/app/page.tsx": "export {};\n" });

    expect(runPolicy(directory, base, head).status).toBe(0);
  });

  it.each([
    [[manifest, signature], 0],
    [[installer, manifest, signature], 0],
    [[manifest], 1],
    [[signature], 1],
    [[installer], 1],
    [[manifest, installer], 1],
    [[signature, installer], 1],
  ])("enforces stable changed set %j", (paths, status) => {
    const { directory, base } = createRepository();
    const head = commit(directory, filesFor(paths));
    const result = runPolicy(directory, base, head);

    if (status === 0) expect(result.stderr).toBe("");
    expect(result.status).toBe(status);
  });

  it.each([
    [[manifest, signature]],
    [[installer, manifest, signature]],
  ])("allows unrelated paths beside valid stable set %j", (paths) => {
    const { directory, base } = createRepository();
    const head = commit(directory, filesFor([...paths, "docs/operations.md"]));

    expect(runPolicy(directory, base, head).status).toBe(0);
  });

  it.each([
    [[manifest, signature]],
    [[installer, manifest, signature]],
  ])("rejects notes.txt beside valid stable set %j", (paths) => {
    const { directory, base } = createRepository();
    const head = commit(directory, filesFor([...paths, "apps/web/public/releases/stable/notes.txt"]));

    const result = runPolicy(directory, base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected notes.txt");
  });
});
