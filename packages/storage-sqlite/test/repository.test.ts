import { describe, expect, it } from "vitest";
import { storageContract } from "@argus/storage-test-support";
import { createSqliteRepository } from "../src/index.js";

describe("SQLite repository", () => {
  it("opens an empty database", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    await expect(repository.queryRecords({})).resolves.toEqual({ items: [] });
    repository.close();
  });
});

storageContract(() => createSqliteRepository({ filename: ":memory:" }));
