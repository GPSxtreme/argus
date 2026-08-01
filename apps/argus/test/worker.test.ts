import { validateConfig } from "@argus/config";
import type { SourceItem } from "@argus/contracts";
import type { ScheduledTarget } from "@argus/scheduler";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { findDiagnosticTarget, runTarget } from "../src/worker.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("target worker", () => {
  it("advances a chronological Telegram checkpoint to the newest item", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({
      version: 1,
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

  it("does not commit a diagnostic target cancelled while its adapter is in flight", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({ version: 1, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [] });
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
