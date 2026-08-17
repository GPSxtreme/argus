import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandExecutor, CommandResult } from "../src/index.js";
import * as deployment from "../src/index.js";

type InspectSqliteVolume = (input: {
  root: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
}) => Promise<{
  name: string;
  project: "argus";
  logicalName: "argus-data";
  destination: "/app/data";
}>;

const inspectSqliteVolume = (): InspectSqliteVolume =>
  (
    deployment as typeof deployment & {
      inspectSqliteVolume: InspectSqliteVolume;
    }
  ).inspectSqliteVolume;

type CreateSqliteSnapshot = (input: {
  root: string;
  backupRoot: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
  volume: {
    name: string;
    project: "argus";
    logicalName: "argus-data";
    destination: "/app/data";
  };
}) => Promise<{
  relativePath: string;
  sha256: string;
  bytes: number;
  quickCheck: "ok";
  counts: { records: number; revisions: number; jobs: number };
  volume: {
    name: string;
    project: "argus";
    logicalName: "argus-data";
    destination: "/app/data";
  };
}>;

const createSqliteSnapshot = (): CreateSqliteSnapshot =>
  (
    deployment as typeof deployment & {
      createSqliteSnapshot: CreateSqliteSnapshot;
    }
  ).createSqliteSnapshot;

type VerifySqliteSnapshot = (input: {
  root: string;
  backupRoot: string;
  snapshot: Awaited<ReturnType<CreateSqliteSnapshot>>;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
}) => Promise<void>;

type RestoreSqliteSnapshot = (input: {
  root: string;
  backupRoot: string;
  snapshot: Awaited<ReturnType<CreateSqliteSnapshot>>;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
  volume: Awaited<ReturnType<CreateSqliteSnapshot>>["volume"];
}) => Promise<void>;

const verifySqliteSnapshot = (): VerifySqliteSnapshot =>
  (
    deployment as typeof deployment & {
      verifySqliteSnapshot: VerifySqliteSnapshot;
    }
  ).verifySqliteSnapshot;

const restoreSqliteSnapshot = (): RestoreSqliteSnapshot =>
  (
    deployment as typeof deployment & {
      restoreSqliteSnapshot: RestoreSqliteSnapshot;
    }
  ).restoreSqliteSnapshot;

interface RecordedCall {
  command: string;
  args: string[];
  options:
    | {
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }
    | undefined;
}

const result = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const scriptedExecutor = (...results: CommandResult[]) => {
  const calls: RecordedCall[] = [];
  const executor: CommandExecutor = {
    async run(command, args, options) {
      calls.push({ command, args, options });
      const next = results.shift();
      if (!next) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      return next;
    },
  };
  return { calls, executor };
};

const root = "/opt/argus";
const environment = {
  ARGUS_API_PORT: "8788",
  ARGUS_IMAGE: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
  POSTGRES_IMAGE: `postgres@sha256:${"b".repeat(64)}`,
  SEARXNG_IMAGE: `searxng@sha256:${"c".repeat(64)}`,
};
const containerId = "d".repeat(64);
const validMount = {
  Type: "volume",
  Name: "argus_argus-data",
  Source: "/var/lib/docker/volumes/argus_argus-data/_data",
  Destination: "/app/data",
  Driver: "local",
  Mode: "rw",
  RW: true,
  Propagation: "",
};
const validLabels = {
  "com.docker.compose.project": "argus",
  "com.docker.compose.volume": "argus-data",
  "com.docker.compose.version": "2.39.1",
};

