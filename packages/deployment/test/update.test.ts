import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifiedReleaseManifest } from "@argus/release";
import { afterEach, describe, expect, it } from "vitest";
import { type CommandExecutor, saveDeploymentState } from "../src/index.js";
import {
  applyUpdate,
  backupInstance,
  finalizeUpdate,
  loadRollbackReleaseContext,
  planUpdate,
  rollbackUpdate,
} from "../src/update.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const digest = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const image = (value: string) => ({
  digest: digest(value),
  reference: `ghcr.io/argus/${value}@${digest(value)}`,
});
const release = (version = "2.0.0", minimumStateSchema = 1, marker = "a"): VerifiedReleaseManifest =>
  ({
    manifestSha256: "a".repeat(64),
    manifest: {
      schemaVersion: 1,
      version,
      publishedAt: "2026-08-01T00:00:00.000Z",
      images: { app: image(marker), cli: image("b"), searxng: image("c"), postgres: image("d") },
      assets: {
        fxembed: { url: "https://example.test/fx.js", sha256: "e".repeat(64), compatibilityDate: "2026-08-01" },
        wrapper: { url: "https://example.test/argus", sha256: "f".repeat(64) },
        installer: { url: "https://example.test/install", sha256: "1".repeat(64) },
        publicKey: { url: "https://example.test/key", sha256: "2".repeat(64) },
        fxembedLicense: { url: "https://example.test/license", sha256: "3".repeat(64) },
        fxembedProvenance: { url: "https://example.test/provenance", sha256: "4".repeat(64) },
      },
      minimumStateSchema,
    },
  }) as VerifiedReleaseManifest;

const executor = (fail?: "migration" | "health"): CommandExecutor => ({
  async run(_command, args) {
    if (args.join(" ").includes("compose -p argus ps -q --all argus")) {
      return { exitCode: 0, stdout: `${"9".repeat(64)}\n`, stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            Type: "volume",
            Name: "argus_argus-data",
            Destination: "/app/data",
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "volume") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          "com.docker.compose.project": "argus",
          "com.docker.compose.volume": "argus-data",
        }),
        stderr: "",
      };
    }
    if (args[0] === "run" && args.includes("--network")) {
      const mount = args.find((value) => value.startsWith("type=bind,src="));
      const backupRoot = mount
        ?.slice("type=bind,src=".length)
        .split(",dst=")[0];
      if (!backupRoot) throw new Error("Missing snapshot bind mount");
      const snapshotPath = join(backupRoot, "argus.db");
      if (!mount.includes("readonly")) {
        await writeFile(snapshotPath, Buffer.from("test SQLite snapshot"), {
          flag: "wx",
        });
      }
      const bytes = await readFile(snapshotPath);
      const receipt = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        quickCheck: "ok",
        counts: { records: 1, revisions: 2, jobs: 3 },
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          args.some((value) => value.includes("type=volume")) &&
            mount.includes("readonly")
            ? { restored: true, ...receipt }
            : receipt,
        ),
        stderr: "",
      };
    }
    if (fail === "migration" && args.includes("migrate")) return { exitCode: 1, stdout: "", stderr: "migration failed" };
    if (fail === "health" && args.includes("ps")) return { exitCode: 0, stdout: "[]", stderr: "" };
    if (args.includes("ps")) {
      return {
        exitCode: 0,
        stdout:
          '[{"Service":"argus","State":"running","Health":"healthy"},{"Service":"postgres","State":"running","Health":"healthy"}]',
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
});
const rollbackContext = async (): Promise<Uint8Array> =>
  Buffer.from("verified signed release context");

