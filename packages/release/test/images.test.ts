import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const appDockerfilePath = join(repositoryRoot, "deploy/docker/Dockerfile");
const cliDockerfilePath = join(repositoryRoot, "deploy/docker/Dockerfile.cli");
const appDockerfile = readFileSync(appDockerfilePath, "utf8");
const cliDockerfile = readFileSync(cliDockerfilePath, "utf8");
const rootManifest = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as {
  devDependencies: Record<string, string>;
  packageManager: string;
};
const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
const noticeGeneratorPath = join(
  repositoryRoot,
  "deploy/docker/generate-third-party-notices.mjs",
);
const licenseExceptions = JSON.parse(
  readFileSync(
    join(repositoryRoot, "deploy/docker/license-exceptions.json"),
    "utf8",
  ),
) as {
  packages: Record<
    string,
    {
      copyright: string;
      sha256: string;
      source: string;
      sourceSha256: string;
      spdx: string;
      textFile: string;
    }
  >;
  tools: Record<
    string,
    {
      license: {
        sha256: string;
        source: string;
        sourceSha256: string;
        textFile: string;
      };
      notice: {
        sha256: string;
        source: string;
        sourceSha256: string;
        textFile: string;
      };
      version: string;
    }
  >;
};
const legalRoot = join(repositoryRoot, "deploy/docker");
const snapshotScriptPath = join(
  repositoryRoot,
  "deploy/docker/configure-snapshot.sh",
);
const snapshotScript = existsSync(snapshotScriptPath)
  ? readFileSync(snapshotScriptPath, "utf8")
  : "";
const imageMatrixPath = join(
  repositoryRoot,
  "deploy/docker/build-matrix.json",
);
const imageMatrix = existsSync(imageMatrixPath)
  ? (JSON.parse(readFileSync(imageMatrixPath, "utf8")) as {
      platforms: string[];
    })
  : { platforms: [] };