describe("managed SQLite volume discovery", () => {
  it("returns the exact Compose-owned named volume mounted at /app/data", async () => {
    const { calls, executor } = scriptedExecutor(
      result(`${containerId}\n`),
      result(JSON.stringify([validMount])),
      result(JSON.stringify(validLabels)),
    );

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).resolves.toEqual({
      name: "argus_argus-data",
      project: "argus",
      logicalName: "argus-data",
      destination: "/app/data",
    });
    expect(calls).toEqual([
      {
        command: "docker",
        args: ["compose", "-p", "argus", "ps", "-q", "--all", "argus"],
        options: { cwd: root, env: environment, timeoutMs: 10_000 },
      },
      {
        command: "docker",
        args: ["inspect", "--format", "{{json .Mounts}}", containerId],
        options: { timeoutMs: 10_000 },
      },
      {
        command: "docker",
        args: [
          "volume",
          "inspect",
          "--format",
          "{{json .Labels}}",
          "argus_argus-data",
        ],
        options: { timeoutMs: 10_000 },
      },
    ]);
  });

  it.each([
    ["missing service", ""],
    ["multiple service containers", `${containerId}\n${"e".repeat(64)}\n`],
    ["malformed service identity", "../../host\n"],
  ])("rejects %s before inspecting mounts", async (_name, stdout) => {
    const { calls, executor } = scriptedExecutor(result(stdout));

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no data mount", [{ ...validMount, Destination: "/other" }]],
    ["two data mounts", [validMount, { ...validMount, Name: "other" }]],
    ["host bind", [{ ...validMount, Type: "bind", Name: undefined }]],
    ["empty volume name", [{ ...validMount, Name: "" }]],
    ["unsafe volume name", [{ ...validMount, Name: "../../host" }]],
  ])("rejects %s before inspecting volume labels", async (_name, mounts) => {
    const { calls, executor } = scriptedExecutor(
      result(containerId),
      result(JSON.stringify(mounts)),
    );

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["missing labels", null],
    ["wrong project", { ...validLabels, "com.docker.compose.project": "other" }],
    [
      "wrong logical volume",
      { ...validLabels, "com.docker.compose.volume": "postgres-data" },
    ],
  ])("rejects %s", async (_name, labels) => {
    const { calls, executor } = scriptedExecutor(
      result(containerId),
      result(JSON.stringify([validMount])),
      result(JSON.stringify(labels)),
    );

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["compose failure", [{ exitCode: 1, stdout: "", stderr: "denied" }]],
    [
      "mount inspection timeout",
      [result(containerId), { exitCode: 1, stdout: "", stderr: "", timedOut: true }],
    ],
    [
      "malformed mount JSON",
      [result(containerId), result("not-json")],
    ],
    [
      "label inspection failure",
      [
        result(containerId),
        result(JSON.stringify([validMount])),
        { exitCode: 1, stdout: "", stderr: "denied" },
      ],
    ],
  ])("fails closed on %s", async (_name, responses) => {
    const { executor } = scriptedExecutor(...(responses as CommandResult[]));

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
      recovery: expect.stringContaining("argus doctor --json"),
    });
  });
});

