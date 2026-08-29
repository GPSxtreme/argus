import { validateConfig } from "@argus/config";
import type { StorageRepository } from "@argus/contracts";
import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  enqueueDueConversationTracking,
  enqueueDueTargets,
  expandWatchTargets,
} from "../src/index.js";

describe("scheduler", () => {
  it("uses bounded exponential retry delays", () => {
    expect(backoffDelay(0, { baseMs: 1_000, maxMs: 10_000, jitter: 0 })).toBe(
      1_000,
    );
    expect(backoffDelay(5, { baseMs: 1_000, maxMs: 10_000, jitter: 0 })).toBe(
      10_000,
    );
  });

  it("expands one watch into deterministic source targets", () => {
    const targets = expandWatchTargets({
      id: "markets",
      enabled: true,
      schedule: "*/5 * * * *",
      inputs: {
        x: { accounts: ["solana"], queries: ["SOL"] },
        telegram: { channels: ["solana_announcements"] },
        web: {
          urls: ["https://example.com"],
          feeds: ["https://example.com/rss"],
          queries: ["solana news"],
        },
      },
      classify: { keywords: ["SOL"] },
    });
    expect(targets.map((target) => target.id)).toEqual([
      "markets:x:account:solana",
      "markets:x:query:SOL",
      "markets:telegram:channel:solana_announcements",
      "markets:web:url:https%3A%2F%2Fexample.com",
      "markets:web:feed:https%3A%2F%2Fexample.com%2Frss",
      "markets:web:query:solana%20news",
    ]);
  });

  it("skips targets with invalid cron schedules instead of aborting the tick", async () => {
    const base = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
    });
    const config = {
      ...base,
      watches: [
        {
          id: "broken",
          enabled: true,
          schedule: "61 * * * *",
          inputs: { web: { urls: ["https://example.com/broken"] } },
          classify: { keywords: [] },
        },
        {
          id: "healthy",
          enabled: true,
          schedule: "* * * * *",
          inputs: { web: { urls: ["https://example.com/ok"] } },
          classify: { keywords: [] },
        },
      ],
    } as unknown as typeof base;
    let enqueued = 0;
    const repository = {
      enqueueJob: async () => {
        enqueued += 1;
        return true;
      },
    } as unknown as StorageRepository;
    const queued = await enqueueDueTargets(
      config,
      repository,
      new Date("2026-08-03T00:00:30.000Z"),
    );
    expect(queued).toBe(1);
    expect(enqueued).toBe(1);
  });

  it("queues each due X conversation once for its scheduled run", async () => {
    const jobs: Array<{ targetId: string; runAt: string }> = [];
    const repository = {
      listDueConversationTracking: async () => [
        {
          rootRecordId: "root-record-id",
          watchId: "markets",
          status: "active",
          orderBy: "likes",
          maxPerPost: 50,
          maxTrackingHours: 168,
          publishedAt: "2026-08-29T00:00:00.000Z",
          nextRunAt: "2026-08-29T01:00:00.000Z",
          stopsAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z",
        },
      ],
      enqueueJob: async (job: { targetId: string; runAt: string }) => {
        jobs.push(job);
        return jobs.length === 1;
      },
    } as unknown as StorageRepository;

    expect(
      await enqueueDueConversationTracking(
        repository,
        new Date("2026-08-29T01:01:00.000Z"),
      ),
    ).toBe(1);
    expect(jobs).toEqual([
      expect.objectContaining({
        targetId: "__argus_x_conversation:root-record-id",
        runAt: "2026-08-29T01:00:00.000Z",
      }),
    ]);
  });
});
