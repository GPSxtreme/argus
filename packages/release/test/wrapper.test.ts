import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANAGEMENT_WRAPPER_REQUIREMENTS } from "@argus/contracts";
import {
  renderArgusWrapper,
  type ArgusWrapperOptions,
} from "../src/wrapper.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const digest = "a".repeat(64);
const fixture: ArgusWrapperOptions = {
  version: "1.2.3-rc.1+build.7",
  cliImageDigest: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest}`,
};
const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "argus-wrapper-"));
  temporaryDirectories.push(directory);
  return directory;
};

const executable = (path: string, contents: string): void => {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const runInPty = (
  command: string,
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> => {
  const arguments_ =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", command]
      : ["-qec", command, "/dev/null"];
  return spawnSync("script", arguments_, {
    env: environment,
    stdio: "ignore",
  });
};

interface WrapperFixture {
  directory: string;
  script: string;
  record: string;
  signalRecord: string;
  environment: NodeJS.ProcessEnv;
}

const createWrapperFixture = (
  options: { arch?: string; docker?: boolean; signal?: boolean } = {},
): WrapperFixture => {
  const directory = temporaryDirectory();
  const bin = join(directory, "bin");
  const script = join(directory, "argus");
  const record = join(directory, "docker.argv");
  const signalRecord = join(directory, "docker.signal");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(script, renderArgusWrapper(fixture), { mode: 0o755 });
  executable(
    join(bin, "uname"),
    `#!/bin/sh\nprintf '%s\\n' '${options.arch ?? "x86_64"}'\n`,
  );
  if (options.docker !== false) {
    executable(
      join(bin, "docker"),
      options.signal
        ? `#!/bin/sh\nprintf 'ready\\n' > "$ARGUS_READY"\ntrap 'printf TERM > "$ARGUS_SIGNAL"; exit 143' TERM\nwhile :; do sleep 1; done\n`
        : `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGUS_RECORD"\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`,
    );
  }
  return {
    directory,
    script,
    record,
    signalRecord,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ARGUS_RECORD: record,
      ARGUS_READY: join(directory, "ready"),
      ARGUS_SIGNAL: signalRecord,
    },
  };
};