describe("managed SQLite snapshot creation", () => {
  it("creates and independently verifies a snapshot from the named volume", async () => {
    const systemRoot = await mkdtemp(join(tmpdir(), "argus-sqlite-snapshot-"));
    const backupRoot = join(systemRoot, "backups", "1.0.0-test");
    await mkdir(backupRoot, { recursive: true });
    const bytes = Buffer.from("verified sqlite snapshot");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const calls: RecordedCall[] = [];
    const executor: CommandExecutor = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        await writeFile(join(backupRoot, "argus.db"), bytes, { flag: "wx" });
        return result(
          `${JSON.stringify({
            sha256,
            bytes: bytes.byteLength,
            quickCheck: "ok",
            counts: { records: 11, revisions: 22, jobs: 33 },
          })}\n`,
        );
      },
    };
    const image = `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`;
    const volume = {
      name: "argus_argus-data",
      project: "argus" as const,
      logicalName: "argus-data" as const,
      destination: "/app/data" as const,
    };

    try {
      await expect(
        createSqliteSnapshot()({
          root: systemRoot,
          backupRoot,
          executor,
          environment,
          image,
          volume,
        }),
      ).resolves.toEqual({
        relativePath: "backups/1.0.0-test/argus.db",
        sha256,
        bytes: bytes.byteLength,
        quickCheck: "ok",
        counts: { records: 11, revisions: 22, jobs: 33 },
        volume,
      });
      expect(calls).toEqual([
        {
          command: "docker",
          args: [
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "0:0",
            "--mount",
            "type=volume,src=argus_argus-data,dst=/data,readonly",
            "--mount",
            `type=bind,src=${backupRoot},dst=/backup`,
            "--entrypoint",
            "node",
            image,
            "--input-type=module",
            "-e",
            expect.any(String),
            "--",
            "/data/argus.db",
            "/backup/argus.db",
          ],
          options: { timeoutMs: 120_000 },
        },
      ]);
      expect((await stat(backupRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(join(backupRoot, "argus.db"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await rm(systemRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["nonzero exit", { exitCode: 1, stdout: "", stderr: "failed" }],
    ["timeout", { exitCode: 1, stdout: "", stderr: "", timedOut: true }],
    ["extra output", result("notice\n{}\n")],
    ["invalid JSON", result("not-json\n")],
    [
      "failed quick check",
      result(
        JSON.stringify({
          sha256: "a".repeat(64),
          bytes: 1,
          quickCheck: "failed",
          counts: { records: 0, revisions: 0, jobs: 0 },
        }),
      ),
    ],
    [
      "negative count",
      result(
        JSON.stringify({
          sha256: "a".repeat(64),
          bytes: 1,
          quickCheck: "ok",
          counts: { records: -1, revisions: 0, jobs: 0 },
        }),
      ),
    ],
    [
      "zero bytes",
      result(
        JSON.stringify({
          sha256: "a".repeat(64),
          bytes: 0,
          quickCheck: "ok",
          counts: { records: 0, revisions: 0, jobs: 0 },
        }),
      ),
    ],
    [
      "malformed hash",
      result(
        JSON.stringify({
          sha256: "not-a-hash",
          bytes: 1,
          quickCheck: "ok",
          counts: { records: 0, revisions: 0, jobs: 0 },
        }),
      ),
    ],
  ])("rejects %s helper output", async (_name, response) => {
    const systemRoot = await mkdtemp(join(tmpdir(), "argus-sqlite-snapshot-"));
    const backupRoot = join(systemRoot, "backups", "test");
    await mkdir(backupRoot, { recursive: true });
    const { executor } = scriptedExecutor(response as CommandResult);

    try {
      await expect(
        createSqliteSnapshot()({
          root: systemRoot,
          backupRoot,
          executor,
          environment,
          image: `argus@sha256:${"a".repeat(64)}`,
          volume: {
            name: "argus_argus-data",
            project: "argus",
            logicalName: "argus-data",
            destination: "/app/data",
          },
        }),
      ).rejects.toMatchObject({ code: "UPDATE_SQLITE_SNAPSHOT_FAILED" });
    } finally {
      await rm(systemRoot, { recursive: true, force: true });
    }
  });

  it.each(["hash mismatch", "symlink"])(
    "rejects a host-side %s after a valid helper receipt",
    async (failure) => {
      const systemRoot = await mkdtemp(join(tmpdir(), "argus-sqlite-snapshot-"));
      const backupRoot = join(systemRoot, "backups", "test");
      await mkdir(backupRoot, { recursive: true });
      const expected = Buffer.from("expected snapshot");
      const actual = Buffer.from("different snapshot");
      const sha256 = createHash("sha256").update(expected).digest("hex");
      const executor: CommandExecutor = {
        async run() {
          if (failure === "symlink") {
            const target = join(systemRoot, "outside.db");
            await writeFile(target, expected);
            await symlink(target, join(backupRoot, "argus.db"));
          } else {
            await writeFile(join(backupRoot, "argus.db"), actual);
          }
          return result(
            JSON.stringify({
              sha256,
              bytes: expected.byteLength,
              quickCheck: "ok",
              counts: { records: 1, revisions: 2, jobs: 3 },
            }),
          );
        },
      };

      try {
        await expect(
          createSqliteSnapshot()({
            root: systemRoot,
            backupRoot,
            executor,
            environment,
            image: `argus@sha256:${"a".repeat(64)}`,
            volume: {
              name: "argus_argus-data",
              project: "argus",
              logicalName: "argus-data",
              destination: "/app/data",
            },
          }),
        ).rejects.toMatchObject({ code: "UPDATE_SQLITE_SNAPSHOT_FAILED" });
      } finally {
        await rm(systemRoot, { recursive: true, force: true });
      }
    },
  );
});

describe("managed SQLite snapshot restore", () => {
  it("verifies the persisted snapshot before invoking an atomic volume restore", async () => {
    const systemRoot = await mkdtemp(join(tmpdir(), "argus-sqlite-restore-"));
    const backupRoot = join(systemRoot, "backups", "test");
    await mkdir(backupRoot, { recursive: true });
    const bytes = Buffer.from("restorable SQLite snapshot");
    await writeFile(join(backupRoot, "argus.db"), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const volume = {
      name: "argus_argus-data",
      project: "argus" as const,
      logicalName: "argus-data" as const,
      destination: "/app/data" as const,
    };
    const snapshot = {
      relativePath: "backups/test/argus.db",
      sha256,
      bytes: bytes.byteLength,
      quickCheck: "ok" as const,
      counts: { records: 1, revisions: 2, jobs: 3 },
      volume,
    };
    const calls: RecordedCall[] = [];
    const executor: CommandExecutor = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        if (calls.length === 1) {
          return result(
            JSON.stringify({
              sha256,
              bytes: bytes.byteLength,
              quickCheck: "ok",
              counts: snapshot.counts,
            }),
          );
        }
        return result(
          JSON.stringify({
            restored: true,
            sha256,
            bytes: bytes.byteLength,
            quickCheck: "ok",
            counts: snapshot.counts,
          }),
        );
      },
    };
    const image = `argus@sha256:${"a".repeat(64)}`;

    try {
      await verifySqliteSnapshot()({
        root: systemRoot,
        backupRoot,
        snapshot,
        executor,
        environment,
        image,
      });
      await restoreSqliteSnapshot()({
        root: systemRoot,
        backupRoot,
        snapshot,
        executor,
        environment,
        image,
        volume,
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.args).toEqual([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=bind,src=${backupRoot},dst=/backup,readonly`,
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        expect.any(String),
        "--",
        "/backup/argus.db",
      ]);
      expect(calls[1]?.args).toEqual([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        "type=volume,src=argus_argus-data,dst=/data",
        "--mount",
        `type=bind,src=${backupRoot},dst=/backup,readonly`,
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        expect.any(String),
        "--",
        "/backup/argus.db",
        "/data/argus.db",
        JSON.stringify({
          sha256,
          bytes: bytes.byteLength,
          quickCheck: "ok",
          counts: snapshot.counts,
        }),
      ]);
      const restoreScript = calls[1]?.args[calls[1].args.indexOf("-e") + 1];
      expect(restoreScript).toContain("checkpoint.busy !== 0");
      expect(restoreScript).toContain(
        "checkpoint.log !== checkpoint.checkpointed",
      );
    } finally {
      await rm(systemRoot, { recursive: true, force: true });
    }
  });

  it.each(["missing", "symlink", "hash mismatch", "path escape"])(
    "rejects a %s snapshot before Docker or live-volume access",
    async (failure) => {
      const systemRoot = await mkdtemp(join(tmpdir(), "argus-sqlite-restore-"));
      const backupRoot = join(systemRoot, "backups", "test");
      await mkdir(backupRoot, { recursive: true });
      const path = join(backupRoot, "argus.db");
      const bytes = Buffer.from("verified backup");
      await writeFile(path, bytes);
      const snapshot = {
        relativePath: "backups/test/argus.db",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        quickCheck: "ok" as const,
        counts: { records: 1, revisions: 2, jobs: 3 },
        volume: {
          name: "argus_argus-data",
          project: "argus" as const,
          logicalName: "argus-data" as const,
          destination: "/app/data" as const,
        },
      };
      if (failure === "missing") await unlink(path);
      if (failure === "symlink") {
        await unlink(path);
        const target = join(systemRoot, "outside.db");
        await writeFile(target, bytes);
        await symlink(target, path);
      }
      if (failure === "hash mismatch") snapshot.sha256 = "f".repeat(64);
      if (failure === "path escape") snapshot.relativePath = "../outside.db";
      let calls = 0;

      try {
        await expect(
          verifySqliteSnapshot()({
            root: systemRoot,
            backupRoot,
            snapshot,
            executor: {
              async run() {
                calls += 1;
                return result();
              },
            },
            environment,
            image: `argus@sha256:${"a".repeat(64)}`,
          }),
        ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_BACKUP_INVALID" });
        expect(calls).toBe(0);
      } finally {
        await rm(systemRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects SQLite receipt drift before restore", async () => {
    const systemRoot = await mkdtemp(join(tmpdir(), "argus-sqlite-restore-"));
    const backupRoot = join(systemRoot, "backups", "test");
    await mkdir(backupRoot, { recursive: true });
    const bytes = Buffer.from("verified backup");
    await writeFile(join(backupRoot, "argus.db"), bytes);
    const snapshot = {
      relativePath: "backups/test/argus.db",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      quickCheck: "ok" as const,
      counts: { records: 1, revisions: 2, jobs: 3 },
      volume: {
        name: "argus_argus-data",
        project: "argus" as const,
        logicalName: "argus-data" as const,
        destination: "/app/data" as const,
      },
    };

    try {
      await expect(
        verifySqliteSnapshot()({
          root: systemRoot,
          backupRoot,
          snapshot,
          executor: scriptedExecutor(
            result(
              JSON.stringify({
                sha256: snapshot.sha256,
                bytes: snapshot.bytes,
                quickCheck: "ok",
                counts: { records: 999, revisions: 2, jobs: 3 },
              }),
            ),
          ).executor,
          environment,
          image: `argus@sha256:${"a".repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_BACKUP_INVALID" });
    } finally {
      await rm(systemRoot, { recursive: true, force: true });
    }
  });
});
