import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifiedReleaseManifest } from "@argus/release";
import { saveDeploymentState, type CommandExecutor } from "../src/index.js";
import {
  applyUpdate,
  backupInstance,
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
const release = (version = "2.0.0", minimumStateSchema = 1): VerifiedReleaseManifest =>
  ({
    manifestSha256: "a".repeat(64),
    manifest: {
      schemaVersion: 1,
      version,
      publishedAt: "2026-08-01T00:00:00.000Z",
      images: { app: image("a"), cli: image("b"), searxng: image("c"), postgres: image("d") },
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
    if (fail === "migration" && args.includes("migrate")) return { exitCode: 1, stdout: "", stderr: "migration failed" };
    if (fail === "health" && args.includes("ps")) return { exitCode: 0, stdout: "[]", stderr: "" };
    if (args.includes("ps")) {
      return { exitCode: 0, stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]', stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
});

const rootWithState = async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-update-"));
  roots.push(root);
  await saveDeploymentState(root, {
    schemaVersion: 1,
    argusVersion: "1.0.0",
    composeProject: "argus",
    configHash: "a".repeat(64),
    services: { argus: { image: image("f").reference, healthy: true } },
    compose: {
      version: "1.0.0",
      apiPort: 8788,
      storage: "sqlite",
      searxng: false,
      images: { argus: image("f").reference, postgres: image("d").reference, searxng: image("c").reference },
    },
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  return root;
};

describe("safe update state machine", () => {
  it("backs up SQLite database sidecars and completes every success phase", async () => {
    const root = await rootWithState();
    await writeFile(join(root, "argus.db"), "db");
    await writeFile(join(root, "argus.db-wal"), "wal");
    await writeFile(join(root, "argus.db-shm"), "shm");
    const plan = await planUpdate({ root, release: release(), executor: executor() });
    const backup = await backupInstance({ root, plan });

    expect(await readFile(join(backup.path, "argus.db"), "utf8")).toBe("db");
    expect(await readFile(join(backup.path, "argus.db-wal"), "utf8")).toBe("wal");
    expect(await readFile(join(backup.path, "argus.db-shm"), "utf8")).toBe("shm");
    await expect(applyUpdate({ root, plan, executor: executor() })).resolves.toMatchObject({
      version: "2.0.0",
      health: { healthy: true },
      phase: "verified",
    });
  });

  it("fails a migration before restart and leaves the persisted pull phase", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), executor: executor() });

    await expect(applyUpdate({ root, plan, executor: executor("migration") })).rejects.toThrow(/migration/u);
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain('"phase": "pulled"');
  });

  it("fails unhealthy verification and rolls back the backed-up release", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), executor: executor() });

    await expect(applyUpdate({ root, plan, executor: executor("health") })).rejects.toThrow(/health/u);
    await expect(rollbackUpdate({ root, executor: executor(), release: release() })).resolves.toMatchObject({
      version: "1.0.0",
      phase: "rolled_back",
    });
  });

  it("fails closed when rollback state is incompatible", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release(), executor: executor() });
    await backupInstance({ root, plan });

    await expect(rollbackUpdate({ root, executor: executor(), release: release("2.0.0", 2) })).rejects.toThrow(/incompatible/u);
  });

  it("reports a no-op for the current release version", async () => {
    const root = await rootWithState();
    const plan = await planUpdate({ root, release: release("1.0.0"), executor: executor() });
    expect(plan.changes).toEqual([]);
    expect(plan.noop).toBe(true);
  });
});
