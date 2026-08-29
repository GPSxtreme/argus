import { validateConfig } from "@argus/config";
import { recordIdentity, type SourceItem } from "@argus/contracts";
import type { ScheduledTarget } from "@argus/scheduler";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdapterFactory,
  findDiagnosticTarget,
  runTarget,
} from "../src/worker.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const repository of repositories.splice(0)) repository.close();
});

describe("target worker", () => {
  it("creates a query adapter capability from the configured SearXNG origin", async () => {
    const config = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {
        web: {
          enabled: true,
          searchEndpoint: "http://searxng:8080",
        },
      },
      watches: [],
    });
    const request = vi.fn(async (_url: URL) =>
      Response.json({
        results: [
          {
            url: "https://example.com/argus",
            title: "Argus",
            content: "result",
          },
        ],
      }),
    );
    const adapter = createAdapterFactory(config, {
      trustedService: { request },
    })({
      id: "search",
      source: "web",
      watchId: "watch",
      schedule: "* * * * *",
      kind: "query",
      value: "argus",
      keywords: [],
    });
    await expect(
      adapter.validate({ kind: "query", value: "argus" }),
    ).resolves.toEqual({ valid: true, errors: [] });
    const pull = adapter
      .pull({
        targetId: "search",
        config: { kind: "query", value: "argus" },
      })
      [Symbol.asyncIterator]();
    await expect(pull.next()).resolves.toMatchObject({
      value: { url: "https://example.com/argus" },
    });
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "http://searxng:8080/search?q=argus&format=json",
    );
  });

  it("advances a chronological Telegram checkpoint to the newest item", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { telegram: { enabled: true } },
      watches: [],
    });
    const target: ScheduledTarget = {
      id: "release:telegram:channel:argus",
      source: "telegram",
      watchId: "release",
      schedule: "* * * * *",
      kind: "channel",
      value: "argus",
      keywords: [],
    };
    const items: SourceItem[] = ["41", "42"].map((id) => ({
      externalId: id,
      url: `https://t.me/argus/${id}`,
      text: `Message ${id}`,
      raw: {},
    }));
    await runTarget(target, config, repository, {
      kind: "telegram",
      capabilities: { polling: true, backfill: true, realtime: false },
      validate: async () => ({ valid: true, errors: [] }),
      pull: async function* () {
        yield* items;
      },
    });
    expect(
      await repository.getCheckpoint<{ lastId: string }>(target.id),
    ).toMatchObject({ lastId: "42" });
  });

  it("starts independent reply tracking for newly observed top-level X posts", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {
        x: {
          enabled: true,
          replies: {
            enabled: true,
            maxPerPost: 50,
            maxTrackingHours: 168,
            orderBy: "likes",
          },
        },
      },
      watches: [],
    });
    const target: ScheduledTarget = {
      id: "movies:x:account:FilmUpdates",
      source: "x",
      watchId: "movies",
      schedule: "* * * * *",
      kind: "account",
      value: "FilmUpdates",
      keywords: [],
    };
    await runTarget(target, config, repository, {
      kind: "x",
      capabilities: { polling: true, backfill: true, realtime: false },
      validate: async () => ({ valid: true, errors: [] }),
      pull: async function* () {
        yield {
          externalId: "1900",
          url: "https://x.com/FilmUpdates/status/1900",
          text: "A new trailer",
          publishedAt: "2026-08-29T00:00:00.000Z",
          raw: {},
        };
        yield {
          externalId: "1901",
          url: "https://x.com/someone/status/1901",
          text: "a reply",
          relations: [
            {
              kind: "reply_to",
              objectSource: "x",
              objectExternalId: "1900",
            },
          ],
          raw: {},
        };
      },
    });

    const tracking = await repository.getConversationTracking(
      recordIdentity("x", "1900"),
    );
    expect(tracking).toMatchObject({
      watchId: "movies",
      orderBy: "likes",
      maxPerPost: 50,
      maxTrackingHours: 168,
      publishedAt: "2026-08-29T00:00:00.000Z",
      status: "active",
    });
    expect(
      await repository.getConversationTracking(recordIdentity("x", "1901")),
    ).toBeUndefined();
  });

  it("keeps root X ingestion successful when reply tracking initialization fails", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { x: { enabled: true, replies: { enabled: true } } },
      watches: [],
    });
    const target: ScheduledTarget = {
      id: "movies:x:account:FilmUpdates",
      source: "x",
      watchId: "movies",
      schedule: "* * * * *",
      kind: "account",
      value: "FilmUpdates",
      keywords: [],
    };
    const isolatedRepository = new Proxy(repository, {
      get(targetRepository, property, receiver) {
        if (property === "upsertConversationTracking") {
          return async () => {
            throw new Error("tracking unavailable");
          };
        }
        const value = Reflect.get(targetRepository, property, receiver);
        return typeof value === "function"
          ? value.bind(targetRepository)
          : value;
      },
    });

    await expect(
      runTarget(target, config, isolatedRepository, {
        kind: "x",
        capabilities: { polling: true, backfill: true, realtime: false },
        validate: async () => ({ valid: true, errors: [] }),
        pull: async function* () {
          yield {
            externalId: "root",
            url: "https://x.com/FilmUpdates/status/root",
            text: "Trailer",
            raw: {},
          };
        },
      }),
    ).resolves.toMatchObject({ inserted: 1, replyTrackingFailed: 1 });
    expect(await repository.getRecord(recordIdentity("x", "root"))).toBeDefined();
  });

  it("queues one terminal snapshot for an old first discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({ version: 2, storage: { adapter: "sqlite", url: ":memory:" }, sources: { x: { enabled: true, replies: { enabled: true, maxTrackingHours: 24 } } }, watches: [] });
    const target: ScheduledTarget = { id: "movies:x:account:FilmUpdates", source: "x", watchId: "movies", schedule: "* * * * *", kind: "account", value: "FilmUpdates", keywords: [] };
    await runTarget(target, config, repository, { kind: "x", capabilities: { polling: true, backfill: true, realtime: false }, validate: async () => ({ valid: true, errors: [] }), pull: async function* () { yield { externalId: "old", url: "https://x.com/FilmUpdates/status/old", text: "Old", publishedAt: "2026-08-27T00:00:00.000Z", raw: {} }; } });
    expect(await repository.getConversationTracking(recordIdentity("x", "old"))).toMatchObject({ status: "active", nextRunAt: "2026-08-29T12:00:00.000Z", stopsAt: "2026-08-29T12:00:00.000Z" });
  });

  it("reactivates a completed root for 24 hours when reply count grows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const rootRecordId = recordIdentity("x", "reactivate");
    await repository.upsertRecord({ id: rootRecordId, source: "x", externalId: "reactivate", targetId: "movies:x:account:FilmUpdates", watchIds: ["movies"], url: "https://x.com/FilmUpdates/status/reactivate", text: "Post", raw: {}, contentHash: "a".repeat(64), firstSeenAt: "2026-08-27T00:00:00.000Z", lastSeenAt: "2026-08-27T00:00:00.000Z" });
    await repository.upsertConversationTracking({ rootRecordId, watchId: "movies", status: "complete", orderBy: "likes", maxPerPost: 50, maxTrackingHours: 24, publishedAt: "2026-08-27T00:00:00.000Z", stopsAt: "2026-08-28T00:00:00.000Z", lastObservedReplies: 10, updatedAt: "2026-08-28T00:00:00.000Z" });
    const config = validateConfig({ version: 2, storage: { adapter: "sqlite", url: ":memory:" }, sources: { x: { enabled: true, replies: { enabled: true, maxTrackingHours: 24 } } }, watches: [] });
    const target: ScheduledTarget = { id: "movies:x:account:FilmUpdates", source: "x", watchId: "movies", schedule: "* * * * *", kind: "account", value: "FilmUpdates", keywords: [] };
    await runTarget(target, config, repository, { kind: "x", capabilities: { polling: true, backfill: true, realtime: false }, validate: async () => ({ valid: true, errors: [] }), pull: async function* () { yield { externalId: "reactivate", url: "https://x.com/FilmUpdates/status/reactivate", text: "Post", publishedAt: "2026-08-27T00:00:00.000Z", engagement: { replies: 11 }, raw: {} }; } });
    expect(await repository.getConversationTracking(rootRecordId)).toMatchObject({ status: "active", nextRunAt: "2026-08-29T12:00:00.000Z", stopsAt: "2026-08-30T12:00:00.000Z", lastObservedReplies: 10 });
  });

  it("does not commit a diagnostic target cancelled while its adapter is in flight", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({ version: 2, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [] });
    let active = true;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const running = runTarget({ id: "__argus_doctor:test", source: "web", watchId: "__argus_doctor:test", schedule: "* * * * *", kind: "url", value: "https://example.com", keywords: [] }, config, repository, { kind: "web", capabilities: { polling: true, backfill: true, realtime: false }, validate: async () => ({ valid: true, errors: [] }), pull: async function* () { await barrier; yield { externalId: "one", url: "https://example.com", text: "diagnostic", raw: {} }; } }, async () => active);
    active = false;
    release();
    expect(await running).toEqual({ inserted: 0, revised: 0, duplicates: 0 });
    expect((await repository.queryRecords({ targetIds: ["__argus_doctor:test"] })).items).toEqual([]);
  });

  it.each([
    ["telegram", "channel", "argus-announcements"],
    ["x", "account", "argus"],
    ["x", "query", "argus release"],
  ] as const)("resolves a persisted %s diagnostic snapshot", async (source, kind, value) => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const now = new Date().toISOString();
    await repository.createDiagnosticWatch({ id: `${source}-${kind}`, targetId: `__argus_doctor:${source}-${kind}`, source, target: { kind, value, watchId: "diagnostic", keywords: [] }, status: "active", createdAt: now, updatedAt: now, job: { id: `job-${source}-${kind}`, targetId: `__argus_doctor:${source}-${kind}`, source, status: "queued", attempt: 0, runAt: now } });
    expect(await findDiagnosticTarget(repository, `__argus_doctor:${source}-${kind}`)).toMatchObject({ source, kind, value, watchId: "diagnostic" });
  });

  it("rejects a corrupted diagnostic snapshot without exposing its token field", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const now = new Date().toISOString();
    await repository.createDiagnosticWatch({ id: "bad", targetId: "__argus_doctor:bad", source: "telegram", target: { kind: "channel", value: "public", watchId: "diagnostic", token: "secret" }, status: "active", createdAt: now, updatedAt: now, job: { id: "bad-job", targetId: "__argus_doctor:bad", source: "telegram", status: "queued", attempt: 0, runAt: now } });
    expect(await findDiagnosticTarget(repository, "__argus_doctor:bad")).toBeUndefined();
  });
});
