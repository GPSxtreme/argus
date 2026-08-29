import { validateConfig } from "@argus/config";
import {
  type ConversationTracking,
  contentHash,
  recordIdentity,
  type SourceItem,
} from "@argus/contracts";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConversationRefresh } from "../src/conversation.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("X conversation refresh", () => {
  it("retains the 50 most-liked observed replies and advances tracking", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const rootRecordId = recordIdentity("x", "root");
    await repository.upsertRecord({
      id: rootRecordId,
      source: "x",
      externalId: "root",
      targetId: "movies:x:account:FilmUpdates",
      watchIds: ["movies"],
      url: "https://x.com/FilmUpdates/status/root",
      text: "Trailer",
      raw: {},
      contentHash: contentHash({ text: "Trailer" }),
      firstSeenAt: "2026-08-29T00:00:00.000Z",
      lastSeenAt: "2026-08-29T00:00:00.000Z",
    });
    const tracking: ConversationTracking = {
      rootRecordId,
      watchId: "movies",
      status: "active",
      orderBy: "likes",
      maxPerPost: 50,
      maxTrackingHours: 168,
      publishedAt: "2026-08-29T00:00:00.000Z",
      nextRunAt: "2026-08-29T01:00:00.000Z",
      stopsAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    await repository.upsertConversationTracking(tracking);
    const replies = Array.from({ length: 60 }, (_, index): SourceItem => ({
      externalId: `reply-${index}`,
      url: `https://x.com/viewer/status/reply-${index}`,
      text: `Reply ${index}`,
      engagement: { likes: index },
      relations: [
        { kind: "reply_to", objectSource: "x", objectExternalId: "root" },
      ],
      raw: {},
    }));
    const conversation = vi
      .fn()
      .mockResolvedValueOnce({ items: replies.slice(0, 40), cursor: "next" })
      .mockResolvedValueOnce({ items: replies.slice(40) });
    const config = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { x: { enabled: true } },
      watches: [],
    });

    const result = await runConversationRefresh(config, repository, tracking, {
      client: { conversation },
      now: () => "2026-08-29T02:00:00.000Z",
    });

    expect(result).toMatchObject({ observed: 60, retained: 50, pages: 2 });
    const snapshot = (await repository.queryConversationSnapshots(rootRecordId))
      .items[0];
    expect(snapshot).toMatchObject({
      observedCount: 60,
      retainedCount: 50,
      orderBy: "likes",
      complete: true,
      truncated: true,
      truncationReason: "selection_limit",
    });
    expect(snapshot?.items[0]).toMatchObject({
      replyRecordId: recordIdentity("x", "reply-59"),
      rank: 1,
      sortValue: 59,
    });
    expect(
      await repository.getRecord(recordIdentity("x", "reply-0")),
    ).toBeUndefined();
    expect(await repository.getConversationTracking(rootRecordId)).toMatchObject({
      status: "active",
      lastObservedReplies: 60,
      nextRunAt: "2026-08-29T03:00:00.000Z",
    });
    expect(conversation).toHaveBeenNthCalledWith(1, "root", undefined);
    expect(conversation).toHaveBeenNthCalledWith(2, "root", "next");
  });
});