const rootWithState = async ({
  searxng = false,
  storage = "sqlite",
}: {
  searxng?: boolean;
  storage?: "sqlite" | "postgres";
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "argus-update-"));
  roots.push(root);
  await saveDeploymentState(root, {
    schemaVersion: 1,
    argusVersion: "1.0.0",
    composeProject: "argus",
    configHash: "a".repeat(64),
    services: {
      argus: { image: image("f").reference, healthy: true },
      postgres: { image: image("e").reference, healthy: true },
      searxng: { image: image("b").reference, healthy: true },
      auxiliary: { image: image("e").reference, healthy: false },
    },
    compose: {
      version: "1.0.0",
      apiPort: 8788,
      storage,
      searxng,
      images: { argus: image("f").reference, postgres: image("d").reference, searxng: image("c").reference },
    },
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  return root;
};

describe("safe update state machine", () => {
  it("synchronizes managed service images to signed releases through update and rollback", async () => {
    const root = await rootWithState();
    const rollbackRelease = release("1.0.0", 1, "f");
    const targetRelease = release();
    const plan = await planUpdate({ root, release: targetRelease, rollbackRelease, executor: executor() });

    await applyUpdate({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    const updated = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(updated.compose.images).toEqual({
      argus: image("a").reference,
      postgres: image("d").reference,
      searxng: image("c").reference,
    });
    expect(updated.services).toMatchObject({
      argus: { image: image("a").reference, healthy: true },
      postgres: { image: image("d").reference, healthy: true },
      searxng: { image: image("c").reference, healthy: true },
      auxiliary: { image: image("e").reference, healthy: false },
    });

    await rollbackUpdate({ root, executor: executor(), release: rollbackRelease });
    const rolledBack = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(rolledBack.compose.images).toEqual({
      argus: image("f").reference,
      postgres: image("d").reference,
      searxng: image("c").reference,
    });
    expect(rolledBack.services).toMatchObject({
      argus: { image: image("f").reference, healthy: true },
      postgres: { image: image("d").reference, healthy: true },
      searxng: { image: image("c").reference, healthy: true },
      auxiliary: { image: image("e").reference, healthy: false },
    });
  });

  it("quiesces Argus and snapshots its proven Compose SQLite volume", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    const events: string[] = [];
    const snapshotBytes = Buffer.from("managed SQLite snapshot");
    const snapshotSha = createHash("sha256").update(snapshotBytes).digest("hex");
    const snapshotExecutor: CommandExecutor = {
      async run(command, args) {
        if (
          command === "docker" &&
          args.join(" ").includes("compose -p argus ps -q --all argus")
        ) {
          events.push("compose-ps");
          return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "inspect") {
          events.push("container-inspect");
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Type: "volume",
                Name: "argus_argus-data",
                Destination: "/app/data",
              },
            ]),
            stderr: "",
          };
        }
        if (command === "docker" && args[0] === "volume") {
          events.push("volume-inspect");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              "com.docker.compose.project": "argus",
              "com.docker.compose.volume": "argus-data",
            }),
            stderr: "",
          };
        }
        if (args.includes("stop")) {
          events.push("stop-argus");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "run" && args.includes("--network")) {
          events.push("snapshot-helper");
          const mount = args.find((value) => value.startsWith("type=bind,src="));
          const backupRoot = mount?.slice("type=bind,src=".length).split(",dst=")[0];
          if (!backupRoot) throw new Error("Missing snapshot bind mount");
          await writeFile(join(backupRoot, "argus.db"), snapshotBytes, { flag: "wx" });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              sha256: snapshotSha,
              bytes: snapshotBytes.byteLength,
              quickCheck: "ok",
              counts: { records: 10, revisions: 20, jobs: 30 },
            }),
            stderr: "",
          };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    };
    const backup = await backupInstance({
      root,
      plan,
      executor: snapshotExecutor,
      getRollbackContext: async () => {
        events.push("rollback-context");
        return rollbackContext();
      },
    });

    expect(events).toEqual([
      "rollback-context",
      "compose-ps",
      "container-inspect",
      "volume-inspect",
      "stop-argus",
      "snapshot-helper",
    ]);
    expect(backup.sqliteSnapshot).toMatchObject({
      relativePath: expect.stringMatching(/^backups\/.+\/argus\.db$/u),
      sha256: snapshotSha,
      bytes: snapshotBytes.byteLength,
      quickCheck: "ok",
      counts: { records: 10, revisions: 20, jobs: 30 },
      volume: { name: "argus_argus-data" },
    });
    expect(await readFile(join(backup.path, "argus.db"))).toEqual(snapshotBytes);
  });

  it("restarts the old Argus service and preserves update state when snapshot creation fails", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    const calls: string[][] = [];
    const baseExecutor = executor();
    const failingExecutor: CommandExecutor = {
      async run(command, args, options) {
        calls.push(args);
        if (args[0] === "run" && args.includes("--network")) {
          return { exitCode: 1, stdout: "", stderr: "snapshot failed" };
        }
        return baseExecutor.run(command, args, options);
      },
    };

    await expect(
      applyUpdate({
        root,
        plan,
        executor: failingExecutor,
        getRollbackContext: rollbackContext,
      }),
    ).rejects.toMatchObject({ code: "UPDATE_SQLITE_SNAPSHOT_FAILED" });
    expect(calls.some((args) => args.includes("pull"))).toBe(false);
    expect(calls.some((args) => args.includes("migrate"))).toBe(false);
    expect(
      calls.some(
        (args) => args.includes("up") && args.includes("argus"),
      ),
    ).toBe(true);
    await expect(readFile(join(root, "update-state.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restarts the old service when durable snapshot publication fails", async () => {
    const root = await rootWithState();
    await mkdir(join(root, "update-state.json"));
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    const calls: string[][] = [];
    const baseExecutor = executor();
    const recordingExecutor: CommandExecutor = {
      async run(command, args, options) {
        calls.push(args);
        return baseExecutor.run(command, args, options);
      },
    };

    await expect(
      applyUpdate({
        root,
        plan,
        executor: recordingExecutor,
        getRollbackContext: rollbackContext,
      }),
    ).rejects.toBeDefined();
    expect(calls.some((args) => args.includes("pull"))).toBe(false);
    expect(
      calls.some(
        (args) => args.includes("up") && args.includes("argus"),
      ),
    ).toBe(true);
  });

  it("reports failed recovery when snapshot failure cannot restart a healthy old service", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    const baseExecutor = executor();
    const failingExecutor: CommandExecutor = {
      async run(command, args, options) {
        if (args[0] === "run" && args.includes("--network")) {
          return { exitCode: 1, stdout: "", stderr: "snapshot failed" };
        }
        if (args.includes("--format") && args.includes("ps")) {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        return baseExecutor.run(command, args, options);
      },
    };

    await expect(
      applyUpdate({
        root,
        plan,
        executor: failingExecutor,
        getRollbackContext: rollbackContext,
      }),
    ).rejects.toMatchObject({ code: "UPDATE_SQLITE_RECOVERY_FAILED" });
  });

  it("does not stop or invoke SQLite helpers for PostgreSQL deployments", async () => {
    const root = await rootWithState({ storage: "postgres" });
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    const calls: string[][] = [];
    const baseExecutor = executor();
    const recordingExecutor: CommandExecutor = {
      async run(command, args, options) {
        calls.push(args);
        return baseExecutor.run(command, args, options);
      },
    };

    await applyUpdate({
      root,
      plan,
      executor: recordingExecutor,
      getRollbackContext: rollbackContext,
    });

    expect(calls.some((args) => args.includes("stop"))).toBe(false);
    expect(calls.some((args) => args.includes("--network"))).toBe(false);
    const persisted = JSON.parse(
      await readFile(join(root, "update-state.json"), "utf8"),
    ) as { backup: { sqliteSnapshot?: unknown } };
    expect(persisted.backup.sqliteSnapshot).toBeUndefined();
  });

  it("leaves a healthy update at the restart phase until its durable promotions finalize", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });

    const applied = await applyUpdate({ root, plan, executor: executor(), getRollbackContext: rollbackContext });

    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "restarted"',
    );
    await finalizeUpdate({ root, plan, applied });
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "verified"',
    );
  });

  it("refuses finalization when the durable transaction or deployed target no longer matches the plan", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    const applied = await applyUpdate({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    const restartState = await readFile(join(root, "update-state.json"), "utf8");
    const persisted = JSON.parse(restartState) as {
      rollbackRelease: VerifiedReleaseManifest;
      backup: { state: { argusVersion: string } };
    };

    persisted.rollbackRelease.manifest.version = "forged";
    await writeFile(join(root, "update-state.json"), JSON.stringify(persisted));
    await expect(finalizeUpdate({ root, plan, applied })).rejects.toMatchObject({
      code: "UPDATE_FINALIZATION_UNAVAILABLE",
    });

    await writeFile(join(root, "update-state.json"), restartState);
    await saveDeploymentState(root, plan.previousState);
    await expect(finalizeUpdate({ root, plan, applied })).rejects.toMatchObject({
      code: "UPDATE_FINALIZATION_UNAVAILABLE",
    });
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toBe(restartState);
  });

  it("preserves an opaque verified terminal journal only for the exact no-op release", async () => {
    const root = await rootWithState();
    const currentRelease = release("1.0.0", 1, "f");
    const plan = await planUpdate({
      root,
      release: currentRelease,
      rollbackRelease: currentRelease,
      executor: executor(),
    });
    const applied = await applyUpdate({ root, plan, executor: executor() });
    const mismatchedTerminal = `${JSON.stringify({
      phase: "verified",
      release: release("1.0.0", 1, "g"),
      obsolete: { sqliteFiles: [] },
    }, null, 2)}\n`;
    await writeFile(join(root, "update-state.json"), mismatchedTerminal);

    await expect(finalizeUpdate({ root, plan, applied })).rejects.toMatchObject({
      code: "UPDATE_ROLLBACK_UNAVAILABLE",
    });
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(mismatchedTerminal);

    const matchingTerminal = `${JSON.stringify({
      phase: "verified",
      release: currentRelease,
      obsolete: { sqliteFiles: [] },
    }, null, 2)}\n`;
    await writeFile(join(root, "update-state.json"), matchingTerminal);

    await expect(finalizeUpdate({ root, plan, applied })).resolves.toEqual({
      version: currentRelease.manifest.version,
      phase: "verified",
      health: applied.health,
    });
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(matchingTerminal);
  });

  it("keeps a completed rollback transaction terminal during a later healthy no-op", async () => {
    const root = await rootWithState();
    const rollbackRelease = release("1.0.0", 1, "f");
    const failedPlan = await planUpdate({
      root,
      release: release(),
      rollbackRelease,
      executor: executor(),
    });
    await backupInstance({ root, plan: failedPlan, executor: executor(), getRollbackContext: rollbackContext });
    await rollbackUpdate({ root, executor: executor(), release: rollbackRelease });
    const recoveryPlan = await planUpdate({
      root,
      release: rollbackRelease,
      rollbackRelease,
      executor: executor(),
    });
    const applied = await applyUpdate({ root, plan: recoveryPlan, executor: executor() });

    await finalizeUpdate({ root, plan: recoveryPlan, applied });

    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "rolled_back"',
    );
  });

  it("commits the signed rollback context with the durable backup before image pulls", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    const events: string[] = [];
    const recordingExecutor: CommandExecutor = {
      async run(command, args) {
        if (args.includes("pull")) events.push("pull");
        return executor().run(command, args);
      },
    };

    await applyUpdate({
      root,
      plan,
      executor: recordingExecutor,
      async getRollbackContext() {
        events.push("rollback-context");
        return rollbackContext();
      },
    });

    expect(events.slice(0, 2)).toEqual(["rollback-context", "pull"]);
    const state = JSON.parse(await readFile(join(root, "update-state.json"), "utf8")) as {
      backup: { signedContext: { relativePath: string; sha256: string } };
    };
    expect(await readFile(join(root, state.backup.signedContext.relativePath), "utf8")).toBe(
      "verified signed release context",
    );
    expect(state.backup.signedContext.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when authoritative signed rollback bytes do not match their recorded hash", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    const backup = await backupInstance({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    await expect(loadRollbackReleaseContext(root)).resolves.toEqual(
      Buffer.from("verified signed release context"),
    );

    await writeFile(join(root, backup.signedContext.relativePath), "tampered context");
    await expect(loadRollbackReleaseContext(root)).rejects.toMatchObject({
      code: "UPDATE_ROLLBACK_UNAVAILABLE",
    });
  });

  it("stops before image pulls and state persistence when rollback context cannot be constructed", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    let pullCalled = false;
    const recordingExecutor: CommandExecutor = {
      async run(command, args) {
        if (args.includes("pull")) pullCalled = true;
        return executor().run(command, args);
      },
    };

    await expect(
      applyUpdate({
        root,
        plan,
        executor: recordingExecutor,
        async getRollbackContext() {
          throw new Error("rollback context unavailable");
        },
      }),
    ).rejects.toThrow("rollback context unavailable");
    expect(pullCalled).toBe(false);
    await expect(readFile(join(root, "update-state.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the prior authoritative rollback record when backup context construction fails", async () => {
    const root = await rootWithState();
    const first = await planUpdate({
      root,
      release: release(),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });
    await applyUpdate({ root, plan: first, executor: executor(), getRollbackContext: rollbackContext });
    const priorUpdateState = await readFile(join(root, "update-state.json"), "utf8");
    const second = await planUpdate({
      root,
      release: release("3.0.0", 1, "9"),
      rollbackRelease: release("2.0.0", 1, "a"),
      executor: executor(),
    });

    await expect(
      applyUpdate({
        root,
        plan: second,
        executor: executor(),
        async getRollbackContext() {
          throw new Error("signed context construction failed");
        },
      }),
    ).rejects.toThrow("signed context construction failed");
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(priorUpdateState);
  });

  it("does not request rollback context for a no-op update", async () => {
    const root = await rootWithState();
    const currentRelease = release("1.0.0", 1, "f");
    const plan = await planUpdate({ root, release: currentRelease, rollbackRelease: currentRelease, executor: executor() });
    let called = false;

    await applyUpdate({
      root,
      plan,
      executor: executor(),
      async getRollbackContext() {
        called = true;
        return rollbackContext();
      },
    });

    expect(plan.noop).toBe(true);
    expect(called).toBe(false);
  });

  it("accepts newline-delimited Compose service records during update verification", async () => {
    const root = await rootWithState({ searxng: true });
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    const baseExecutor = executor();
    const composeV239Executor: CommandExecutor = {
      async run(command, args, options) {
        if (args.includes("--format") && args.includes("ps")) {
          return {
            exitCode: 0,
            stdout: [
              '{"Service":"argus","State":"running","Health":"starting"}',
              '{"Service":"searxng","State":"running","Health":"healthy"}',
            ].join("\n"),
            stderr: "",
          };
        }
        return baseExecutor.run(command, args, options);
      },
    };

    const applied = await applyUpdate({ root, plan, executor: composeV239Executor, getRollbackContext: rollbackContext });
    await expect(finalizeUpdate({ root, plan, applied })).resolves.toMatchObject({
      version: "2.0.0",
      phase: "verified",
      health: {
        healthy: true,
        services: [
          { name: "argus", state: "running", health: "starting" },
          { name: "searxng", state: "running", health: "healthy" },
        ],
      },
    });
  });

  it("fails a migration before restart and leaves the persisted pull phase", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });

    await expect(applyUpdate({ root, plan, executor: executor("migration"), getRollbackContext: rollbackContext })).rejects.toThrow(/migration/u);
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain('"phase": "pulled"');
  });

  it("fails unhealthy verification and rolls back the backed-up release", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });

    await expect(applyUpdate({ root, plan, executor: executor("health"), getRollbackContext: rollbackContext })).rejects.toThrow(/health/u);
    await expect(rollbackUpdate({ root, executor: executor(), release: release("1.0.0", 1, "f") })).resolves.toMatchObject({
      version: "1.0.0",
      phase: "rolled_back",
    });
  });

  it("fails an explicitly unhealthy newline-delimited Compose status", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    const baseExecutor = executor();
    const unhealthyExecutor: CommandExecutor = {
      async run(command, args, options) {
        if (args.includes("--format") && args.includes("ps")) {
          return {
            exitCode: 0,
            stdout: '{"Service":"argus","State":"running","Health":"unhealthy"}',
            stderr: "",
          };
        }
        return baseExecutor.run(command, args, options);
      },
    };

    await expect(applyUpdate({ root, plan, executor: unhealthyExecutor, getRollbackContext: rollbackContext })).rejects.toMatchObject({
      code: "UPDATE_HEALTHCHECK_FAILED",
    });
  });

  it("fails closed when rollback state is incompatible", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    await backupInstance({ root, plan, executor: executor(), getRollbackContext: rollbackContext });

    await expect(rollbackUpdate({ root, executor: executor(), release: release("1.0.0", 2, "f") })).rejects.toThrow(/incompatible/u);
  });

  it("rejects persisted rollback manifest mutations before database, Docker, or state side effects", async () => {
    const root = await rootWithState();
    const rollbackRelease = release("1.0.0", 1, "f");
    await writeFile(join(root, "argus.db"), "backup database");
    const plan = await planUpdate({
      root,
      release: release(),
      rollbackRelease,
      executor: executor(),
    });
    await backupInstance({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    await writeFile(join(root, "argus.db"), "live database");
    const priorState = await readFile(join(root, "state.json"), "utf8");
    const persisted = JSON.parse(
      await readFile(join(root, "update-state.json"), "utf8"),
    ) as {
      rollbackRelease: VerifiedReleaseManifest;
    };
    persisted.rollbackRelease.manifest.publishedAt = "2026-08-02T00:00:00.000Z";
    persisted.rollbackRelease.manifest.images = {
      app: image("5"),
      cli: image("6"),
      postgres: image("7"),
      searxng: image("8"),
    };
    persisted.rollbackRelease.manifest.assets.fxembed = {
      url: "https://attacker.test/fx.js",
      sha256: "9".repeat(64),
      compatibilityDate: "2026-08-02",
    };
    persisted.rollbackRelease.manifest.assets.wrapper = {
      url: "https://attacker.test/argus",
      sha256: "0".repeat(64),
    };
    await writeFile(join(root, "update-state.json"), JSON.stringify(persisted));
    const calls: string[][] = [];
    const recordingExecutor: CommandExecutor = {
      async run(_command, args) {
        calls.push(args);
        if (args.includes("ps")) {
          return {
            exitCode: 0,
            stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]',
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(
      rollbackUpdate({ root, executor: recordingExecutor, release: rollbackRelease }),
    ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_INCOMPATIBLE" });
    expect(calls).toEqual([]);
    await expect(readFile(join(root, "argus.db"), "utf8")).resolves.toBe("live database");
    await expect(readFile(join(root, "state.json"), "utf8")).resolves.toBe(priorState);
  });

  it("rejects a compose-less persisted rollback backup before side effects", async () => {
    const root = await rootWithState();
    const rollbackRelease = release("1.0.0", 1, "f");
    const databasePath = join(root, "data", "argus.db");
    await mkdir(join(root, "data"));
    await writeFile(databasePath, "backup database");
    const plan = await planUpdate({ root, release: release(), rollbackRelease, executor: executor() });
    await backupInstance({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    const originalState = await readFile(join(root, "state.json"), "utf8");
    await writeFile(databasePath, "live database");
    const persisted = JSON.parse(await readFile(join(root, "update-state.json"), "utf8")) as {
      backup: { state: { compose?: unknown } };
    };
    delete persisted.backup.state.compose;
    await writeFile(join(root, "update-state.json"), JSON.stringify(persisted));
    const calls: string[][] = [];
    const recordingExecutor: CommandExecutor = {
      async run(_command, args) {
        calls.push(args);
        if (args.includes("ps")) return { exitCode: 0, stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]', stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    let error: unknown;
    try {
      await rollbackUpdate({ root, executor: recordingExecutor, release: rollbackRelease });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "UPDATE_STATE_UNAVAILABLE",
    });
    expect(calls).toEqual([]);
    await expect(readFile(databasePath, "utf8")).resolves.toBe("live database");
    await expect(readFile(join(root, "state.json"), "utf8")).resolves.toBe(originalState);
  });

  it("rejects a persisted rollback with a path that escapes the instance root", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    await backupInstance({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    const state = JSON.parse(await readFile(join(root, "update-state.json"), "utf8")) as {
      backup: { sqliteSnapshot: { relativePath: string } };
    };
    state.backup.sqliteSnapshot.relativePath = "../../etc/cron.d/argus";
    await writeFile(join(root, "update-state.json"), JSON.stringify(state));

    await expect(rollbackUpdate({ root, executor: executor(), release: release("1.0.0", 1, "f") })).rejects.toThrow(/No persisted Argus update backup/u);
  });

  it("rejects a persisted rollback with an absolute path", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    await backupInstance({ root, plan, executor: executor(), getRollbackContext: rollbackContext });
    const state = JSON.parse(await readFile(join(root, "update-state.json"), "utf8")) as {
      backup: { path: string };
    };
    state.backup.path = "/etc";
    await writeFile(join(root, "update-state.json"), JSON.stringify(state));

    await expect(rollbackUpdate({ root, executor: executor(), release: release("1.0.0", 1, "f") })).rejects.toThrow(/outside the instance root|No persisted Argus update backup/u);
  });

  it("reports a no-op for the current release version", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release("1.0.0", 1, "f"), rollbackRelease: release("1.0.0", 1, "f"), executor: executor() });
    expect(plan.changes).toEqual([]);
    expect(plan.noop).toBe(true);
  });

  it("plans an update when the signed current-version images differ from deployment state", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({
      root,
      release: release("1.0.0", 1, "a"),
      rollbackRelease: release("1.0.0", 1, "f"),
      executor: executor(),
    });

    expect(plan.noop).toBe(false);
    expect(plan.changes).toHaveLength(1);
  });

  it("fails closed for a forged release before invoking Docker", async () => {
    const root = await rootWithState();
    let calls = 0;
    const forged = { ...release(), manifestSha256: "forged" } as VerifiedReleaseManifest;

    await expect(
      planUpdate({
        root,
        release: forged,
        rollbackRelease: release("1.0.0", 1, "f"),
        executor: { async run() { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; } },
      }),
    ).rejects.toThrow(/verified signed/u);
    expect(calls).toBe(0);
  });

  it("rejects a rollback release that does not exactly describe the current deployment", async () => {
    const root = await rootWithState();

    await expect(
      planUpdate({
        root,
        release: release(),
        rollbackRelease: release("0.9.0", 1, "e"),
        executor: executor(),
      }),
    ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_RELEASE_MISMATCH" });
  });

  it("restores the verified SQLite volume snapshot with the signed old image", async () => {
    const root = await rootWithState();
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const baseExecutor = executor();
    const recordingExecutor: CommandExecutor = {
      async run(command, args, options) {
        calls.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
        return baseExecutor.run(command, args, options);
      },
    };
    const rollbackRelease = release("1.0.0", 1, "f");
    const plan = await planUpdate({ root, release: release(), rollbackRelease, executor: recordingExecutor });
    await backupInstance({ root, plan, executor: recordingExecutor, getRollbackContext: rollbackContext });
    await rollbackUpdate({ root, executor: recordingExecutor, release: rollbackRelease });

    expect(calls.some((call) => call.args.some((arg) => arg.includes("dst=/backup,readonly")))).toBe(true);
    expect(calls.some((call) => call.args.includes("stop"))).toBe(true);
    expect(calls.some((call) => call.args.includes("/data/argus.db"))).toBe(true);
    expect(calls.find((call) => call.args.includes("up"))?.env?.ARGUS_IMAGE).toBe(rollbackRelease.manifest.images.app.reference);
  });
});