const crossBuildScriptPath = join(
  repositoryRoot,
  "deploy/docker/verify-multiarch.sh",
);
const crossBuildScript = existsSync(crossBuildScriptPath)
  ? readFileSync(crossBuildScriptPath, "utf8")
  : "";
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
      expect(dockerfile).not.toMatch(/npm install --global|npm install -g/u);
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).toContain("pnpm --config.ignore-scripts=true");
      expect(dockerfile).not.toContain("prebuild-install");
      expect(dockerfile).toMatch(/ca-certificates=[^\s\\]+/u);
      expect(dockerfile).toContain("ARG DEBIAN_SNAPSHOT=");
      expect(dockerfile).toContain("configure-snapshot.sh");
      expect(dockerfile).not.toMatch(
        /(?:deb\.debian\.org|security\.debian\.org)/u,
      );
      expect(dockerfile).toContain("THIRD_PARTY_NOTICES.md");
      expect(dockerfile).toContain("/app/licenses");
      expect(dockerfile).toContain("COPY deploy/docker/legal");
    }
    expect(appDockerfile).toContain("npm_config_build_from_source=true");
    expect(appDockerfile).toMatch(/ AS native-build/u);
    expect(appDockerfile).toMatch(/python3=[^\s\\]+/u);
    expect(cliDockerfile).not.toMatch(/better-sqlite3|AS native-build|storage-sqlite|storage-postgres/u);
    expect(cliDockerfile).not.toContain("COPY apps/argus");
  });

  it("locks builder tooling with registry integrity", () => {
    expect(rootManifest.packageManager).toMatch(
      /^pnpm@10\.33\.0\+sha512\.[a-f0-9]{128}$/u,
    );
    expect(rootManifest.devDependencies.esbuild).toBe("0.25.10");
    expect(lockfile).toMatch(
      /esbuild:\n\s+specifier: 0\.25\.10\n\s+version: 0\.25\.10/u,
    );
  });

  it("packages every discovered external license file and rejects omissions", () => {
    for (const priorOmission of [
      "@nodable/entities@3.0.0",
      "boolbase@1.0.0",
      "pg-types@2.2.0",
      "pgpass@1.0.5",
      "saxes@6.0.0",
    ]) {
      expect(licenseExceptions.packages).toHaveProperty(priorOmission);
    }
    const fixture = mkdtempSync(join(tmpdir(), "argus-license-fixture-"));
    const modules = join(fixture, "node_modules");
    const output = join(fixture, "output");
    const packageDirectory = join(
      modules,
      ".pnpm/fixture-package@1.2.3/node_modules/fixture-package",
    );
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        version: "1.2.3",
        license: "(MIT OR Apache-2.0)",
      }),
    );
    writeFileSync(join(packageDirectory, "license-mit"), "MIT fixture text");
    writeFileSync(
      join(packageDirectory, "NOTICE.Apache.txt"),
      "Apache fixture text",
    );
    execFileSync(
      "node",
      [
        noticeGeneratorPath,
        modules,
        output,
        "app",
        JSON.stringify({ tini: "9.8.7-test" }),
      ],
      { cwd: repositoryRoot },
    );
    const generatedFiles = execFileSync(
      "find",
      [join(output, "licenses/npm"), "-type", "f"],
      { encoding: "utf8" },
    );
    expect(generatedFiles).toContain("license-mit");
    expect(generatedFiles).toContain("NOTICE.Apache.txt");
    expect(
      readFileSync(join(output, "THIRD_PARTY_NOTICES.md"), "utf8"),
    ).toContain("Tini 9.8.7-test");
    const cliOutput = join(fixture, "cli-output");
    execFileSync(
      "node",
      [
        noticeGeneratorPath,
        modules,
        cliOutput,
        "cli",
        JSON.stringify({ compose: "2.39.1", docker: "29.7.1" }),
      ],
      { cwd: repositoryRoot },
    );
    const cliNotices = readFileSync(
      join(cliOutput, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    expect(cliNotices).toContain("Docker CLI 29.7.1");
    expect(cliNotices).toContain("docker-cli-29.7.1-NOTICE");
    expect(cliNotices).toContain("Docker Compose 2.39.1");
    expect(cliNotices).toContain("docker-compose-2.39.1-NOTICE");
    expect(() =>
      execFileSync(
        "node",
        [
          noticeGeneratorPath,
          modules,
          join(fixture, "mismatched-version-output"),
          "cli",
          JSON.stringify({ compose: "8.7.6-test", docker: "7.6.5-test" }),
        ],
        { cwd: repositoryRoot, stdio: "pipe" },
      ),
    ).toThrow(/version mismatch/u);

    const missingDirectory = join(
      modules,
      ".pnpm/missing-license@1.0.0/node_modules/missing-license",
    );
    mkdirSync(missingDirectory, { recursive: true });
    writeFileSync(
      join(missingDirectory, "package.json"),
      JSON.stringify({
        name: "missing-license",
        version: "1.0.0",
        license: "MIT",
      }),
    );
    expect(() =>
      execFileSync(
        "node",
        [
          noticeGeneratorPath,
          modules,
          join(fixture, "missing-output"),
          "app",
          JSON.stringify({ tini: "9.8.7-test" }),
        ],
        { cwd: repositoryRoot, stdio: "pipe" },
      ),
    ).toThrow(/missing-license@1\.0\.0/u);
    rmSync(fixture, { recursive: true });
  });

  it("verifies exact attributed legal texts and rejects checksum tampering", () => {
    const expectedCopyrights = new Map([
      ["@esbuild/darwin-arm64@0.28.1", "2020 Evan Wallace"],
      ["@esbuild/linux-arm64@0.28.1", "2020 Evan Wallace"],
      ["@esbuild/linux-x64@0.28.1", "2020 Evan Wallace"],
      ["@nodable/entities@3.0.0", "2026 Nodable"],
      ["boolbase@1.0.0", "2014-2015, Felix Boehm"],
      ["pg-types@2.2.0", "2014 Brian M. Carlson"],
      ["pgpass@1.0.5", "2013-2016 Hannes Hörl"],
      ["saxes@6.0.0", "Contributors"],
    ]);
    for (const [packageVersion, identity] of expectedCopyrights) {
      const metadata = licenseExceptions.packages[packageVersion];
      expect(metadata).toBeDefined();
      if (!metadata) throw new Error(`missing metadata for ${packageVersion}`);
      expect(metadata.copyright).toContain(identity);
      expect(metadata.source).toMatch(
        /githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//u,
      );
      expect(metadata.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      const versionSeparator = packageVersion.lastIndexOf("@");
      expect(metadata.textFile).toContain(
        packageVersion
          .slice(0, versionSeparator)
          .replaceAll("/", "__")
          .replaceAll("@", "_"),
      );
      expect(metadata.textFile).toContain(
        `/${packageVersion.slice(versionSeparator + 1)}/`,
      );
      const text = readFileSync(join(legalRoot, metadata.textFile), "utf8");
      expect(text).toContain(identity);
      expect(text).not.toMatch(/<year>|<copyright holders>/u);
      expect(createHash("sha256").update(text).digest("hex")).toBe(
        metadata.sha256,
      );
    }

    for (const [tool, version] of [
      ["docker", "29.7.1"],
      ["compose", "2.39.1"],
    ] as const) {
      const metadata = licenseExceptions.tools[tool];
      if (!metadata) throw new Error(`missing metadata for ${tool}`);
      expect(metadata.version).toBe(version);
      for (const legalFile of [metadata.license, metadata.notice]) {
        expect(legalFile.source).toMatch(
          /githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//u,
        );
        expect(legalFile.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
        const text = readFileSync(join(legalRoot, legalFile.textFile), "utf8");
        expect(createHash("sha256").update(text).digest("hex")).toBe(
          legalFile.sha256,
        );
      }
    }

    const fixture = mkdtempSync(join(tmpdir(), "argus-legal-tamper-"));
    const fixtureLegalRoot = join(fixture, "docker");
    const modules = join(fixture, "node_modules");
    mkdirSync(join(modules, ".pnpm"), { recursive: true });
    cpSync(join(legalRoot, "license-exceptions.json"), join(fixtureLegalRoot, "license-exceptions.json"), {
      recursive: true,
    });
    cpSync(join(legalRoot, "legal"), join(fixtureLegalRoot, "legal"), {
      recursive: true,
    });
    const dockerLegal = licenseExceptions.tools.docker;
    if (!dockerLegal) throw new Error("missing Docker legal metadata");
    const noticePath = join(
      fixtureLegalRoot,
      dockerLegal.notice.textFile,
    );
    writeFileSync(noticePath, `${readFileSync(noticePath, "utf8")}tampered\n`);
    expect(() =>
      execFileSync(
        "node",
        [
          noticeGeneratorPath,
          modules,
          join(fixture, "output"),
          "cli",
          JSON.stringify({ compose: "2.39.1", docker: "29.7.1" }),
          fixtureLegalRoot,
        ],
        { cwd: repositoryRoot, stdio: "pipe" },
      ),
    ).toThrow(/checksum mismatch/u);
    rmSync(fixture, { recursive: true });
  });

  it("uses a dated, signed Debian snapshot with bounded downloads", () => {
    expect(snapshotScript).toMatch(
      /snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\}/u,
    );
    expect(snapshotScript).toMatch(
      /snapshot\.debian\.org\/archive\/debian-security\/\$\{DEBIAN_SNAPSHOT\}/u,
    );
    expect(snapshotScript).toContain(
      "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
    );
    expect(snapshotScript).toMatch(
      /Acquire::Check-Valid-Until\s+"false"/u,
    );
    expect(snapshotScript).toMatch(/Acquire::http::Timeout\s+"30"/u);
    expect(snapshotScript).not.toMatch(/trusted=yes|allow-unauthenticated/u);
    expect(snapshotScript).not.toMatch(
      /(?:deb\.debian\.org|security\.debian\.org)/u,
    );
  });

  it("declares both release architectures for opt-in buildx verification", () => {
    expect(imageMatrix.platforms).toEqual(["linux/amd64", "linux/arm64"]);
    expect(crossBuildScript).toContain(
      "build-matrix.json",
    );
    expect(crossBuildScript).not.toContain("linux/amd64,linux/arm64");
    expect(crossBuildScript).toContain("docker buildx build");
    expect(crossBuildScript).toContain("Dockerfile.cli");
    expect(crossBuildScript).toContain("ARGUS_IMAGE_BUILD_TIMEOUT_SECONDS");
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
const resourceSuffix = `${process.pid}-${randomUUID()}`;
const appImage = `argus-app:image-test-${resourceSuffix}`;
const cliImage = `argus-cli:image-test-${resourceSuffix}`;
const containerName = `argus-image-test-${resourceSuffix}`;
const dataVolume = `argus-image-test-data-${resourceSuffix}`;
let fixtureDirectory: string | undefined;
let wrapperFixtureDirectory: string | undefined;
let appImageOwned = false;
let cliImageOwned = false;
let containerOwned = false;
let volumeOwned = false;

live("built production images", () => {
  beforeAll(async () => {
    for (const [kind, name] of [
      ["image", appImage],
      ["image", cliImage],
      ["container", containerName],
      ["volume", dataVolume],
    ] as const) {
      expect(
        spawnSync("docker", [kind, "inspect", name], {
          cwd: repositoryRoot,
          stdio: "ignore",
          timeout: 30_000,
        }).status,
      ).not.toBe(0);
    }
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
    appImageOwned = true;
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
    cliImageOwned = true;
  }, 1_200_000);

  afterAll(() => {
    const cleanupErrors: Error[] = [];
    const cleanup = (arguments_: string[]) => {
      try {
        docker(arguments_, 30_000);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };
    if (containerOwned) cleanup(["container", "rm", "--force", containerName]);
    if (volumeOwned) cleanup(["volume", "rm", dataVolume]);
    if (appImageOwned) cleanup(["image", "rm", appImage]);
    if (cliImageOwned) cleanup(["image", "rm", cliImage]);
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true });
    if (wrapperFixtureDirectory) {
      rmSync(wrapperFixtureDirectory, { recursive: true });
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "owned Docker resource cleanup failed");
    }
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
    containerOwned = true;
    volumeOwned = true;

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
    expect(
      docker([
        "exec",
        containerName,
        "test",
        "!",
        "-e",
        "/usr/local/bin/configure-snapshot.sh",
      ]),
    ).toBe("");
    expect(
      docker([
        "exec",
        containerName,
        "node",
        "-e",
        `const{spawn}=require('node:child_process');const http=require('node:http');const fail=setTimeout(()=>process.exit(1),10000);const server=http.createServer((_,res)=>{res.setHeader('access-control-allow-origin','null');res.end('argus-worker-ok')});server.listen(0,'127.0.0.1',()=>{const port=server.address().port;const child=spawn(process.execPath,['/app/apps/argus/dist/xhr-sync-worker.js']);let out='';child.stdout.on('data',x=>out+=x);child.on('exit',code=>{server.close(()=>{clearTimeout(fail);const payload=JSON.parse(out);const text=Buffer.from(payload.properties.responseBuffer.data).subarray(0,payload.properties.totalReceivedChunkSize).toString();if(code!==0||payload.status!==200||text!=='argus-worker-ok')process.exit(1)})});child.stdin.end(JSON.stringify({method:'GET',uri:\`http://127.0.0.1:\${port}/\`,requestHeaders:{},body:null}))})`,
      ]),
    ).toBe("");
    expect(
      docker([
        "exec",
        containerName,
        "node",
        "-e",
        "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close()",
      ]),
    ).toBe("");
    expect(
      docker([
        "run",
        "--rm",
        "--entrypoint",
        "test",
        cliImage,
        "!",
        "-e",
        "/usr/local/bin/configure-snapshot.sh",
      ]),
    ).toBe("");
    expect(
      docker([
        "exec",
        containerName,
        "sh",
        "-c",
        "! find /app/node_modules -type f \\( -name '*.gyp' -o -name '*.cpp' -o -name '*.c' -o -name '*.h' \\) | grep .",
      ]),
    ).toBe("");
    const notices = docker([
      "exec",
      containerName,
      "cat",
      "/app/THIRD_PARTY_NOTICES.md",
    ]);
    for (const dependency of ["hono@", "yaml@", "zod@", "better-sqlite3@", "Tini"]) {
      expect(notices).toContain(dependency);
    }
    expect(
      docker([
        "exec",
        containerName,
        "sh",
        "-c",
        "grep -R -F 'Copyright (c) 2020 Evan Wallace' /app/licenses/npm >/dev/null && grep -R -F 'Copyright (c) 2026 Nodable' /app/licenses/npm >/dev/null",
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
    wrapperFixtureDirectory = mkdtempSync(
      join(tmpdir(), "argus-wrapper-image-"),
    );
    chmodSync(wrapperFixtureDirectory, 0o755);
    writeFileSync(
      join(wrapperFixtureDirectory, "compose.yaml"),
      `services:
  probe:
    image: example.invalid/argus-compose-probe:fixture
    command: ["true"]
`,
      { mode: 0o644 },
    );
    const wrapperProject = `argus-wrapper-${resourceSuffix}`;
    const hostArchitecture = arch() === "x64" ? "amd64" : "arm64";
    expect(
      docker([
        "run",
        "--rm",
        "--network",
        "host",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--volume",
        "/etc/os-release:/host/etc/os-release:ro",
        "--volume",
        "/proc/meminfo:/host/proc/meminfo:ro",
        "--volume",
        `${wrapperFixtureDirectory}:/opt/argus:rw`,
        "--volume",
        "/var/run/docker.sock:/var/run/docker.sock:rw",
        "--env",
        "ARGUS_INSTALL_ROOT=/opt/argus",
        "--env",
        `ARGUS_HOST_ARCH=${hostArchitecture}`,
        "--env",
        "ARGUS_VERSION=0.1.0-test",
        "--entrypoint",
        "sh",
        cliImage,
        "-eu",
        "-c",
        `printf wrapper-write-ok > /opt/argus/write-proof
docker version --format '{{.Server.Version}}'
cd /opt/argus
docker compose --project-name '${wrapperProject}' config --quiet
docker compose --project-name '${wrapperProject}' down --remove-orphans >/dev/null 2>&1`,
      ]),
    ).toMatch(/^\d+\.\d+\.\d+/u);
    expect(
      readFileSync(join(wrapperFixtureDirectory, "write-proof"), "utf8"),
    ).toBe("wrapper-write-ok");
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
    const notices = docker([
      "run",
      "--rm",
      "--entrypoint",
      "cat",
      cliImage,
      "/app/THIRD_PARTY_NOTICES.md",
    ]);
    for (const dependency of ["Docker CLI", "Docker Compose", "better-sqlite3@"]) {
      expect(notices).toContain(dependency);
    }
    expect(
      docker([
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        cliImage,
        "-c",
        "test -s /app/licenses/tools/docker-cli-29.7.1-LICENSE && test -s /app/licenses/tools/docker-cli-29.7.1-NOTICE && test -s /app/licenses/tools/docker-compose-2.39.1-LICENSE && test -s /app/licenses/tools/docker-compose-2.39.1-NOTICE && grep -F 'Copyright 2012-2017 Docker, Inc.' /app/licenses/tools/docker-cli-29.7.1-NOTICE >/dev/null && grep -F 'Copyright 2020 Docker Compose authors' /app/licenses/tools/docker-compose-2.39.1-NOTICE >/dev/null",
      ]),
    ).toBe("");
  }, 120_000);
});
