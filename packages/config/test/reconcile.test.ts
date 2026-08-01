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
});
