import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const appDockerfilePath = join(repositoryRoot, "deploy/docker/Dockerfile");
const cliDockerfilePath = join(repositoryRoot, "deploy/docker/Dockerfile.cli");
const appDockerfile = readFileSync(appDockerfilePath, "utf8");
const cliDockerfile = readFileSync(cliDockerfilePath, "utf8");
const pinnedNodeBase =
  "node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7";

const docker = (arguments_: string[], timeout = 120_000): string =>
  execFileSync("docker", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout,
  }).trim();

const execFileAsync = promisify(execFile);
const dockerAsync = async (
  arguments_: string[],
  timeout = 120_000,
): Promise<string> => {
  const { stdout } = await execFileAsync("docker", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
  });
  return String(stdout).trim();
};

describe("production image definitions", () => {
  it("pins every stage to the same official multi-architecture Node 24 base", () => {
    for (const dockerfile of [appDockerfile, cliDockerfile]) {
      const fromLines = dockerfile
        .split("\n")
        .filter((line) => line.startsWith("FROM "));
      expect(fromLines.length).toBeGreaterThan(1);
      expect(fromLines.every((line) => line.includes(pinnedNodeBase))).toBe(
        true,
      );
      expect(dockerfile).not.toMatch(/(?:FROM|image:)[^\n]*:latest\b/u);
      expect(dockerfile).toContain("ARG TARGETARCH");
      expect(dockerfile).toContain("pnpm install --frozen-lockfile");
      expect(dockerfile).toContain("prebuild-install/bin.js");
      expect(dockerfile).toContain('file "$native_module"');
      expect(dockerfile).toMatch(/ca-certificates=[^\s\\]+/u);
      expect(dockerfile).toMatch(/python3=[^\s\\]+/u);
    }
  });

  it("runs the application as a fixed non-root user with its runtime contract", () => {
    expect(appDockerfile).toMatch(/USER 10001:10001/u);
    expect(appDockerfile).toContain('ENV ARGUS_CONFIG="/app/argus.yaml"');
    expect(appDockerfile).toContain('VOLUME ["/app/data"]');
    expect(appDockerfile).toContain("EXPOSE 8788");
    expect(appDockerfile).toContain("HEALTHCHECK");
    expect(appDockerfile).toContain("http://127.0.0.1:8788/health");
    expect(appDockerfile).toContain('ENTRYPOINT ["tini", "--", "node"');
    expect(appDockerfile).toContain("org.opencontainers.image.version");
  });

  it("contains only the management client boundary and host inspection tools", () => {
    expect(cliDockerfile).toContain("USER 0:0");
    expect(cliDockerfile).toContain("iproute2");
    expect(cliDockerfile).toContain("openssl");
    expect(cliDockerfile).toContain("ca-certificates");
    expect(cliDockerfile).toContain("/usr/local/lib/docker/cli-plugins/docker-compose");
    expect(cliDockerfile).toContain('ENTRYPOINT ["node", "/app/apps/cli/dist/main.js"]');
    expect(cliDockerfile).toMatch(/ARG ARGUS_VERSION=/u);
    expect(cliDockerfile).not.toMatch(
      /(?:apt-get install|COPY --from=[^\n]+)[^\n]*\bdockerd\b/u,
    );
  });
});

const liveImages = process.env.ARGUS_IMAGE_TEST === "1";
const live = liveImages ? describe : describe.skip;
const appImage = "argus-app:test";
const cliImage = "argus-cli:test";
const containerName = `argus-image-test-${process.pid}`;
const dataVolume = `argus-image-test-data-${process.pid}`;
let fixtureDirectory: string | undefined;