const recordedArguments = (path: string): string[] =>
  readFileSync(path)
    .toString("utf8")
    .split("\0")
    .slice(0, -1);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("renderArgusWrapper", () => {
  it("renders deterministic POSIX shell with the exact shared management boundary", () => {
    const first = renderArgusWrapper(fixture);
    const second = renderArgusWrapper({ ...fixture });

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first).not.toMatch(/:latest\b/u);
    expect(first).not.toContain("$HOME");
    expect(first).not.toContain("$(pwd)");
    expect(first).not.toContain("--env-file");
    expect(first).toContain("--network host");
    for (const mount of MANAGEMENT_WRAPPER_REQUIREMENTS.mounts) {
      expect(first).toContain(`--volume ${shellQuote(mount)}`);
    }
    expect(first).toContain(
      `--env ${shellQuote(MANAGEMENT_WRAPPER_REQUIREMENTS.environment[0])}`,
    );
    for (const environment of MANAGEMENT_WRAPPER_REQUIREMENTS.environment.slice(1)) {
      expect(first).toContain(`--env "${environment}=`);
    }
    expect(first).toContain("--cap-drop ALL");
    expect(first).toContain("--security-opt no-new-privileges");
    expect(first).toContain("--read-only");
    expect(first).toContain("--tmpfs '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'");
    expect(first).toMatch(/if \[ -t 1 \]; then/u);
    expect(first).not.toMatch(/\[ -t 0 \]/u);
    expect(first).toMatch(/\bexec docker run\b/u);
  });

  it("rejects invalid SemVer and every unpinned, tagged, or credentialed image", () => {
    for (const version of ["v1.2.3", "01.2.3", "1.2", "1.2.3-alpha.01"]) {
      expect(() => renderArgusWrapper({ ...fixture, version })).toThrow(
        /SemVer/u,
      );
    }
    for (const cliImageDigest of [
      "ghcr.io/gpsxtreme/argus-cli:1.2.3",
      "ghcr.io/gpsxtreme/argus-cli:latest",
      `user:secret@ghcr.io/gpsxtreme/argus-cli@sha256:${digest}`,
      `ghcr.io/gpsxtreme/argus-cli@sha256:${"A".repeat(64)}`,
    ]) {
      expect(() =>
        renderArgusWrapper({ ...fixture, cliImageDigest }),
      ).toThrow(/digest-pinned/u);
    }
  });

  it.each([
    ["x86_64", "amd64"],
    ["aarch64", "arm64"],
  ])("normalizes %s and preserves hostile argv exactly", (arch, normalized) => {
    const harness = createWrapperFixture({ arch });
    const input = ["status", "space value", "*.yaml", "line one\nline two", "'; touch nope"];
    const result = spawnSync(harness.script, input, {
      encoding: "utf8",
      env: harness.environment,
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(harness.directory, "nope"))).toBe(false);
    const arguments_ = recordedArguments(harness.record);
    expect(arguments_).toContain(`ARGUS_HOST_ARCH=${normalized}`);
    expect(arguments_).toContain(`ARGUS_VERSION=${fixture.version}`);
    expect(arguments_).toContain(fixture.cliImageDigest);
    expect(arguments_.slice(-input.length)).toEqual(input);
    expect(arguments_.filter((value) => value === "--volume")).toHaveLength(4);
    expect(
      arguments_
        .flatMap((value, index) =>
          arguments_[index - 1] === "--env" ? [value] : [],
        )
        .sort(),
    ).toEqual([
      `ARGUS_HOST_ARCH=${normalized}`,
      "ARGUS_INSTALL_ROOT=/opt/argus",
      `ARGUS_VERSION=${fixture.version}`,
    ]);
    expect(arguments_.join("\n")).not.toMatch(
      /(?:\/Users\/|\/home\/|\.ssh|--env-file)/u,
    );
  });

  it("preserves the Docker exit code", () => {
    const harness = createWrapperFixture();
    const result = spawnSync(harness.script, ["doctor"], {
      env: { ...harness.environment, FAKE_DOCKER_EXIT: "37" },
    });
    expect(result.status).toBe(37);
  });

  it.skipIf(spawnSync("sh", ["-c", "command -v script"]).status !== 0)(
    "adds -t exactly when stdout is a TTY, independent of stdin",
    () => {
      const harness = createWrapperFixture();
      const wrapperCommand = `${shellQuote(harness.script)} status`;

      const ttyResult = runInPty(wrapperCommand, harness.environment);
      expect(ttyResult.status).toBe(0);
      expect(recordedArguments(harness.record)).toContain("-t");

      const terminalStdout = runInPty(
        `printf x | ${wrapperCommand}`,
        harness.environment,
      );
      expect(terminalStdout.status).toBe(0);
      expect(recordedArguments(harness.record)).toContain("-t");

      const captured = join(harness.directory, "captured");
      const capturedStdout = runInPty(
        `${wrapperCommand} > ${shellQuote(captured)}`,
        harness.environment,
      );
      expect(capturedStdout.status).toBe(0);
      expect(recordedArguments(harness.record)).not.toContain("-t");

      const nonTtyResult = spawnSync(harness.script, ["status"], {
        env: harness.environment,
        stdio: "ignore",
      });
      expect(nonTtyResult.status).toBe(0);
      expect(recordedArguments(harness.record)).not.toContain("-t");
    },
  );

  it("execs Docker so TERM reaches the Docker process", async () => {
    const harness = createWrapperFixture({ signal: true });
    const child = spawn(harness.script, ["status"], {
      env: harness.environment,
      stdio: "ignore",
    });
    const ready = String(harness.environment.ARGUS_READY);
    await new Promise<void>((resolvePromise, reject) => {
      const deadline = Date.now() + 5_000;
      const check = (): void => {
        if (existsSync(ready)) {
          resolvePromise();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("fake Docker did not start"));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
    child.kill("SIGTERM");
    const status = await new Promise<number | null>((resolvePromise) => {
      child.once("exit", resolvePromise);
    });

    expect(status).toBe(143);
    expect(readFileSync(harness.signalRecord, "utf8")).toBe("TERM");
  });

  it("prints an exact safely quoted invocation in inspect mode without running Docker", () => {
    const harness = createWrapperFixture();
    const input = [
      "config",
      "show",
      "space value",
      "*.yaml",
      "line\nvalue",
      "single'quote",
    ];
    const result = spawnSync(harness.script, input, {
      encoding: "utf8",
      env: {
        ...harness.environment,
        ARGUS_WRAPPER_INSPECT: "1",
        UNRELATED_SECRET: "must-not-leak",
      },
    });

    expect(result.status).toBe(0);
    expect(existsSync(harness.record)).toBe(false);
    expect(result.stdout).toContain("docker run");
    expect(result.stdout).toContain(shellQuote("space value"));
    expect(result.stdout).toContain(shellQuote("*.yaml"));
    expect(result.stdout).not.toContain("must-not-leak");

    const replay = spawnSync("sh", ["-c", result.stdout], {
      env: harness.environment,
    });
    expect(replay.status).toBe(0);
    expect(recordedArguments(harness.record).slice(-input.length)).toEqual(input);
  });

  it("fails actionably when Docker or the host architecture is unavailable", () => {
    const missingDocker = createWrapperFixture({ docker: false });
    const dockerResult = spawnSync(missingDocker.script, [], {
      encoding: "utf8",
      env: {
        ...missingDocker.environment,
        PATH: join(missingDocker.directory, "bin"),
      },
    });
    expect(dockerResult.status).not.toBe(0);
    expect(dockerResult.stderr).toMatch(/Install Docker/u);

    const unsupported = createWrapperFixture({ arch: "riscv64" });
    const archResult = spawnSync(unsupported.script, [], {
      encoding: "utf8",
      env: unsupported.environment,
    });
    expect(archResult.status).not.toBe(0);
    expect(archResult.stderr).toMatch(/x86_64.*aarch64/u);
  });

  it("exports fixture bytes to clean stdout and passes shell syntax", () => {
    const result = spawnSync(
      "fnm",
      [
        "exec",
        "--using=24.16.0",
        "/opt/homebrew/bin/pnpm",
        "tsx",
        "scripts/release/export-wrapper.ts",
        "--fixture",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(renderArgusWrapper({
      version: "0.1.0",
      cliImageDigest: `ghcr.io/gpsxtreme/argus-cli@sha256:${"0".repeat(64)}`,
    }));
    const shellCheck = spawnSync("sh", ["-n"], { input: result.stdout });
    expect(shellCheck.status).toBe(0);
  });

  it("rejects incomplete, unknown, and duplicate exporter arguments without writing", () => {
    for (const arguments_ of [
      [],
      ["--unknown"],
      ["--fixture", "--version", "1.2.3"],
      ["--fixture", "--fixture"],
      ["--version", "1.2.3"],
    ]) {
      const result = spawnSync(
        "fnm",
        [
          "exec",
          "--using=24.16.0",
          "/opt/homebrew/bin/pnpm",
          "tsx",
          "scripts/release/export-wrapper.ts",
          ...arguments_,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
    }
  });

  it("writes only when an explicit output path is provided", () => {
    const directory = temporaryDirectory();
    const output = join(directory, "bin", "argus");
    const result = spawnSync(
      "fnm",
      [
        "exec",
        "--using=24.16.0",
        "/opt/homebrew/bin/pnpm",
        "tsx",
        "scripts/release/export-wrapper.ts",
        "--fixture",
        "--output",
        output,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(readFileSync(output, "utf8")).toBe(renderArgusWrapper({
      version: "0.1.0",
      cliImageDigest: `ghcr.io/gpsxtreme/argus-cli@sha256:${"0".repeat(64)}`,
    }));
    expect(readFileSync(output).subarray(0, 2).toString()).toBe("#!");
  });
});
