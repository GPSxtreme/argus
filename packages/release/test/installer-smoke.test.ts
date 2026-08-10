import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");

const read = (path: string): Promise<string> =>
  readFile(resolve(root, path), "utf8");

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const releaseSha = "a".repeat(40);
const fixtureQuiescenceAttempts = 5;
const fixtureQuiescencePhases = 2;
const fixtureSnapshotTimeoutSeconds = 1;
const fixtureSchedulingMarginMs = 5_000;
const fixtureProcessDeadlineMs =
  fixtureQuiescencePhases *
    fixtureQuiescenceAttempts *
    fixtureSnapshotTimeoutSeconds *
    1_000 +
  fixtureSchedulingMarginMs;
const fixtureTestDeadlineMs = fixtureProcessDeadlineMs + 5_000;
const quiescenceFixtureTestDeadlineMs = 15_000;
const fixtureTimingEnvironment = ({
  settleSeconds = "0.01",
  timeoutSeconds = String(fixtureSnapshotTimeoutSeconds),
}: {
  settleSeconds?: string;
  timeoutSeconds?: string;
} = {}): Record<string, string> => ({
  ARGUS_INSTALL_FIXTURE: "1",
  ARGUS_DAEMON_SETTLE_SECONDS: settleSeconds,
  ARGUS_SNAPSHOT_TIMEOUT_SECONDS: timeoutSeconds,
});
const quiescenceWorkBudgetMs = (
  settleSeconds: string,
  timeoutSeconds: string,
): number =>
  Math.ceil(
    (fixtureQuiescenceAttempts * Number(timeoutSeconds) +
      (fixtureQuiescenceAttempts - 1) * Number(settleSeconds)) *
      1_000,
  ) + fixtureSchedulingMarginMs;
const quiescenceProcessDeadlineMs = (
  settleSeconds: string,
  timeoutSeconds: string,
): number =>
  Math.max(
    10_000,
    quiescenceWorkBudgetMs(settleSeconds, timeoutSeconds),
  );

const writeJson = async (
  directory: string,
  name: string,
  value: unknown,
): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value));
  return path;
};