live("built production images", () => {
  beforeAll(async () => {
    await dockerAsync(
      [
        "build",
        "--pull=false",
        "--build-arg",
        "ARGUS_VERSION=0.1.0-test",
        "--build-arg",
        "ARGUS_REVISION=image-test",
        "-f",
        "deploy/docker/Dockerfile",
        "-t",
        appImage,
        ".",
      ],
      600_000,
    );
    await dockerAsync(
      [
        "build",
        "--pull=false",
        "--build-arg",
        "ARGUS_VERSION=0.1.0-test",
        "--build-arg",
        "ARGUS_REVISION=image-test",
        "-f",
        "deploy/docker/Dockerfile.cli",
        "-t",
        cliImage,
        ".",
      ],
      600_000,
    );
  }, 1_200_000);

  afterAll(() => {
    try {
      docker(["container", "rm", "--force", containerName], 30_000);
    } catch {
      // The container is absent when startup itself failed.
    }
    try {
      docker(["volume", "rm", dataVolume], 30_000);
    } catch {
      // The volume is absent when startup itself failed.
    }
    for (const image of [appImage, cliImage]) {
      try {
        docker(["image", "rm", image], 30_000);
      } catch {
        // A failed build does not leave the requested image tag behind.
      }
    }
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true });
  });

  it("publishes non-root application metadata and reaches healthy state", async () => {
    const metadata = JSON.parse(docker(["image", "inspect", appImage]))[0] as {
      Config: {
        ExposedPorts: Record<string, unknown>;
        Healthcheck: { Test: string[] };
        User: string;
      };
    };
    expect(metadata.Config.User).toBe("10001:10001");
    expect(metadata.Config.ExposedPorts).toHaveProperty("8788/tcp");
    expect(metadata.Config.Healthcheck.Test.join(" ")).toContain(
      "http://127.0.0.1:8788/health",
    );

    fixtureDirectory = mkdtempSync(join(tmpdir(), "argus-image-"));
    chmodSync(fixtureDirectory, 0o755);
    const configPath = join(fixtureDirectory, "argus.yaml");
    writeFileSync(
      configPath,
      `version: 1
runtime:
  role: all
storage:
  adapter: sqlite
  url: /app/data/argus.db
sources:
  x: { enabled: false, endpoint: http://localhost:8787/api }
  telegram: { enabled: false, adapter: public-web }
  web: { enabled: false, userAgent: Argus/0.1, browserFallback: false }
watches: []
intelligence:
  enabled: false
  provider: openrouter
  model: openai/gpt-4.1-mini
  processors: []
api: { host: 0.0.0.0, port: 8788 }
`,
      { mode: 0o644 },
    );
    docker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--mount",
      `type=bind,source=${configPath},target=/app/argus.yaml,readonly`,
      "--mount",
      `type=volume,source=${dataVolume},target=/app/data`,
      appImage,
    ]);

    const deadline = Date.now() + 60_000;
    let status = "";
    while (Date.now() < deadline) {
      status = docker([
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        containerName,
      ]);
      if (status === "healthy") break;
      if (status === "unhealthy") {
        throw new Error(docker(["logs", "--tail", "100", containerName]));
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    expect(status).toBe("healthy");
    expect(docker(["exec", containerName, "test", "-f", "/app/data/argus.db"])).toBe(
      "",
    );
    expect(
      docker([
        "exec",
        containerName,
        "sh",
        "-c",
        "test ! -e /app/src && test ! -e /app/.env",
      ]),
    ).toBe("");
  }, 90_000);

  it("runs the compiled management CLI with all required host tools", () => {
    const metadata = JSON.parse(docker(["image", "inspect", cliImage]))[0] as {
      Config: { Entrypoint: string[]; User: string };
    };
    expect(metadata.Config.User).toBe("0:0");
    expect(metadata.Config.Entrypoint).toEqual([
      "node",
      "/app/apps/cli/dist/main.js",
    ]);
    expect(docker(["run", "--rm", "--entrypoint", "node", cliImage, "--version"])).toMatch(
      /^v24\./u,
    );
    expect(
      docker(["run", "--rm", "--entrypoint", "docker", cliImage, "--version"]),
    ).toMatch(/^Docker version /u);
    expect(
      docker(["run", "--rm", "--entrypoint", "docker", cliImage, "compose", "version"]),
    ).toMatch(/^Docker Compose version v2\./u);
    expect(
      docker(["run", "--rm", "--entrypoint", "ss", cliImage, "--version"]),
    ).toContain("iproute2");
    expect(
      docker(["run", "--rm", "--entrypoint", "openssl", cliImage, "version"]),
    ).toMatch(/^OpenSSL /u);
    expect(docker(["run", "--rm", cliImage, "--version"])).toBe("0.1.0-test");
    expect(docker(["run", "--rm", cliImage, "--help"])).toContain(
      "Usage: argus",
    );
    expect(
      docker([
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        cliImage,
        "-c",
        "! command -v dockerd",
      ]),
    ).toBe("");
  }, 120_000);
});
