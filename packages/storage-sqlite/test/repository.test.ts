import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordEnvelope } from "@argus/contracts";
import {
  createSqliteRepository,
  type SqliteRepository,
} from "../src/index.js";

const repositories: SqliteRepository[] = [];

const record = (hash: string, text = "Solana release"): RecordEnvelope => ({
  id: "x:target-1:post-9",
  source: "x",
  targetId: "target-1",
  externalId: "post-9",
  url: "https://x.com/argus/status/post-9",
  title: "Update",
  text,
  raw: { text },
  watchIds: ["markets"],
  contentHash: hash,
  ingestedAt: "2026-07-31T00:00:00.000Z",
});

const createRepo = async (): Promise<SqliteRepository> => {
  const repo = await createSqliteRepository({ filename: ":memory:" });
  repositories.push(repo);
  return repo;
};

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});

describe("SQLite repository", () => {
  it("deduplicates records and preserves revisions when content changes", async () => {
    const repo = await createRepo();
    const first = await repo.upsertRecord(record("a"));
    const duplicate = await repo.upsertRecord(record("a"));
    const edited = await repo.upsertRecord(record("b", "Solana security release"));

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.revision).toBeUndefined();
    expect(edited.revision?.contentHash).toBe("b");
    expect((await repo.listRevisions(first.record.id)).items).toHaveLength(2);
  });

  it("queries text and paginates deterministically", async () => {
    const repo = await createRepo();
    await repo.upsertRecord(record("a"));
    await repo.upsertRecord({
      ...record("b", "Ethereum roadmap"),
      id: "web:target-2:page-2",
      source: "web",
      targetId: "target-2",
      externalId: "page-2",
    });

    expect((await repo.queryRecords({ text: "Solana" })).items).toHaveLength(1);
    const page = await repo.queryRecords({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(
      (await repo.queryRecords({ limit: 1, cursor: page.nextCursor! })).items,
    ).toHaveLength(1);
  });

  it("leases due jobs to only one worker", async () => {
    const repo = await createRepo();
    await repo.enqueueJob({
      id: randomUUID(),
      targetId: "target-1",
      source: "x",
      status: "queued",
      attempt: 0,
      runAt: "2026-07-31T00:00:00.000Z",
    });

    expect(await repo.claimJobs("worker-a", 10, 30_000)).toHaveLength(1);
    expect(await repo.claimJobs("worker-b", 10, 30_000)).toHaveLength(0);
  });

  it("commits records and checkpoint as one ingestion unit", async () => {
    const repo = await createRepo();
    const result = await repo.commitIngestion({
      records: [record("atomic")],
      targetId: "target-1",
      checkpoint: { latestId: "post-9" },
    });

    expect(result).toEqual({ inserted: 1, revised: 0, duplicates: 0 });
    expect(await repo.getCheckpoint("target-1")).toEqual({ latestId: "post-9" });
  });

  it("stores and lists derived artifacts separately from source records", async () => {
    const repo = await createRepo();
    await repo.saveArtifact({
      id: "summary-1",
      recordIds: ["x:target-1:post-9"],
      kind: "summary",
      content: "A sourced summary",
      provider: "openrouter",
      model: "model",
      provenance: { sources: [1] },
      createdAt: "2026-07-31T01:00:00.000Z",
    });
    expect((await repo.queryArtifacts({ kind: "summary" })).items[0]).toMatchObject({
      id: "summary-1",
      content: "A sourced summary",
    });
  });
});
