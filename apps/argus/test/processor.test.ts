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

  it("never sends diagnostic-owned records to a summary model", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const now = new Date().toISOString();
    const targetId = "__argus_doctor:summary-isolation";
    await repository.upsertRecord({
      id: "web:user:1",
      source: "web",
      targetId: "user",
      externalId: "1",
      url: "https://example.com/user",
      text: "User data",
      raw: {},
      watchIds: ["release"],
      contentHash: "user",
      ingestedAt: now,
    });
    await repository.createDiagnosticWatch({
      id: "summary-isolation",
      targetId,
      source: "web",
      target: {
        kind: "url",
        value: "https://example.com/diagnostic",
        watchId: targetId,
      },
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      job: {
        id: "summary-isolation-job",
        targetId,
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: now,
      },
    });
    await repository.claimJobs("worker", 1, 30_000);
    await repository.commitDiagnosticIngestion({
      jobId: "summary-isolation-job",
      targetId,
      records: [
        {
          id: "web:diagnostic:1",
          source: "web",
          targetId,
          externalId: "1",
          url: "https://example.com/diagnostic",
          text: "Diagnostic data",
          raw: {},
          watchIds: [targetId],
          contentHash: "diagnostic",
          ingestedAt: now,
        },
      ],
      checkpoint: {},
    });
    const config = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      intelligence: {
        enabled: true,
        apiKey: "secret",
        processors: [{ id: "daily", kind: "summary" }],
      },
    });
    const processor = config.intelligence.processors[0];
    if (!processor) throw new Error("Expected a configured summary processor");
    let summarizedIds: string[] = [];
    await runSummaryProcessor(processor, config, repository, {
      summarize: async (records) => {
        summarizedIds = records.map(({ id }) => id);
        return { content: "summary", model: "test", sources: [] };
      },
    });

    expect(summarizedIds).toEqual(["web:user:1"]);
  });
});
