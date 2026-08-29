import type { SourceItem } from "@argus/contracts";
import { describe, expect, it } from "vitest";
import { nextReplyRun, selectObservedReplies } from "../src/index.js";

const hour = 60 * 60 * 1000;
const atAge = (hours: number, stopsAt = 200 * hour) => nextReplyRun({ publishedAt: new Date(0).toISOString(), now: new Date(hours * hour).toISOString(), stopsAt: new Date(stopsAt).toISOString() });

describe("X reply scheduling", () => {
  it.each([
    [0, 0.25], [1, 2], [6, 12], [24, 48], [72, 144],
  ])("schedules age %sh at %sh", (age, expected) => expect(atAge(age)).toBe(new Date(expected * hour).toISOString()));
  it("stops at the horizon", () => expect(atAge(168, 168 * hour)).toBeUndefined());
  it("enters an hourly bounded burst after meaningful growth", () => expect(nextReplyRun({ publishedAt: new Date(0).toISOString(), now: new Date(30 * hour).toISOString(), stopsAt: new Date(168 * hour).toISOString(), previousObservedReplies: 20, observedReplies: 24 })).toBe(new Date(31 * hour).toISOString()));
});

const reply = (externalId: string, publishedAt: string, engagement: SourceItem["engagement"] = {}): SourceItem => ({ externalId, url: `https://x.com/i/status/${externalId}`, text: externalId, publishedAt, engagement, raw: {} });

describe("observed reply selection", () => {
  const items = [
    reply("b", "2026-08-29T00:01:00.000Z", { likes: 10, replies: 2, reposts: 3, views: 50 }),
    reply("a", "2026-08-29T00:00:00.000Z", { likes: 10, replies: 4, reposts: 1, views: 100 }),
    reply("c", "2026-08-29T00:02:00.000Z"),
    reply("a", "2026-08-29T00:00:00.000Z", { likes: 10 }),
  ];
  it.each([
    ["likes", ["a", "b", "c"]], ["newest", ["c", "b", "a"]],
    ["oldest", ["a", "b", "c"]], ["replies", ["a", "b", "c"]],
    ["reposts", ["b", "a", "c"]], ["views", ["a", "b", "c"]],
    ["source", ["b", "a", "c"]],
  ] as const)("orders by %s", (order, expected) => expect(selectObservedReplies(items, order, 50).map(({ item }) => item.externalId)).toEqual(expected));
  it("caps the selected observed set", () => expect(selectObservedReplies(Array.from({ length: 500 }, (_, index) => reply(String(index), new Date(index).toISOString(), { likes: index })), "likes", 50)).toHaveLength(50));
});
