import type { SourceItem } from "@argus/contracts";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { classify, ingestItems, normalizeItem } from "../src/index.js";

const item: SourceItem = {
  externalId: "42",
  url: "https://example.com/42",
  title: "Protocol update",
  text: "Security release for SOL",
  publishedAt: "2026-07-30T23:00:00.000Z",
  raw: { id: 42 },
};

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("ingestion engine", () => {
  it("normalizes stable identity and content independently of ingestion time", () => {
    const first = normalizeItem({
      source: "web",
      targetId: "news",
      watchIds: ["security"],
      item,
      now: "2026-07-31T00:00:00.000Z",
    });
    const second = normalizeItem({
      source: "web",
      targetId: "news",
      watchIds: ["security"],
      item,
      now: "2026-08-01T00:00:00.000Z",
    });
    expect(first.id).toBe("web:news:42");
    expect(first.contentHash).toBe(second.contentHash);
  });

  it("classifies keyword matches without discarding unmatched records", () => {
    expect(classify(item, ["sol", "exploit"])).toEqual(["sol"]);
    expect(classify(item, ["unrelated"])).toEqual([]);
  });

  it("persists all items and advances a checkpoint after the batch", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    async function* items(): AsyncIterable<SourceItem> {
      yield item;
      yield { ...item, externalId: "43", text: "No keyword here" };
    }
    const result = await ingestItems({
      source: "web",
      targetId: "news",
      watchIds: ["security"],
      keywords: ["SOL"],
      items: items(),
      checkpoint: { last: "43" },
      repository,
      now: () => "2026-07-31T00:00:00.000Z",
    });
    expect(result.inserted).toBe(2);
    expect((await repository.queryRecords({})).items).toHaveLength(2);
    expect(await repository.getCheckpoint("news")).toEqual({ last: "43" });
  });

  it("fails closed when a diagnostic commit is missing its lease identity", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    async function* items(): AsyncIterable<SourceItem> {
      yield item;
    }
    await expect(
      ingestItems({
        source: "web",
        targetId: "__argus_doctor:missing-lease",
        watchIds: ["diagnostic"],
        keywords: [],
        items: items(),
        checkpoint: {},
        repository,
        diagnosticJobId: "diagnostic-job",
      }),
    ).rejects.toThrow("Diagnostic ingestion requires a fenced job lease");
    expect(await repository.queryRecords({})).toEqual({ items: [] });
  });
});
