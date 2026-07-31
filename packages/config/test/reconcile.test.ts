import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileConfig, validateConfig } from "../src/index.js";

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
});
