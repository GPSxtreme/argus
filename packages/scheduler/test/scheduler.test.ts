import { describe, expect, it } from "vitest";
import { backoffDelay, expandWatchTargets } from "../src/index.js";

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
});
