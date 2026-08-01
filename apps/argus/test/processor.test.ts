import { validateConfig } from "@argus/config";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runSummaryProcessor } from "../src/processor.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("scheduled summary processor", () => {
  it("stores summary output as a derived artifact", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    await repository.upsertRecord({
      id: "web:site:1",
      source: "web",
      targetId: "site",
      externalId: "1",
      url: "https://example.com/1",
      text: "Argus ships",
      raw: {},
      watchIds: ["release"],
      contentHash: "hash",
      ingestedAt: "2026-07-31T00:00:00.000Z",
    });
    const config = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      intelligence: {
        enabled: true,
        apiKey: "secret",
        processors: [{ id: "daily", kind: "summary", watchIds: ["release"] }],
      },
    });
    const processor = config.intelligence.processors[0];
    expect(processor).toBeDefined();
    if (!processor) throw new Error("Expected a configured summary processor");
    await runSummaryProcessor(processor, config, repository, {
        summarize: async () => ({
          content: "Argus shipped. [1]",
          model: "test",
          sources: [
            { index: 1, recordId: "web:site:1", url: "https://example.com/1" },
          ],
        }),
      });
    expect((await repository.queryArtifacts({})).items[0]?.content).toBe(
      "Argus shipped. [1]",
    );
  });
});
