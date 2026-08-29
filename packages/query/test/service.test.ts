import { createSqliteRepository } from "@argus/storage-sqlite";
import { recordIdentity } from "@argus/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { QueryService } from "../src/index.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("query service", () => {
  it("returns a human and agent digestible page with source links", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    await repository.upsertRecord({
      id: recordIdentity("telegram", "1"),
      source: "telegram",
      targetId: "argus",
      externalId: "1",
      url: "https://t.me/argus/1",
      text: "Argus V1 ships",
      raw: {},
      watchIds: ["releases"],
      contentHash: "hash",
      firstSeenAt: "2026-07-31T00:00:00.000Z",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    });
    const result = await new QueryService(repository).search({
      text: "V1",
    });
    expect(result.items[0]).toMatchObject({
      source: "telegram",
      url: "https://t.me/argus/1",
      text: "Argus V1 ships",
    });
    expect(result.summary).toBe("1 record");
  });
});
