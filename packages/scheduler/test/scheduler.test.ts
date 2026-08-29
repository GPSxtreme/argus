import { describe, expect, it } from "vitest";
import { validateConfig } from "@argus/config";
import type { StorageRepository } from "@argus/contracts";
import { backoffDelay, enqueueDueTargets, expandWatchTargets } from "../src/index.js";

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
});
