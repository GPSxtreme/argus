import { validateConfig } from "@argus/config";
import { recordIdentity } from "@argus/contracts";
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
      id: recordIdentity("web", "1"),
      source: "web",
      targetId: "site",
      externalId: "1",
      url: "https://example.com/1",
      text: "Argus ships",
      raw: {},
      watchIds: ["release"],
      contentHash: "hash",
      firstSeenAt: "2026-07-31T00:00:00.000Z",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    });
    const config = validateConfig({
      version: 2,
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
            { index: 1, recordId: recordIdentity("web", "1"), url: "https://example.com/1" },
          ],
          media: [],
          capabilitiesSource: "fallback",
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
      id: recordIdentity("web", "1"),
      source: "web",
      targetId: "user",
      externalId: "1",
      url: "https://example.com/user",
      text: "User data",
      raw: {},
      watchIds: ["release"],
      contentHash: "user",
      firstSeenAt: now,
      lastSeenAt: now,
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
    const lease = (await repository.claimJobs("worker", 1, 30_000))[0];
    if (!lease?.leaseToken) throw new Error("Expected diagnostic lease");
    await repository.commitDiagnosticIngestion({
      jobId: "summary-isolation-job",
      leaseOwner: "worker",
      leaseToken: lease.leaseToken,
      targetId,
      records: [
        {
          id: recordIdentity("web", "diagnostic-1"),
          source: "web",
          targetId,
          externalId: "diagnostic-1",
          url: "https://example.com/diagnostic",
          text: "Diagnostic data",
          raw: {},
          watchIds: [targetId],
          contentHash: "diagnostic",
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ],
      checkpoint: {},
    });
    const config = validateConfig({
      version: 2,
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
        return {
          content: "summary",
          model: "test",
          sources: [],
          media: [],
          capabilitiesSource: "fallback",
        };
      },
    });

    expect(summarizedIds).toEqual([recordIdentity("web", "1")]);
  });

  it("grounds summaries in the latest bounded conversation sample", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const rootId = recordIdentity("x", "root");
    const replyId = recordIdentity("x", "reply");
    for (const record of [
      { id: rootId, externalId: "root", targetId: "markets:x:account:analyst", url: "https://x.com/analyst/status/root", text: "Price prediction" },
      { id: replyId, externalId: "reply", targetId: `__argus_x_conversation:${rootId}`, url: "https://x.com/trader/status/reply", text: "That chart is misleading" },
    ]) {
      await repository.upsertRecord({ ...record, source: "x", raw: {}, watchIds: ["markets"], contentHash: record.id, firstSeenAt: "2026-08-29T00:00:00.000Z", lastSeenAt: "2026-08-29T00:00:00.000Z" });
    }
    await repository.saveConversationSnapshot({
      snapshot: { id: "latest-snapshot", rootRecordId: rootId, observedCount: 40, retainedCount: 1, orderBy: "likes", pagesFetched: 2, complete: true, truncated: false, collectedAt: "2026-08-29T01:00:00.000Z" },
      items: [{ snapshotId: "latest-snapshot", replyRecordId: replyId, rank: 1, sortValue: 25 }],
    });
    const config = validateConfig({ version: 2, storage: { adapter: "sqlite", url: ":memory:" }, sources: {}, watches: [], intelligence: { enabled: true, apiKey: "secret", processors: [{ id: "market-summary", kind: "summary", watchIds: ["markets"] }] } });
    const processor = config.intelligence.processors[0];
    if (!processor) throw new Error("Expected processor");
    let summarizedIds: string[] = [];
    await runSummaryProcessor(processor, config, repository, {
      summarize: async (records) => {
        summarizedIds = records.map(({ id }) => id);
        return { content: "Prediction drew skepticism. [1] [2]", model: "test", sources: [], media: [], capabilitiesSource: "fallback" };
      },
    });
    expect(summarizedIds).toEqual([rootId, replyId]);
    expect((await repository.queryArtifacts({})).items[0]).toMatchObject({
      recordIds: [rootId, replyId],
      provenance: { conversationSamples: [{ rootRecordId: rootId, snapshotId: "latest-snapshot", observedCount: 40, retainedCount: 1, includedReplyRecordIds: [replyId] }] },
    });
  });
});
