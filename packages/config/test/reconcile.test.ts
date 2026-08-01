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
      storage: {
        adapter: "postgres",
        url: `postgres://postgres:5432/argus?password=${encodedPostgresPassword}`,
      },
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

  it("fingerprints effective pg query credentials and strips every credential parameter", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const firstPassword = "Argus-Shadowed@:/?#[]% secret";
    const effectivePassword = "Argus-Query@:/?#[]% secret";
    const uppercasePassword = "Argus-Ignored@:/?#[]% secret";
    const queryUrl =
      "postgres://authority-user:authority-password@postgres:5432/argus" +
      `?sslmode=verify-full&password=${encodeURIComponent(firstPassword)}` +
      `&PASSWORD=${encodeURIComponent(uppercasePassword)}` +
      `&user=query-user&password=${encodeURIComponent(effectivePassword)}` +
      "&application_name=argus";
    const queryConfig = validateConfig({
      ...postgresConfig,
      storage: { adapter: "postgres", url: queryUrl },
    });

    const first = await reconcileConfig(repository, queryConfig);
    const second = await reconcileConfig(repository, queryConfig);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    const applied = await repository.getAppliedConfig();
    expect(applied?.config).toMatchObject({
      storage: {
        adapter: "postgres",
        url: "postgres://postgres:5432/argus?sslmode=verify-full&application_name=argus",
      },
    });
    const surfaces = JSON.stringify(applied);
    for (const secret of [
      "authority-user",
      "authority-password",
      "query-user",
      firstPassword,
      encodeURIComponent(firstPassword),
      effectivePassword,
      encodeURIComponent(effectivePassword),
      uppercasePassword,
      encodeURIComponent(uppercasePassword),
      queryUrl,
    ]) {
      expect(surfaces).not.toContain(secret);
    }

    const changedEffective = validateConfig({
      ...queryConfig,
      storage: {
        adapter: "postgres",
        url: queryUrl.replace(
          encodeURIComponent(effectivePassword),
          encodeURIComponent(`${effectivePassword}-changed`),
        ),
      },
    });
    expect(
      (
        await planConfigReconciliation(repository, changedEffective)
      ).desiredContentHash,
    ).not.toBe(applied?.contentHash);

    const changedEffectiveUser = validateConfig({
      ...queryConfig,
      storage: {
        adapter: "postgres",
        url: queryUrl.replace("user=query-user", "user=changed-query-user"),
      },
    });
    expect(
      (
        await planConfigReconciliation(repository, changedEffectiveUser)
      ).desiredContentHash,
    ).not.toBe(applied?.contentHash);

    const changedShadowed = validateConfig({
      ...queryConfig,
      storage: {
        adapter: "postgres",
        url: queryUrl.replace(
          encodeURIComponent(firstPassword),
          encodeURIComponent(`${firstPassword}-changed`),
        ),
      },
    });
    expect(
      (
        await planConfigReconciliation(repository, changedShadowed)
      ).desiredContentHash,
    ).toBe(applied?.contentHash);

    const changedIgnoredCase = validateConfig({
      ...queryConfig,
      storage: {
        adapter: "postgres",
        url: queryUrl.replace(
          encodeURIComponent(uppercasePassword),
          encodeURIComponent(`${uppercasePassword}-changed`),
        ),
      },
    });
    expect(
      (
        await planConfigReconciliation(repository, changedIgnoredCase)
      ).desiredContentHash,
    ).toBe(applied?.contentHash);

    const emptyQueryFallsBackToAuthority = validateConfig({
      ...postgresConfig,
      storage: {
        adapter: "postgres",
        url: "postgres://authority-user:authority-password@postgres:5432/argus?password=&user=",
      },
    });
    const authorityOnly = validateConfig({
      ...postgresConfig,
      storage: {
        adapter: "postgres",
        url: "postgres://authority-user:authority-password@postgres:5432/argus",
      },
    });
    const emptyRepository = await createSqliteRepository({
      filename: ":memory:",
    });
    const authorityRepository = await createSqliteRepository({
      filename: ":memory:",
    });
    repositories.push(emptyRepository, authorityRepository);
    const emptyPlan = await planConfigReconciliation(
      emptyRepository,
      emptyQueryFallsBackToAuthority,
    );
    const authorityPlan = await planConfigReconciliation(
      authorityRepository,
      authorityOnly,
    );
    expect(emptyPlan.desiredContentHash).toBe(authorityPlan.desiredContentHash);
  });

  it("rejects an invalid PostgreSQL URL before reconciliation even without a pepper", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const invalidUrl = "postgres://user:Reconcile-Secret@/argus";
    const unsafe = {
      ...postgresConfig,
      storage: { adapter: "postgres", url: invalidUrl },
      api: {},
    } as typeof postgresConfig;

    let thrown: unknown;
    try {
      await planConfigReconciliation(repository, unsafe);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain(
      "PostgreSQL URL must use postgres:// or postgresql:// with a nonempty host and valid percent encoding.",
    );
    expect(String(thrown)).not.toContain(invalidUrl);
    expect(String(thrown)).not.toContain("Reconcile-Secret");
    expect(await repository.getAppliedConfig()).toBeUndefined();
  });
});
