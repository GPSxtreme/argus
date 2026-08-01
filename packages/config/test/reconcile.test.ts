import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyConfigReconciliation,
  planConfigReconciliation,
  reconcileConfig,
  validateConfig,
  verifyConfigReconciliation,
} from "../src/index.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const config = validateConfig({
  version: 1,
  storage: { adapter: "sqlite", url: ":memory:" },
  sources: {},
  watches: [],
});

const postgresPassword = "Argus-Unique@:/?#[]% secret";
const encodedPostgresPassword = encodeURIComponent(postgresPassword);
const postgresUrl = `postgres://argus-admin:${encodedPostgresPassword}@postgres:5432/argus`;
const postgresConfig = validateConfig({
  version: 1,
  storage: { adapter: "postgres", url: postgresUrl },
  sources: {},
  watches: [],
  api: { token: "independent-reconciliation-pepper" },
});

describe("configuration reconciliation", () => {
  it("persists an immutable applied snapshot and is idempotent", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const first = await reconcileConfig(repository, config);
    const second = await reconcileConfig(repository, config);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect((await repository.getAppliedConfig())?.config).toMatchObject({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
    });
  });

  it("plans exact create/update operations and consumes the inspected plan", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const firstPlan = await planConfigReconciliation(repository, config);
    expect(firstPlan.operations).toEqual([
      expect.objectContaining({ resource: "applied-config", action: "create" }),
    ]);
    await applyConfigReconciliation(repository, config, firstPlan);
    expect(await verifyConfigReconciliation(repository, firstPlan)).toBe(true);

    const secondPlan = await planConfigReconciliation(repository, config);
    expect(secondPlan.operations).toEqual([]);
    expect(
      await applyConfigReconciliation(repository, config, secondPlan),
    ).toMatchObject({ changed: false });

    const updated = validateConfig({
      ...config,
      api: { ...config.api, port: 9999 },
    });
    const updatePlan = await planConfigReconciliation(repository, updated);
    expect(updatePlan.operations).toEqual([
      expect.objectContaining({ action: "update" }),
    ]);
  });

  it("persists no PostgreSQL credentials while fingerprinting credential changes", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);

    await expect(reconcileConfig(repository, postgresConfig)).resolves.toMatchObject({
      changed: true,
    });
    const firstApplied = await repository.getAppliedConfig();
    const serialized = JSON.stringify(firstApplied);
    for (const secret of [
      postgresPassword,
      encodedPostgresPassword,
      decodeURIComponent(encodedPostgresPassword),
      postgresUrl,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(firstApplied?.config).toMatchObject({
      storage: {
        adapter: "postgres",
        url: "postgres://postgres:5432/argus",
      },
    });

    await expect(reconcileConfig(repository, postgresConfig)).resolves.toMatchObject({
      changed: false,
    });
    const changedCredential = validateConfig({
      ...postgresConfig,
      storage: {
        adapter: "postgres",
        url: `postgres://argus-admin:${encodeURIComponent(`${postgresPassword}-changed`)}@postgres:5432/argus`,
      },
    });
    const changedPlan = await planConfigReconciliation(
      repository,
      changedCredential,
    );
    expect(changedPlan.operations).toEqual([
      expect.objectContaining({ action: "update" }),
    ]);
    expect(changedPlan.desiredContentHash).not.toBe(firstApplied?.contentHash);
  });

  it("keys credential fingerprints with a secret absent from public state", async () => {
    const firstRepository = await createSqliteRepository({
      filename: ":memory:",
    });
    const secondRepository = await createSqliteRepository({
      filename: ":memory:",
    });
    repositories.push(firstRepository, secondRepository);
    const otherPepper = validateConfig({
      ...postgresConfig,
      api: { token: "different-independent-pepper" },
    });

    const first = await planConfigReconciliation(
      firstRepository,
      postgresConfig,
    );
    const second = await planConfigReconciliation(
      secondRepository,
      otherPepper,
    );
    expect(first.desiredContentHash).not.toBe(second.desiredContentHash);

    const withoutPepper = validateConfig({
      ...postgresConfig,
      api: {},
    });
    let thrown: unknown;
    try {
      await planConfigReconciliation(firstRepository, withoutPepper);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message:
        "Credential-bearing configuration URLs require api.token for secure reconciliation.",
    });
    const errorText = String(thrown);
    for (const secret of [
      postgresPassword,
      encodedPostgresPassword,
      postgresUrl,
    ]) {
      expect(errorText).not.toContain(secret);
    }
  });
});
