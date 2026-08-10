import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANAGEMENT_WRAPPER_REQUIREMENTS } from "@argus/contracts";
import { renderArgusWrapper } from "../src/wrapper.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");
const wrapperExporter = resolve(
  repositoryRoot,
  "scripts/release/export-wrapper.ts",
);
const digest = "a".repeat(64);
const cliImage = `ghcr.io/gpsxtreme/argus-cli@sha256:${digest}`;
const validState = `schema=1\nversion=1.2.3-rc.1+build.7\ncli_image=${cliImage}\n`;
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

const runWrapperExporter = (
  arguments_: string[],
): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [tsxCli, wrapperExporter, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

/* This is a test-only textual fixture, not a runtime override: production bytes
 * always name the shared fixed state path. It lets an executable fixture use a
 * disposable state file without adding an environment-controlled behavior. */
const renderFixtureWrapper = (stateFile: string, socket = "/var/run/docker.sock"): string => {
  if (!stateFile.startsWith(tmpdir())) {
    throw new Error("Fixture state must be inside the system temporary directory.");
  }
  return renderArgusWrapper()
    .replaceAll(MANAGEMENT_WRAPPER_REQUIREMENTS.stateFile, stateFile)
    .replaceAll("/var/run/docker.sock", socket);
};

interface WrapperFixture {
  directory: string;
  script: string;
  stateFile: string;
  record: string;
  signalRecord: string;
  environment: NodeJS.ProcessEnv;
}

const createWrapperFixture = (
  options: {
    arch?: string;
    docker?: boolean;
    signal?: boolean;
    socket?: string;
    state?: string;
  } = {},
): WrapperFixture => {
  const directory = temporaryDirectory();
  const bin = join(directory, "bin");
  const script = join(directory, "argus");
  const stateFile = join(directory, "management.state");
  const record = join(directory, "docker.argv");
  const signalRecord = join(directory, "docker.signal");
  mkdirSync(bin);
  if (options.state !== undefined) {
    writeFileSync(stateFile, options.state, { mode: 0o644 });
    chmodSync(stateFile, 0o644);
  }
  writeFileSync(
    script,
    renderFixtureWrapper(stateFile, options.socket),
    { mode: 0o755 },
  );
  executable(
    join(bin, "uname"),
    `#!/bin/sh\nprintf '%s\\n' '${options.arch ?? "x86_64"}'\n`,
  );
  if (options.docker !== false) {
    executable(
      join(bin, "docker"),
      options.signal
        ? `#!/bin/sh\ntrap 'printf TERM > "$ARGUS_SIGNAL"; exit 143' TERM\nprintf 'ready\\n' > "$ARGUS_READY"\nwhile :; do sleep 1; done\n`
        : `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGUS_RECORD"\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`,
    );
  }
  return {
    directory,
    script,
    stateFile,
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
  it("renders immutable launcher bytes from the shared state contract", () => {
    const first = renderArgusWrapper();
    const second = renderArgusWrapper();

    expect(first).toBe(second);
    expect(first.split("\n").slice(0, 4)).toEqual([
      "#!/bin/sh",
      "# argus-host-wrapper schema=1",
      "# generated-by=@argus/release",
      "set -eu",
    ]);
    expect(first).toContain(MANAGEMENT_WRAPPER_REQUIREMENTS.stateFile);
    expect(first).not.toContain(cliImage);
    expect(first).not.toContain("1.2.3-rc.1+build.7");
    expect(first).not.toMatch(/:latest\b/u);
    expect(first).not.toContain("$HOME");
    expect(first).not.toContain("$(pwd)");
    expect(first).not.toContain("--env-file");
    expect(spawnSync("sh", ["-n"], { input: first }).status).toBe(0);
  });

  it.each([
    ["missing terminal newline", validState.slice(0, -1)],
    ["extra key", `${validState}extra=x\n`],
    ["reordered keys", `version=1.2.3-rc.1+build.7\nschema=1\ncli_image=${cliImage}\n`],
    ["duplicate key", `schema=1\nversion=1.2.3-rc.1+build.7\nversion=1.2.3-rc.1+build.7\ncli_image=${cliImage}\n`],
    ["missing key", "schema=1\nversion=1.2.3-rc.1+build.7\n"],
    ["CRLF", validState.replaceAll("\n", "\r\n")],
    ["blank line", `schema=1\n\nversion=1.2.3-rc.1+build.7\ncli_image=${cliImage}\n`],
    ["leading whitespace", ` schema=1\nversion=1.2.3-rc.1+build.7\ncli_image=${cliImage}\n`],
    ["trailing whitespace", `schema=1\nversion=1.2.3-rc.1+build.7 \ncli_image=${cliImage}\n`],
    ["unnormalized SemVer", `schema=1\nversion=01.2.3\ncli_image=${cliImage}\n`],
    ["uppercase digest", `schema=1\nversion=1.2.3\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${"A".repeat(64)}\n`],
    ["credentials", `schema=1\nversion=1.2.3\ncli_image=user:secret@ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["tag without digest", "schema=1\nversion=1.2.3\ncli_image=ghcr.io/gpsxtreme/argus-cli:1.2.3\n"],
    ["OCI image longer than 255 bytes", `schema=1\nversion=1.2.3\ncli_image=registry.example.com/${"a".repeat(190)}@sha256:${digest}\n`],
    ["NUL byte", validState.replace("version", "ver\u0000sion")],
    ["wrong schema", `schema=2\nversion=1.2.3\ncli_image=${cliImage}\n`],
    ["oversize input", `${validState}${"x".repeat(MANAGEMENT_WRAPPER_REQUIREMENTS.maximumStateBytes)}`],
    ["shell injection", `schema=1\nversion=$(touch nope)\ncli_image=${cliImage}\n`],
  ])("rejects hostile %s state before Docker runs", (_name, state) => {
    const harness = createWrapperFixture({ state });
    const result = spawnSync(harness.script, ["status"], {
      encoding: "utf8",
      env: harness.environment,
    });

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("management state");
    expect(existsSync(harness.record)).toBe(false);
    expect(existsSync(join(harness.directory, "nope"))).toBe(false);
  });

  it("rejects missing, symlinked, non-regular, and wrong-mode state before Docker runs", () => {
    const missing = createWrapperFixture();
    const symlinked = createWrapperFixture({ state: validState });
    const nonRegular = createWrapperFixture({ state: validState });
    const wrongMode = createWrapperFixture({ state: validState });
    const symlinkTarget = join(symlinked.directory, "state-target");
    writeFileSync(symlinkTarget, validState, { mode: 0o644 });
    rmSync(symlinked.stateFile);
    symlinkSync(symlinkTarget, symlinked.stateFile);
    rmSync(nonRegular.stateFile);
    mkdirSync(nonRegular.stateFile);
    chmodSync(wrongMode.stateFile, 0o600);

    for (const harness of [missing, symlinked, nonRegular, wrongMode]) {
      const result = spawnSync(harness.script, ["status"], {
        encoding: "utf8",
        env: harness.environment,
      });
      expect(result.status).toBe(65);
      expect(result.stderr).toContain("management state");
      expect(existsSync(harness.record)).toBe(false);
    }
  });

  it.each([
    ["x86_64", "amd64"],
    ["aarch64", "arm64"],
  ])("normalizes %s and preserves hostile argv exactly", (arch, normalized) => {
    const harness = createWrapperFixture({ arch, state: validState });
    const input = [
      "status",
      "space value",
      "",
      "*.yaml",
      "line one\nline two",
      "'; touch nope",
    ];
    const result = spawnSync(harness.script, input, {
      encoding: "utf8",
      env: harness.environment,
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(harness.directory, "nope"))).toBe(false);
    const arguments_ = recordedArguments(harness.record);
    expect(arguments_).toContain(`ARGUS_HOST_ARCH=${normalized}`);
    expect(arguments_).toContain("ARGUS_VERSION=1.2.3-rc.1+build.7");
    expect(arguments_).toContain("DOCKER_CONFIG=/opt/argus/.docker");
    expect(arguments_).toContain(cliImage);
    expect(arguments_.slice(0, 3)).toEqual([
      "--config",
      "/opt/argus/.docker",
      "run",
    ]);
    expect(arguments_.slice(-input.length)).toEqual(input);
    expect(arguments_.filter((value) => value === "--volume")).toHaveLength(
      MANAGEMENT_WRAPPER_REQUIREMENTS.mounts.length,
    );
    expect(
      arguments_
        .flatMap((value, index) =>
          arguments_[index - 1] === "--volume" ? [value] : [],
        )
        .sort(),
    ).toEqual([...MANAGEMENT_WRAPPER_REQUIREMENTS.mounts].sort());
    expect(
      arguments_
        .flatMap((value, index) =>
          arguments_[index - 1] === "--env" ? [value] : [],
        )
        .sort(),
    ).toEqual([
      `ARGUS_HOST_ARCH=${normalized}`,
      "ARGUS_INSTALL_ROOT=/opt/argus",
      "ARGUS_VERSION=1.2.3-rc.1+build.7",
      "DOCKER_CONFIG=/opt/argus/.docker",
    ]);
    expect(arguments_).toEqual(expect.arrayContaining([
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    ]));
    expect(arguments_.join("\n")).not.toMatch(
      /(?:\/Users\/|\/home\/|\.ssh|--env-file)/u,
    );
  });

  it("preserves the Docker exit code", () => {
    const harness = createWrapperFixture({ state: validState });
    const result = spawnSync(harness.script, ["doctor"], {
      env: { ...harness.environment, FAKE_DOCKER_EXIT: "37" },
    });
    expect(result.status).toBe(37);
  });

  it.skipIf(spawnSync("sh", ["-c", "command -v script"]).status !== 0)(
    "adds -t exactly when stdout is a TTY, independent of stdin",
    () => {
      const harness = createWrapperFixture({ state: validState });
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
    const harness = createWrapperFixture({ signal: true, state: validState });
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
    const harness = createWrapperFixture({ state: validState });
    const input = [
      "config",
      "show",
      "space value",
      "",
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

  it("fails actionably when Docker, its socket, or the host architecture is unavailable", () => {
    const missingDocker = createWrapperFixture({ docker: false, state: validState });
    const dockerResult = spawnSync(missingDocker.script, [], {
      encoding: "utf8",
      env: {
        ...missingDocker.environment,
        PATH: `${join(missingDocker.directory, "bin")}:/usr/bin:/bin`,
      },
    });
    expect(dockerResult.status).toBe(69);
    expect(dockerResult.stderr).toMatch(/Install Docker/u);

    const missingSocket = createWrapperFixture({
      socket: join(temporaryDirectory(), "missing.sock"),
      state: validState,
    });
    const socketResult = spawnSync(missingSocket.script, [], {
      encoding: "utf8",
      env: missingSocket.environment,
    });
    expect(socketResult.status).toBe(69);
    expect(socketResult.stderr).toMatch(/socket is unavailable/u);
    expect(existsSync(missingSocket.record)).toBe(false);

    const unsupported = createWrapperFixture({
      arch: "riscv64",
      state: validState,
    });
    const archResult = spawnSync(unsupported.script, [], {
      encoding: "utf8",
      env: unsupported.environment,
    });
    expect(archResult.status).toBe(64);
    expect(archResult.stderr).toMatch(/x86_64.*aarch64/u);
  });

  it("exports immutable bytes to clean stdout and accepts only an output path", () => {
    const result = runWrapperExporter([]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(renderArgusWrapper());
    expect(spawnSync("sh", ["-n"], { input: result.stdout }).status).toBe(0);

    for (const arguments_ of [
      ["--fixture"],
      ["--version", "1.2.3"],
      ["--cli-image", cliImage],
      ["--unknown"],
      ["--output"],
      ["--output", "one", "--output", "two"],
    ]) {
      const rejected = runWrapperExporter(arguments_);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain("Usage:");
    }
  });

  it("writes immutable bytes only when an explicit output path is provided", () => {
    const directory = temporaryDirectory();
    const output = join(directory, "bin", "argus");
    const result = runWrapperExporter(["--output", output]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(readFileSync(output, "utf8")).toBe(renderArgusWrapper());
    expect(readFileSync(output).subarray(0, 2).toString()).toBe("#!");
  });
});