const runQuiescenceFixture = async ({
  findSource = 'exec /usr/bin/find "$@"',
  timeoutSource = 'shift 3\nexec "$@"',
  settleSeconds = "0.05",
  timeoutSeconds = "0.2",
}: {
  findSource?: string;
  timeoutSource?: string;
  settleSeconds?: string;
  timeoutSeconds?: string;
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "argus-quiescence-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const systemRoot = join(directory, "host");
  const sequence = join(directory, "sequence");
  const fakeInstaller = join(directory, "install.sh");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(join(systemRoot, "var/lib/docker"), { recursive: true }),
    mkdir(join(systemRoot, "var/lib/containerd"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(systemRoot, "var/lib/docker/state"), "stable\n"),
    writeFile(join(systemRoot, "var/lib/containerd/state"), "stable\n"),
    writeFile(fakeInstaller, "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
  ]);
  const command = async (name: string, source: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${source}\n`);
    await chmod(path, 0o755);
  };
  await command("id", 'test "$1" = -u && printf "0\\n"');
  await command(
    "curl",
    `while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift 2; continue; fi
  shift
done
cp "$ARGUS_FAKE_INSTALLER" "$output"`,
  );
  for (const name of ["expect", "jq", "openssl"]) await command(name, "exit 99");
  await command("find", findSource);
  await command("timeout", timeoutSource);
  await command(
    "sleep",
    `printf 'sleep\\n' >> "$ARGUS_SEQUENCE"
exec /bin/sleep "$@"`,
  );
  const started = Date.now();
  const result = spawnSync(
    "/bin/sh",
    [resolve(root, "scripts/e2e/installer-smoke.sh")],
    {
      encoding: "utf8",
      timeout: quiescenceProcessDeadlineMs(settleSeconds, timeoutSeconds),
      env: {
        PATH: `${bin}:/usr/bin:/bin:/sbin`,
        TMPDIR: directory,
        ARGUS_FAKE_INSTALLER: fakeInstaller,
        ARGUS_SEQUENCE: sequence,
        ARGUS_SMOKE_SYSTEM_ROOT: systemRoot,
        ARGUS_QUIESCENCE_TEST_ONLY: "1",
        ...fixtureTimingEnvironment({ settleSeconds, timeoutSeconds }),
        ARGUS_INSTALLER_URL: "https://example.com/release/install.sh",
        ARGUS_MANIFEST_URL: "https://example.com/release/manifest.json",
        ARGUS_EXPECTED_VERSION: "1.2.3",
        ARGUS_EXPECTED_WRAPPER_SHA256: "a".repeat(64),
        ARGUS_EXPECTED_CLI_IMAGE: `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`,
        ARGUS_SMOKE_ARTIFACT_DIR: join(directory, "artifacts"),
      },
    },
  );
  return { result, elapsedMs: Date.now() - started, sequence, directory };
};

const resolveSource = async (overrides?: {
  releaseTag?: string;
  runTag?: string;
  runSha?: string;
  runs?: unknown;
  tagRef?: unknown;
  tagObjects?: unknown;
}) => {
  const directory = await mkdtemp(join(tmpdir(), "argus-smoke-source-"));
  temporaryDirectories.push(directory);
  const publishedAt = "2026-08-01T12:00:00Z";
  const releasePath = await writeJson(directory, "release.json", {
    tag_name: overrides?.releaseTag ?? "v1.2.3",
    draft: false,
    published_at: publishedAt,
  });
  const releaseRun = {
    path: ".github/workflows/release.yml",
    event: "push",
    conclusion: "success",
    head_branch: overrides?.runTag ?? "v1.2.3",
    head_sha: overrides?.runSha ?? releaseSha,
    created_at: "2026-08-01T11:55:00Z",
    updated_at: "2026-08-01T12:05:00Z",
  };
  const runsPath = await writeJson(
    directory,
    "runs.json",
    overrides?.runs ?? [{ workflow_runs: [releaseRun] }],
  );
  const tagRefPath = await writeJson(
    directory,
    "tag-ref.json",
    overrides?.tagRef ?? {
      ref: "refs/tags/v1.2.3",
      object: { type: "commit", sha: releaseSha },
    },
  );
  const tagObjectsPath = await writeJson(
    directory,
    "tag-objects.json",
    overrides?.tagObjects ?? [],
  );
  return spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/e2e/resolve-installer-source.mjs"),
      "--tag",
      "v1.2.3",
      "--release",
      releasePath,
      "--runs",
      runsPath,
      "--tag-ref",
      tagRefPath,
      "--tag-objects",
      tagObjectsPath,
    ],
    { encoding: "utf8" },
  );
};

const resolveWorkflowRun = (conclusion: string) =>
  spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/e2e/resolve-installer-source.mjs"),
      "--workflow-run-sha",
      releaseSha,
      "--workflow-run-conclusion",
      conclusion,
    ],
    { encoding: "utf8" },
  );

describe("clean-host installer smoke contract", () => {
  it("pins vfs only for Docker installed inside the nested clean host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-nested-docker-"));
    temporaryDirectories.push(directory);
    const absentRoot = join(directory, "absent");
    const presentRoot = join(directory, "present");
    await Promise.all([
      mkdir(absentRoot, { recursive: true }),
      mkdir(join(presentRoot, "etc/docker"), { recursive: true }),
    ]);
    const presentConfig = join(presentRoot, "etc/docker/daemon.json");
    await writeFile(presentConfig, '{"storage-driver":"overlay2"}\n');
    const configure = resolve(
      root,
      "scripts/e2e/configure-nested-docker-storage.sh",
    );

    const absent = spawnSync("/bin/sh", [configure, "absent"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARGUS_INSTALL_FIXTURE: "1",
        ARGUS_NESTED_DOCKER_ROOT: absentRoot,
      },
    });
    expect(absent).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(
      await readFile(join(absentRoot, "etc/docker/daemon.json"), "utf8"),
    ).toBe('{"storage-driver":"vfs"}\n');

    const second = spawnSync("/bin/sh", [configure, "absent"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARGUS_INSTALL_FIXTURE: "1",
        ARGUS_NESTED_DOCKER_ROOT: absentRoot,
      },
    });
    expect(second).toMatchObject({ status: 0, stdout: "", stderr: "" });

    const present = spawnSync("/bin/sh", [configure, "present"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARGUS_INSTALL_FIXTURE: "1",
        ARGUS_NESTED_DOCKER_ROOT: presentRoot,
      },
    });
    expect(present).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(await readFile(presentConfig, "utf8")).toBe(
      '{"storage-driver":"overlay2"}\n',
    );
  });

  it(
    "waits a real settle interval before accepting the first stable pair",
    async () => {
      const { result, elapsedMs, sequence } = await runQuiescenceFixture();
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(await readFile(sequence, "utf8")).toBe("sleep\n");
      expect(elapsedMs).toBeGreaterThanOrEqual(40);
    },
    quiescenceFixtureTestDeadlineMs,
  );

  it.runIf(process.platform === "linux")(
    "hard-times out stalled traversal and leaves no late child",
    async () => {
      const childPid = join(tmpdir(), `argus-stalled-child-${process.pid}`);
      const { result, elapsedMs } = await runQuiescenceFixture({
        timeoutSource: 'exec /usr/bin/timeout "$@"',
        timeoutSeconds: "0.1",
        settleSeconds: "0.01",
        findSource: `case "\${1:-}" in
  */var/lib/docker)
    /bin/sleep 30 &
    child=$!
    printf '%s\\n' "$child" > "${childPid}"
    wait "$child"
    ;;
  *) exec /usr/bin/find "$@" ;;
esac`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Docker daemon data did not reach a stable clean-host snapshot",
      );
      expect(elapsedMs).toBeLessThan(
        quiescenceWorkBudgetMs("0.01", "0.1"),
      );
      const pid = Number((await readFile(childPid, "utf8")).trim());
      const alive = spawnSync("/bin/kill", ["-0", String(pid)]);
      expect(alive.status).not.toBe(0);
      await rm(childPid);
    },
    quiescenceFixtureTestDeadlineMs,
  );

  it("fails evidence when the upstream signed release did not succeed", () => {
    expect(resolveWorkflowRun("success")).toMatchObject({
      status: 0,
      stdout: `${releaseSha}\n`,
      stderr: "",
    });
    const failed = resolveWorkflowRun("failure");
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("signed release workflow did not succeed");
  });

  it("binds manual dispatch to the exact commit of the successful signed release", async () => {
    const result = await resolveSource();
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toBe(`${releaseSha}\n`);
  });

  it.each([
    [
      "moved tag",
      {
        tagRef: {
          ref: "refs/tags/v1.2.3",
          object: { type: "commit", sha: "b".repeat(40) },
        },
      },
      "tag commit does not match",
    ],
    [
      "mismatched release",
      { releaseTag: "v9.9.9" },
      "release tag does not match",
    ],
    [
      "mismatched workflow run",
      { runTag: "v9.9.9" },
      "no unique successful signed release run",
    ],
  ] as const)("rejects %s before checkout", async (_name, overrides, message) => {
    const result = await resolveSource(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it("rejects a second matching release run hidden on a later API page", async () => {
    const matchingRun = {
      path: ".github/workflows/release.yml",
      event: "push",
      conclusion: "success",
      head_branch: "v1.2.3",
      head_sha: releaseSha,
      created_at: "2026-08-01T11:55:00Z",
      updated_at: "2026-08-01T12:05:00Z",
    };
    const result = await resolveSource({
      runs: [
        { total_count: 101, workflow_runs: [matchingRun] },
        { total_count: 101, workflow_runs: [matchingRun] },
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "no unique successful signed release run contains this publication",
    );
  });

  it("peels the explicit annotated tag ref without resolving a same-named branch", async () => {
    const annotatedSha = "b".repeat(40);
    const result = await resolveSource({
      tagRef: {
        ref: "refs/tags/v1.2.3",
        object: { type: "tag", sha: annotatedSha },
      },
      tagObjects: [
        {
          sha: annotatedSha,
          object: { type: "commit", sha: releaseSha },
        },
      ],
    });
    expect(result).toMatchObject({
      status: 0,
      stdout: `${releaseSha}\n`,
      stderr: "",
    });
  });

  it.each([
    [
      "an unexpected ref",
      {
        tagRef: {
          ref: "refs/heads/v1.2.3",
          object: { type: "commit", sha: releaseSha },
        },
      },
      "tag ref metadata is invalid",
    ],
    [
      "an annotated tag cycle",
      {
        tagRef: {
          ref: "refs/tags/v1.2.3",
          object: { type: "tag", sha: "b".repeat(40) },
        },
        tagObjects: [
          {
            sha: "b".repeat(40),
            object: { type: "tag", sha: "b".repeat(40) },
          },
        ],
      },
      "annotated tag cycle",
    ],
    [
      "a non-commit target",
      {
        tagRef: {
          ref: "refs/tags/v1.2.3",
          object: { type: "tree", sha: "b".repeat(40) },
        },
      },
      "tag does not resolve to a commit",
    ],
  ] as const)("rejects %s", async (_name, overrides, message) => {
    const result = await resolveSource(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it("rejects incomplete and excessively deep annotated tag chains", async () => {
    const firstTagSha = "b".repeat(40);
    const incomplete = await resolveSource({
      tagRef: {
        ref: "refs/tags/v1.2.3",
        object: { type: "tag", sha: firstTagSha },
      },
    });
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain("annotated tag metadata is incomplete");

    const tagShas = Array.from({ length: 17 }, (_, index) =>
      (index + 11).toString(16).padStart(40, "0"),
    );
    const excessive = await resolveSource({
      tagRef: {
        ref: "refs/tags/v1.2.3",
        object: { type: "tag", sha: tagShas[0] },
      },
      tagObjects: tagShas.map((sha, index) => ({
        sha,
        object: {
          type: index === tagShas.length - 1 ? "commit" : "tag",
          sha:
            index === tagShas.length - 1
              ? releaseSha
              : tagShas[index + 1],
        },
      })),
    });
    expect(excessive.status).not.toBe(0);
    expect(excessive.stderr).toContain(
      "annotated tag depth exceeds safety limit",
    );
  });

  it("keeps repeated snapshots stable on a Docker-present fixture before mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-smoke-inspect-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, "bin");
    const artifacts = join(directory, "artifacts");
    const sequence = join(directory, "sequence");
    const systemRoot = join(directory, "host");
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(systemRoot, "var/lib/docker"), { recursive: true }),
      mkdir(join(systemRoot, "var/lib/containerd"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(systemRoot, "var/lib/docker/state"), "stable\n"),
      writeFile(join(systemRoot, "var/lib/containerd/state"), "stable\n"),
    ]);
    const command = async (name: string, source: string) => {
      const path = join(bin, name);
      await writeFile(path, `#!/bin/sh\n${source}\n`);
      await chmod(path, 0o755);
    };
    await command("id", 'test "$1" = -u && printf "0\\n"');
    await command(
      "timeout",
      'shift 3\nexec "$@"',
    );
    await command(
      "curl",
      `while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift 2; continue; fi
  shift
done
cp "$ARGUS_FAKE_INSTALLER" "$output"`,
    );
    for (const name of ["expect", "jq", "openssl"]) {
      await command(name, "exit 99");
    }
    await command(
      "docker",
      `case "\${1:-}" in
  --version) printf 'Docker fixture\\n' ;;
  info) printf 'daemon-fixture\\n' ;;
  compose) printf 'compose-fixture\\n' ;;
  *) exit 1 ;;
esac`,
    );
    await command("systemctl", "printf 'active\\nenabled\\n'");
    const fakeInstaller = join(directory, "install.sh");
    await writeFile(
      fakeInstaller,
      `#!/bin/sh
if [ "\${ARGUS_INSTALL_INSPECT:-0}" = 1 ]; then
  printf 'inspect\\n' >> "$ARGUS_INSPECT_SEQUENCE"
  printf '%s\\n' \
    'Argus installer inspection' \
    '  signed manifest: https://example.com/release/manifest.json' \
    '  target: /usr/local/bin/argus' \
    'No files were downloaded or changed.'
  exit 0
fi
printf 'mutation\\n' >> "$ARGUS_INSPECT_SEQUENCE"
exit 42
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      "/bin/sh",
      [resolve(root, "scripts/e2e/installer-smoke.sh")],
      {
        encoding: "utf8",
        timeout: fixtureProcessDeadlineMs,
        env: {
          PATH: `${bin}:/usr/bin:/bin:/sbin`,
          TMPDIR: directory,
          ARGUS_FAKE_INSTALLER: fakeInstaller,
          ARGUS_INSPECT_SEQUENCE: sequence,
          ARGUS_SMOKE_SYSTEM_ROOT: systemRoot,
          ARGUS_INSTALLER_URL: "https://example.com/release/install.sh",
          ARGUS_MANIFEST_URL: "https://example.com/release/manifest.json",
          ARGUS_EXPECTED_VERSION: "1.2.3",
          ARGUS_EXPECTED_WRAPPER_SHA256: "a".repeat(64),
          ARGUS_EXPECTED_CLI_IMAGE: `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`,
          ARGUS_SMOKE_ARTIFACT_DIR: artifacts,
          ...fixtureTimingEnvironment(),
        },
      },
    );
    expect(result.status).toBe(42);
    expect(await readFile(sequence, "utf8")).toBe("inspect\nmutation\n");
    expect(await readFile(join(artifacts, "installer.log"), "utf8")).toContain(
      "No files were downloaded or changed.",
    );
  }, fixtureTestDeadlineMs);

  it.each([
    "file",
    "metadata",
    "package",
    "docker",
    "docker-binary",
    "service-unit",
    "apt-metadata",
    "lock-temp-docker-absent",
    "docker-data-content",
    "docker-data-metadata",
    "containerd-data",
    "containerd-config",
    "containerd-service-unit",
    "daemon-data-docker-absent",
  ] as const)(
    "fails inspection when inspect mode mutates %s state",
    async (mutation) => {
      const directory = await mkdtemp(
        join(tmpdir(), `argus-smoke-${mutation}-mutation-`),
      );
      temporaryDirectories.push(directory);
      const bin = join(directory, "bin");
      const artifacts = join(directory, "artifacts");
      const systemRoot = join(directory, "host");
      const packageMarker = join(directory, "package-mutated");
      const dockerMarker = join(directory, "docker-mutated");
      const dockerAbsent =
        mutation === "lock-temp-docker-absent" ||
        mutation === "daemon-data-docker-absent";
      await mkdir(join(systemRoot, "opt/argus"), { recursive: true });
      await writeFile(
        join(systemRoot, "opt/argus/baseline"),
        "unchanged before inspect\n",
      );
      await mkdir(join(systemRoot, "etc/apt/sources.list.d"), {
        recursive: true,
      });
      await mkdir(join(systemRoot, "etc/apt/keyrings"), { recursive: true });
      await mkdir(join(systemRoot, "var/lib/apt/lists"), { recursive: true });
      await mkdir(join(systemRoot, "var/cache/apt"), { recursive: true });
      await mkdir(join(systemRoot, "usr/local/bin"), { recursive: true });
      await mkdir(join(systemRoot, "var/lib/dpkg"), { recursive: true });
      if (mutation !== "daemon-data-docker-absent") {
        await mkdir(join(systemRoot, "var/lib/docker"), { recursive: true });
        await mkdir(join(systemRoot, "var/lib/containerd"), {
          recursive: true,
        });
      }
      await mkdir(join(systemRoot, "etc/containerd"), { recursive: true });
      await mkdir(
        join(systemRoot, "usr/lib/systemd/system/docker.service.d"),
        { recursive: true },
      );
      await mkdir(join(systemRoot, "usr/lib/systemd/system"), {
        recursive: true,
      });
      await mkdir(join(systemRoot, "tmp"), { recursive: true });
      await writeFile(
        join(systemRoot, "var/lib/apt/lists/packages"),
        "base apt metadata\n",
      );
      await writeFile(
        join(
          systemRoot,
          "usr/lib/systemd/system/docker.service.d/override.conf",
        ),
        "[Service]\nEnvironment=BASE=1\n",
      );
      if (mutation !== "daemon-data-docker-absent") {
        await writeFile(
          join(systemRoot, "var/lib/docker/state.db"),
          "stable docker daemon state\n",
        );
        await writeFile(
          join(systemRoot, "var/lib/containerd/state.db"),
          "stable containerd daemon state\n",
        );
      }
      await writeFile(
        join(systemRoot, "etc/containerd/config.toml"),
        "version = 2\n",
      );
      await writeFile(
        join(systemRoot, "usr/lib/systemd/system/containerd.service"),
        "[Service]\nExecStart=/usr/bin/containerd\n",
      );
      await mkdir(bin, { recursive: true });
      const command = async (name: string, source: string) => {
        const path = join(bin, name);
        await writeFile(path, `#!/bin/sh\n${source}\n`);
        await chmod(path, 0o755);
      };
      await command("id", 'test "$1" = -u && printf "0\\n"');
      await command(
        "timeout",
        'shift 3\nexec "$@"',
      );
      await command(
        "curl",
        `while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift 2; continue; fi
  shift
done
cp "$ARGUS_FAKE_INSTALLER" "$output"`,
      );
      for (const name of ["expect", "jq", "openssl"]) {
        await command(name, "exit 99");
      }
      await command(
        "dpkg-query",
        `if [ -e "$ARGUS_PACKAGE_MARKER" ]; then
  printf 'ii  mutated 2.0 amd64\\n'
else
  printf 'ii  base 1.0 amd64\\n'
fi`,
      );
      await command(
        "apt-mark",
        `if [ -e "$ARGUS_PACKAGE_MARKER" ]; then
  printf 'mutated\\n'
else
  printf 'base\\n'
fi`,
      );
      if (!dockerAbsent) {
        await command(
          "docker",
          `if [ -e "$ARGUS_DOCKER_MARKER" ]; then version=mutated; else version=base; fi
case "\${1:-}" in
  --version) printf 'Docker %s\\n' "$version" ;;
  info) printf 'daemon-%s\\n' "$version" ;;
  compose) printf 'compose-%s\\n' "$version" ;;
  *) exit 1 ;;
esac`,
        );
      }
      await command("systemctl", "printf 'active\\nenabled\\n'");

      const mutationCommand = {
        file: `printf 'changed by inspect\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/opt/argus/baseline"`,
        metadata: 'chmod 0700 "$ARGUS_SMOKE_SYSTEM_ROOT/opt/argus"',
        package: 'touch "$ARGUS_PACKAGE_MARKER"',
        docker: 'touch "$ARGUS_DOCKER_MARKER"',
        "docker-binary":
          'printf "# same-output replacement\\n" >> "$ARGUS_DOCKER_BINARY"',
        "service-unit": `printf '[Service]\\nEnvironment=CHANGED=1\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/usr/lib/systemd/system/docker.service.d/override.conf"`,
        "apt-metadata": `printf 'changed apt metadata\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/var/lib/apt/lists/packages"`,
        "lock-temp-docker-absent":
          'touch "$ARGUS_SMOKE_SYSTEM_ROOT/tmp/argus-install.mutated"',
        "docker-data-content": `printf 'changed docker daemon state\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/var/lib/docker/state.db"`,
        "docker-data-metadata":
          'chmod 0600 "$ARGUS_SMOKE_SYSTEM_ROOT/var/lib/docker/state.db"',
        "containerd-data": `printf 'changed containerd daemon state\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/var/lib/containerd/state.db"`,
        "containerd-config": `printf 'version = 3\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/etc/containerd/config.toml"`,
        "containerd-service-unit":
          'chmod 0600 "$ARGUS_SMOKE_SYSTEM_ROOT/usr/lib/systemd/system/containerd.service"',
        "daemon-data-docker-absent": `mkdir -p \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/var/lib/docker"
printf 'created while absent\\n' > \\
  "$ARGUS_SMOKE_SYSTEM_ROOT/var/lib/docker/state.db"`,
      }[mutation];
      const fakeInstaller = join(directory, "install.sh");
      await writeFile(
        fakeInstaller,
        `#!/bin/sh
if [ "\${ARGUS_INSTALL_INSPECT:-0}" = 1 ]; then
  ${mutationCommand}
  printf '%s\\n' \
    'Argus installer inspection' \
    '  signed manifest: https://example.com/release/manifest.json' \
    '  target: /usr/local/bin/argus' \
    'No files were downloaded or changed.'
  exit 0
fi
exit 42
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "/bin/sh",
        [resolve(root, "scripts/e2e/installer-smoke.sh")],
        {
          encoding: "utf8",
          timeout: fixtureProcessDeadlineMs,
          env: {
            PATH: `${bin}:/usr/bin:/bin:/sbin`,
            TMPDIR: join(systemRoot, "tmp"),
            ARGUS_FAKE_INSTALLER: fakeInstaller,
            ARGUS_PACKAGE_MARKER: packageMarker,
            ARGUS_DOCKER_MARKER: dockerMarker,
            ARGUS_DOCKER_BINARY: join(bin, "docker"),
            ARGUS_SMOKE_SYSTEM_ROOT: systemRoot,
            ARGUS_INSTALLER_URL: "https://example.com/release/install.sh",
            ARGUS_MANIFEST_URL: "https://example.com/release/manifest.json",
            ARGUS_EXPECTED_VERSION: "1.2.3",
            ARGUS_EXPECTED_WRAPPER_SHA256: "a".repeat(64),
            ARGUS_EXPECTED_CLI_IMAGE: `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`,
            ARGUS_SMOKE_ARTIFACT_DIR: artifacts,
            ...fixtureTimingEnvironment(),
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "installer inspection mutated protected host state",
      );
    },
    fixtureTestDeadlineMs,
  );

  it("installs the exact signed wrapper and management state twice before onboarding", async () => {
    const smoke = await read("scripts/e2e/installer-smoke.sh");

    expect(smoke).toMatch(/^#!\/bin\/sh\nset -eu\n/u);
    for (const required of [
      "ARGUS_INSTALLER_URL",
      "ARGUS_MANIFEST_URL",
      "ARGUS_EXPECTED_VERSION",
      "ARGUS_EXPECTED_WRAPPER_SHA256",
      "ARGUS_EXPECTED_CLI_IMAGE",
    ]) {
      expect(smoke).toContain(required);
    }
    expect(
      smoke.match(/ARGUS_INSTALL_INSPECT=0 sh "\$argus_installer"/gu),
    ).toHaveLength(2);
    expect(smoke).toContain("ARGUS_INSTALL_INSPECT=1");
    expect(smoke).toMatch(
      /argus_snapshot_timeout=10\nargus_daemon_settle=1\nif \[ "\$\{ARGUS_INSTALL_FIXTURE:-0\}" = 1 \]; then/u,
    );
    expect(smoke).toContain(
      'timeout --signal=TERM --kill-after=1 "$argus_snapshot_timeout" "$@"',
    );
    expect(smoke).toContain("No files were downloaded or changed.");
    expect(smoke).toContain("sha256sum");
    expect(smoke).toContain("cmp -s");
    expect(smoke).toContain("argus --version");
    expect(smoke).toContain("argus_management_state=/opt/argus/management.state");
    expect(smoke).toContain("argus_management_state_mode");
    expect(smoke).toContain("schema=1");
    expect(smoke).toContain('"$argus_management_cli_image" = "cli_image=$ARGUS_EXPECTED_CLI_IMAGE"');
    expect(smoke).toContain("management state has unexpected extra content");
    expect(smoke).toContain("second installation changed management state");
    expect(smoke).toContain("argus onboard --from");
    expect(smoke).toContain("https://example.com/");
    expect(smoke).toContain("argus doctor --json");
    expect(smoke).toContain(".ok == true");
    expect(smoke).toContain(".data.healthy == true");
    expect(smoke).toContain(".argusVersion == $version");
    expect(smoke).toContain("refusing non-clean host");
    expect(smoke).toContain(": > \"$argus_artifacts/installer.log\"");
    expect(smoke).not.toMatch(
      /(?:OPENROUTER|TELEGRAM|CLOUDFLARE|ARGUS_RELEASE_ED25519_KEY)=/u,
    );
  });

  it("defines pinned OS and architecture coverage with sanitized artifacts", async () => {
    const source = await read(".github/workflows/installer-smoke.yml");
    const workflow = parse(source) as {
      jobs?: {
        smoke?: {
          strategy?: { matrix?: { include?: unknown[] } };
          steps?: Array<Record<string, unknown>>;
        };
      };
    };
    const smoke = workflow.jobs?.smoke;
    const matrix = smoke?.strategy?.matrix?.include;
    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          os: "ubuntu-22.04",
          arch: "amd64",
          docker: "present",
        }),
        expect.objectContaining({
          os: "ubuntu-24.04",
          arch: "amd64",
          docker: "absent",
        }),
        expect.objectContaining({
          os: "ubuntu-24.04",
          arch: "arm64",
          docker: "present",
        }),
        expect.objectContaining({
          os: "debian-12",
          arch: "amd64",
          docker: "present",
        }),
        expect.objectContaining({
          os: "debian-13",
          arch: "arm64",
          docker: "absent",
        }),
      ]),
    );
    expect(source).toMatch(
      /actions\/checkout@[a-f0-9]{40}\s+#\s+v[0-9]/u,
    );
    expect(source).toMatch(
      /(?:ubuntu|debian)@sha256:[a-f0-9]{64}/u,
    );
    expect(source).toContain("workflow_run:");
    expect(source).toContain(
      "scripts/e2e/configure-nested-docker-storage.sh",
    );
    expect(source).toContain(
      '"$CONTAINER" sh /workspace/trusted-smoke/scripts/e2e/configure-nested-docker-storage.sh "$DOCKER_MODE"',
    );
    expect(source).toContain('workflows: ["Signed release"]');
    expect(source).toContain("resolve-installer-source.mjs");
    expect(source).not.toContain(
      'source_ref="$' + '{WORKFLOW_SHA:-$RELEASE_TAG}"',
    );
    expect(source).toContain(
      "ref: $" + "{{ needs.candidate.outputs.source_ref }}",
    );
    expect(source).toContain("install -m 0600 /dev/null");
    expect(source).toContain("sudo chown");
    expect(source).toContain("if: failure()");
    expect(source).toContain("installer.log");
    expect(source).toContain("wrapper.sha256");
    expect(source).toMatch(
      /cli_image: \$\{\{ steps\.candidate\.outputs\.cli_image \}\}/u,
    );
    expect(source).toContain("jq -er '.images.cli.reference' manifest.json");
    expect(source).toContain('--env "ARGUS_EXPECTED_CLI_IMAGE=$CLI_IMAGE"');
    expect(source).toContain("compose.log");
    expect(source).toContain("doctor.json");
    expect(source).not.toMatch(
      /path:\s*(?:\.?\/)?(?:opt\/argus\/)?(?:secrets\.env|release-private|environment)/u,
    );
    expect(source).not.toContain("ARGUS_RELEASE_ED25519_KEY");
    expect(source).not.toMatch(
      /ARGUS_(?:INSTALL_FIXTURE|DAEMON_SETTLE_SECONDS|SNAPSHOT_TIMEOUT_SECONDS):/u,
    );
  });

  it("authenticates private release assets without placing the token in curl arguments", async () => {
    const workflow = await read(".github/workflows/installer-smoke.yml");
    const smoke = await read("scripts/e2e/installer-smoke.sh");

    expect(workflow).toContain(
      'gh api "repos/$' +
        "{REPOSITORY}/releases/tags/$" +
        '{RELEASE_TAG}"',
    );
    expect(workflow).toContain("application/octet-stream");
    expect(workflow).toContain("--env ARGUS_GITHUB_TOKEN");
    expect(workflow).toContain("--env ARGUS_GITHUB_USER");
    expect(workflow).toMatch(
      /permissions:\n {2}actions: read\n {2}contents: read\n {2}packages: read/u,
    );
    expect(workflow).not.toContain(
      '--env "ARGUS_GITHUB_TOKEN=$ARGUS_GITHUB_TOKEN"',
    );
    expect(workflow).toContain("name: Check out trusted smoke harness");
    expect(workflow).toContain("ref: $" + "{{ github.workflow_sha }}");
    expect(workflow).toContain("path: trusted-smoke");
    expect(workflow).toContain(
      '"$CONTAINER" /workspace/trusted-smoke/scripts/e2e/installer-smoke.sh',
    );
    expect(smoke).toContain("ARGUS_GITHUB_TOKEN");
    expect(smoke).toContain(
      "grep -Eq '^[!-~]+$'",
    );
    expect(smoke).toContain("wc -l");
    expect(smoke).toContain('--header @"$argus_github_headers"');
    expect(smoke).not.toContain(
      '--header "Authorization: Bearer $ARGUS_GITHUB_TOKEN"',
    );
    expect(workflow).toContain(
      'case "$(docker exec "$container" systemctl is-system-running 2>/dev/null || true)" in',
    );
    expect(workflow).toContain("running|degraded)");
  });

  it("matches the Clack API-token prompt across ANSI-rendered segments", async () => {
    const smoke = await read("scripts/e2e/installer-smoke.sh");
    const promptPattern =
      "(?s)A.{0,255}r.{0,255}g.{0,255}u.{0,255}s.{0,255}A.{0,255}P.{0,255}I.{0,255}t.{0,255}o.{0,255}k.{0,255}e.{0,255}n";
    const fragmentedPrompt = [
      "\u001b[?25lA",
      "\u001b[2K\r\u001b[1Gr",
      "\u001b[36mg\u001b[0m",
      "\b\u001b[1Cu",
      "\u001b[?25hs",
      "\u001b[2K\r\u001b[1GA",
      "\u001b[36mP\u001b[0m",
      "\u001b[1CI",
      "\u001b[?25lt",
      "\u001b[2Ko",
      "\r\u001b[1Gk",
      "\u001b[36me\u001b[0m",
      "\u001b[?25hn",
    ].join("");

    expect(smoke).toContain(`-re {${promptPattern}}`);
    expect(smoke).not.toContain("-re {Argus API token}");
    expect(smoke).toContain("while {1}");
    expect(smoke).not.toContain("exp_continue");
    expect(smoke).toContain("set argus_sent 0");
    expect(smoke).toContain("if {!$argus_sent}");
    expect(
      new RegExp(promptPattern.replace("(?s)", ""), "su").test(
        fragmentedPrompt,
      ),
    ).toBe(true);

    const tclMatch = spawnSync(
      "expect",
      [
        "-c",
        `if {![regexp -- {${promptPattern}} $env(ARGUS_PROMPT_FIXTURE)]} { exit 1 }`,
      ],
      {
        env: {
          ...process.env,
          ARGUS_PROMPT_FIXTURE: fragmentedPrompt,
        },
      },
    );
    if (tclMatch.error === undefined) expect(tclMatch.status).toBe(0);
  });
});
