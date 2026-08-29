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
    expect(first.id).toBe(
      "53488104b1bf4b4a61e59d85c097b310bc7c70d2043188647b3a60b3853f1176",
    );
    expect(first.contentHash).toBe(second.contentHash);
  });

  it("uses one canonical identity across targets", () => {
    const first = normalizeItem({
      source: "web",
      targetId: "news",
      watchIds: ["security"],
      item,
    });
    const second = normalizeItem({
      source: "web",
      targetId: "research",
      watchIds: ["markets"],
      item,
    });

    expect(first.id).toBe(second.id);
  });

  it("preserves media on a media-only source item", () => {
    const normalized = normalizeItem({
      source: "web",
      targetId: "charts",
      watchIds: ["markets"],
      item: {
        externalId: "media-42",
        url: "https://example.com/media-42",
        text: "",
        media: [
          {
            kind: "image",
            url: "https://cdn.example.com/chart.png",
            width: 1200,
            height: 800,
            altText: "Price prediction chart",
          },
        ],
        raw: { id: "media-42" },
      },
    });

    expect(normalized.text).toBe("");
    expect(normalized.media).toEqual([
      {
        kind: "image",
        url: "https://cdn.example.com/chart.png",
        width: 1200,
        height: 800,
        altText: "Price prediction chart",
      },
    ]);
  });

  it("revises canonical content when a media pointer changes", () => {
    const first = normalizeItem({
      source: "x",
      targetId: "markets",
      watchIds: ["markets"],
      item: {
        ...item,
        media: [{ kind: "image", url: "https://cdn.example.com/chart-a.png" }],
      },
    });
    const second = normalizeItem({
      source: "x",
      targetId: "markets",
      watchIds: ["markets"],
      item: {
        ...item,
        media: [{ kind: "image", url: "https://cdn.example.com/chart-b.png" }],
      },
    });

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("does not revise canonical content when engagement changes", () => {
    const first = normalizeItem({
      source: "x",
      targetId: "markets",
      watchIds: ["markets"],
      item: { ...item, engagement: { likes: 5, replies: 1 } },
    });
    const second = normalizeItem({
      source: "x",
      targetId: "markets",
      watchIds: ["markets"],
      item: { ...item, engagement: { likes: 9, replies: 2 } },
    });

    expect(first.contentHash).toBe(second.contentHash);
  });

  it("does not revise unchanged content when raw collection metadata changes", () => {
    const first = normalizeItem({
      source: "web",
      targetId: "news",
      watchIds: ["security"],
      item: { ...item, raw: { score: 0.8, positions: [3, 15] } },
    });
    const second = normalizeItem({
      source: "web",
      targetId: "news",
      watchIds: ["security"],
      item: { ...item, raw: { score: 0.65, positions: [13, 4] } },
    });

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
